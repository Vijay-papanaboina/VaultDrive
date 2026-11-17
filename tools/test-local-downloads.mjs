import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { registerHooks } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";

// Load the actual Web transport and crypto code without a test-only Next server or npm dependency.
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith(".ts")) {
      if (specifier.startsWith("@/")) return next(new URL(`${specifier.slice(2)}.ts`, import.meta.url.replace(/tools\/[^/]+$/, "")), context);
      if (specifier.startsWith("./")) return next(new URL(`${specifier}.ts`, context.parentURL), context);
    }
    return next(specifier, context);
  },
});

const { LocalDownloadBridge, randomLocalId } = await import("../lib/local-download-bridge.ts");
const { LocalDownloadLibrary } = await import("../lib/local-download-library.ts");
const { copyEncryptedPart, transferEncryptedDownload } = await import("../lib/encrypted-download.ts");
const { createDirectPayloadSource, createEncryptedPayloadSource } = await import("../lib/direct-payload-source.ts");
const { deriveAgeIdentity, encryptMetaZip } = await import("../lib/crypto.ts");
const { decryptLocalMetadata } = await import("../lib/local-library-metadata.ts");
const { createResumablePayloadContext, createResumableEncryptedPayloadStream, encryptedPayloadSize } = await import("../lib/resumable-payload.ts");

const binary = resolve(process.env.VAULTDRIVE_TEST_BRIDGE ?? "vlc-bridge/target/release/vaultdrive-vlc");
const origin = "https://vaultdrive.test";
const helperUrl = "http://127.0.0.1:47653";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const fixtureToken = "synthetic-drive-token";
const firstChunk = 4 * 1024 * 1024;
const videoNames = ["Episode 01 Ø.mp4", "Episode 02 & café : part.mp4", "Episode 03 +%?.mp4", "Episode 04.mp4"];

// Exercise the browser library against real files, with native writable swap/close semantics.
function folderHandle(path) {
  const translate = (error) => {
    if (error.code === "ENOENT") throw new DOMException("Not found", "NotFoundError");
    if (error.code === "ENOTEMPTY") throw new DOMException("Directory is not empty", "InvalidModificationError");
    throw error;
  };
  return {
    kind: "directory",
    name: basename(path),
    async getDirectoryHandle(name, { create = false } = {}) {
      const folder = join(path, name);
      if (create) await mkdir(folder, { recursive: true });
      if (!(await stat(folder).catch(translate)).isDirectory()) throw new DOMException("Not a directory", "TypeMismatchError");
      return folderHandle(folder);
    },
    async *values() {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        yield entry.isDirectory() ? folderHandle(join(path, entry.name)) : { name: entry.name, kind: "file" };
      }
    },
    async getFileHandle(name, { create = false } = {}) {
      const filename = join(path, name);
      if (create) {
        const handle = await open(filename, "a");
        await handle.close();
      }
      await stat(filename).catch(translate);
      return {
        async getFile() { return new File([await readFile(filename).catch(translate)], name); },
        async createWritable({ keepExistingData = false } = {}) {
          const swap = `${filename}.test-${randomLocalId()}`;
          if (keepExistingData) await copyFile(filename, swap);
          else await writeFile(swap, "");
          const handle = await open(swap, "r+");
          let cursor = 0;
          const write = async (value) => {
            const buffer = Buffer.from(value);
            let written = 0;
            while (written < buffer.length) {
              const result = await handle.write(buffer, written, buffer.length - written, cursor + written);
              written += result.bytesWritten;
            }
            cursor += written;
          };
          const close = async () => { await handle.close(); await rename(swap, filename); };
          const abort = async () => { await handle.close(); await rm(swap, { force: true }); };
          return Object.assign(new WritableStream({ write, close, abort }), {
            write, close, abort, async seek(position) { cursor = position; },
          });
        },
      };
    },
    async removeEntry(name) {
      const entry = join(path, name);
      if ((await stat(entry).catch(translate)).isDirectory()) {
        await rmdir(entry).catch(translate);
      } else await rm(entry).catch(translate);
    },
  };
}

function driveFixture() {
  const pairs = new Map();
  const calls = [];
  return {
    calls,
    add(metaId, version, meta, payload, modifiedTime = "2026-10-29T12:34:00Z") {
      const manifest = {
        meta: { id: metaId, revision: version, size: meta.length, checksum: sha256(meta) },
        payload: { id: `${metaId}_payload`, revision: version, size: payload.length, checksum: sha256(payload) },
        modifiedTime,
      };
      const pair = { manifest, meta, payload };
      pairs.set(metaId, pair);
      return pair;
    },
    async fetch(input, init) {
      const url = new URL(input, origin);
      const headers = new Headers(init.headers);
      const id = url.pathname.split("/").at(-1);
      calls.push({ host: url.host, id, range: headers.get("Range") });
      if (url.origin === origin) {
        const pair = pairs.get(id);
        if (!pair) return new Response(null, { status: 404 });
        const file = pair.manifest.payload;
        return Response.json({
          downloadUri: `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
          partialDownloadAllowed: true, payloadFileId: file.id, encryptedSize: file.size,
          scope: "https://www.googleapis.com/auth/drive.readonly", accessToken: fixtureToken, expiresAt: Date.now() + 60 * 60_000,
          ...(url.searchParams.get("offline") ? { offline: pair.manifest } : {}),
        });
      }
      assert.equal(url.host, "www.googleapis.com");
      assert.equal(headers.get("Authorization"), `Bearer ${fixtureToken}`);
      const bytes = id.endsWith("_payload") ? pairs.get(id.slice(0, -8)).payload : pairs.get(id).meta;
      const range = headers.get("Range");
      const [from, to] = range ? range.replace("bytes=", "").split("-") : ["0", ""];
      const end = to ? Math.min(Number(to) + 1, bytes.length) : bytes.length;
      let position = Number(from);
      const stream = new ReadableStream({
        pull(controller) {
          init.signal?.throwIfAborted();
          if (position >= end) return controller.close();
          const next = Math.min(end, position + 121_901);
          controller.enqueue(new Uint8Array(bytes.subarray(position, next)));
          position = next;
        },
      });
      // Drive CORS does not necessarily expose Content-Range.
      return new Response(stream, { status: range ? 206 : 200, headers: { "Content-Length": String(end - position) } });
    },
  };
}

test("stream checkpoint rejects extra or missing bytes without manufacturing progress", async () => {
  const write = async (bytes, offset) => offset + bytes.length;
  const signal = new AbortController().signal;
  await assert.rejects(copyEncryptedPart(new Response(new Uint8Array(2)), 7, 8, write, signal), /extra encrypted bytes/);
  await assert.rejects(copyEncryptedPart(new Response(new Uint8Array(2)), 7, 10, write, signal), /before all encrypted bytes/);
  await copyEncryptedPart(new Response(new Uint8Array([0, 255])), 7, 9, async (bytes, offset) => {
    assert.deepEqual(Array.from(bytes), [0, 255]);
    assert.equal(offset, 7);
    return 9;
  }, signal);
});

test("normal direct download remains separate from version-pinned ciphertext transfer", async () => {
  const drive = driveFixture();
  drive.add("meta_A", "r1", new Uint8Array([4, 5, 6]), new Uint8Array([8, 9, 10]));
  const source = createDirectPayloadSource("meta_A", { fetchImpl: drive.fetch });
  try {
    assert.deepEqual(Array.from(new Uint8Array(await (await source.fetch()).arrayBuffer())), [8, 9, 10]);
    assert.deepEqual(Array.from(new Uint8Array(await (await source.fetch({ start: 1, end: 2 })).arrayBuffer())), [9, 10]);
  } finally { source.close(); }
  const encrypted = createEncryptedPayloadSource("meta_A", { fetchImpl: drive.fetch });
  try {
    assert.equal((await encrypted.pair()).meta.revision, "r1");
    assert.deepEqual(Array.from(new Uint8Array(await (await encrypted.fetchPart("meta", 1)).arrayBuffer())), [5, 6]);
    assert.deepEqual(Array.from(new Uint8Array(await (await encrypted.fetchPart("payload", 1)).arrayBuffer())), [9, 10]);
  } finally { encrypted.close(); }
});

test("VLC Play sends one sealed request with the folder hint and ordered playlist", async () => {
  const calls = [];
  const playbackId = randomLocalId();
  const code = "19".repeat(32);
  const client = new LocalDownloadBridge(code, async (url, init) => {
    calls.push({ url, init });
    return Response.json({ count: 2, playbackId, directory: "/local/VaultDrive" });
  }, origin);
  const location = { folderKey: "73".repeat(32), folderName: "VaultDrive" };
  assert.deepEqual(await client.play("disposable-identity", ["episode_1", "episode_2"], "episode_2", playbackId, location),
    { count: 2, directory: "/local/VaultDrive" });
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, `${helperUrl}/v1/play`);
  assert.equal(init.method, "POST");
  assert.doesNotMatch(init.body, /disposable-identity|episode_2|VaultDrive/);
  const envelope = JSON.parse(init.body);
  const keyBytes = Buffer.from(code, "hex");
  const authKey = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const aesKey = await crypto.subtle.importKey("raw",
    await crypto.subtle.sign("HMAC", authKey, new TextEncoder().encode("VaultDrive VLC control v2")), "AES-GCM", false, ["decrypt"]);
  const clear = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({
    name: "AES-GCM", iv: Buffer.from(envelope.nonce, "hex"),
    additionalData: new TextEncoder().encode(`${origin}\nPOST\n/v1/play`),
  }, aesKey, Buffer.from(envelope.ciphertext, "hex"))));
  assert.deepEqual(clear.data, { identity: "disposable-identity", ids: ["episode_1", "episode_2"], selected: "episode_2", playbackId, ...location });
});

async function until(operation, description, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await operation();
    if (result) return result;
    await wait(50);
  }
  throw new Error(description);
}

async function packCli(input, output, password, email) {
  const child = spawn(process.execPath, ["tools/vaultdrive-cli.mjs", "-i", input, "-o", output, "-s", "7", "-e", email], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let seen = "";
  let sent = 0;
  child.stdout.on("data", (chunk) => {
    seen += chunk;
    const prompts = ["Enter encryption passphrase:", "Confirm encryption passphrase:"];
    if (sent < 2 && seen.includes(prompts[sent])) {
      sent += 1;
      child.stdin.write(`${password}\n`);
      if (sent === 2) child.stdin.end();
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [status] = await once(child, "exit");
  assert.equal(status, 0, stderr);
  assert.match(seen, /Processing finished/);
}

async function browserPair(identity, name, video, thumbnail) {
  const file = new File([video], name, { type: "video/mp4" });
  const context = await createResumablePayloadContext(identity);
  const payload = Buffer.from(await new Response(createResumableEncryptedPayloadStream(file, name, context)).arrayBuffer());
  assert.equal(payload.length, encryptedPayloadSize(file, name, context));
  const meta = Buffer.from(await encryptMetaZip(identity, {
    details: { name: `Edited card: ${name}`, description: "Generated by the browser uploader", date: "2023-01-19", extra: { size_bytes: video.length, mime_type: "video/mp4" } },
    thumbnailBytes: thumbnail, thumbnailFilename: "thumbnail.webp",
  }));
  return { meta, payload };
}

function hostProbe(host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${helperUrl}/v1/challenge`, { headers: { Host: host, Origin: origin } },
      (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.end();
  });
}

test("browser-owned encrypted library without a helper, localhost security, and real VLC", {
  timeout: 120_000,
  skip: !existsSync(binary) && "build the Rust helper or set VAULTDRIVE_TEST_BRIDGE",
}, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "vaultdrive-offline-test-"));
  const downloadDir = join(tmp, "downloads");
  const inputDir = join(tmp, "originals");
  const outputDir = join(tmp, "cli");
  const rcPath = join(tmp, "rc");
  const vlcWrapper = join(tmp, "test-vlc");
  let helper;
  let rc;
  const stopHelper = async () => {
    if (!helper || helper.exitCode !== null || helper.signalCode !== null) return;
    const done = once(helper, "exit");
    helper.kill("SIGTERM");
    await done;
  };
  t.after(async () => { rc?.destroy(); await stopHelper(); await rm(tmp, { force: true, recursive: true }); });
  await mkdir(inputDir);
  await mkdir(downloadDir);
  await mkdir(join(tmp, "config"));
  // Keep native VLC's actual playlist engine while avoiding a desktop window and audio output.
  await writeFile(vlcWrapper, [
    "#!/bin/sh",
    'exec vlc --vout=dummy --aout=dummy --avcodec-hw=none --control=oldrc --rc-fake-tty --rc-unix="$VAULTDRIVE_TEST_SOCKET" "$@" --extraintf=luaintf',
  ].join("\n"), { mode: 0o700 });
  const env = {
    ...process.env, XDG_CONFIG_HOME: join(tmp, "config"), XDG_DATA_HOME: join(tmp, "user-data"),
    VAULTDRIVE_VLC: vlcWrapper, VAULTDRIVE_TEST_SOCKET: rcPath, LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
  };
  let library = new LocalDownloadLibrary(folderHandle(downloadDir));
  const start = async () => {
    helper = spawn(binary, ["serve", origin], { env, cwd: downloadDir, stdio: ["ignore", "pipe", "pipe"] });
    let ready = false;
    let stdout = "";
    let stderr = "";
    helper.stdout.on("data", (chunk) => { stdout += chunk; });
    helper.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.includes("listening")) ready = true; });
    return until(() => {
      if (helper.exitCode !== null || helper.signalCode !== null) throw new Error(`Helper exited at startup: ${stderr.trim()}`);
      return ready && stdout.match(/Pairing code: ([a-f0-9]{64})/)?.[1];
    },
      "Single serve command did not start and print pairing: verify that port 47653 is free");
  };

  const sourceFile = join(inputDir, videoNames[0]);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12",
    "-t", "50", "-c:v", "mpeg4", "-q:v", "7", "-metadata", "title=Embedded title distinct from filename", "-movflags", "+faststart", sourceFile]);
  const video = await readFile(sourceFile);
  // Valid MP4 padding gives a deterministic multi-chunk, multi-record fixture for interruption.
  const padding = Buffer.alloc(firstChunk + 1024);
  padding.writeUInt32BE(padding.length);
  padding.write("free", 4);
  const largeVideo = Buffer.concat([video, padding]);
  const thumbnail = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
  await writeFile(sourceFile, largeVideo);
  await writeFile(sourceFile.replace(/\.mp4$/, ".webp"), thumbnail);
  const password = "vaultdrive disposable offline fixture";
  const email = "offline-fixture@example.test";
  await packCli(inputDir, outputDir, password, email);
  const identity = await deriveAgeIdentity(password, email);
  const drive = driveFixture();
  const expected = [];
  expected.push(drive.add("meta_cli", "cli_rev", await readFile(join(outputDir, "7.meta")), await readFile(join(outputDir, "7"))));
  for (const [index, name] of videoNames.slice(1).entries()) {
    const { meta, payload } = await browserPair(identity, name, video, thumbnail);
    expected.push(drive.add(`meta_browser_${index}`, "browser_rev", meta, payload));
  }

  const callbacks = { entry() {}, progress() {}, verify() {} };
  const transfer = (target, options = {}) => transferEncryptedDownload(target, library,
    options.callbacks ?? callbacks, options.signal ?? new AbortController().signal,
    (id, signal) => createEncryptedPayloadSource(id, { signal, fetchImpl: drive.fetch }));
  const abort = new AbortController();
  await assert.rejects(transfer({ metaFileId: "meta_cli", name: videoNames[0] }, {
    signal: abort.signal, callbacks: { ...callbacks, progress(_entry, part) { if (part === "payload") abort.abort(); } },
  }), { name: "AbortError" });
  const [paused] = await library.list();
  assert.equal(paused.status, "paused");
  assert.equal(paused.payloadBytes, firstChunk);
  assert.equal(helper, undefined, "no helper was running during the transfer");
  library = new LocalDownloadLibrary(folderHandle(downloadDir));
  const [restored] = await library.list();
  assert.deepEqual(restored, paused);
  const signal = new AbortController().signal;
  const partialMeta = await decryptLocalMetadata(restored, await library.meta(restored, signal), identity);
  assert.equal(partialMeta.originalFileName, videoNames[0]);
  assert.deepEqual(Buffer.from(await (await fetch(partialMeta.thumbnailUrl)).arrayBuffer()), thumbnail);
  URL.revokeObjectURL(partialMeta.thumbnailUrl);
  const entries = [await transfer({ metaFileId: "meta_cli", name: videoNames[0], resume: restored })];
  assert.ok(drive.calls.some((call) => call.id === "meta_cli_payload" && call.range?.startsWith(`bytes=${firstChunk}-`)));
  for (const { manifest } of expected.slice(1)) {
    entries.push(await transfer({ metaFileId: manifest.meta.id, name: "Edited name" }));
  }
  for (const [index, entry] of entries.entries()) {
    assert.equal(entry.status, "complete");
    const saved = join(downloadDir, ".vaultdrive-downloads", entry.id);
    assert.deepEqual((await readdir(saved)).sort(), ["entry.json", "original.meta", "payload.age"]);
    assert.deepEqual(await readFile(join(saved, "original.meta")), expected[index].meta);
    assert.deepEqual(await readFile(join(saved, "payload.age")), expected[index].payload);
    const rebuilt = await decryptLocalMetadata(entry, await library.meta(entry, signal), identity, () => library.prefix(entry, signal));
    assert.equal(rebuilt.originalFileName, videoNames[index]);
    assert.equal(rebuilt.details.name, index === 0 ? videoNames[index] : `Edited card: ${videoNames[index]}`);
    assert.equal(rebuilt.details.extra.size_bytes, index === 0 ? largeVideo.length : video.length);
    URL.revokeObjectURL(rebuilt.thumbnailUrl);
  }
  await library.markRemoteDeleted(["meta_cli"]);
  assert.equal((await library.list()).find((entry) => entry.id === entries[0].id).remoteDeleted, true);

  const code = await start();
  let captured;
  let playBody;
  let playCalls = 0;
  const client = new LocalDownloadBridge(code, (url, init) => {
    assert.ok(url.startsWith(helperUrl));
    const headers = new Headers(init.headers);
    headers.set("Origin", origin);
    assert.equal(headers.get("Authorization"), null, "Drive credentials must not reach the helper");
    if (url.endsWith("/v1/play")) {
      captured = { url, init: { ...init, headers, signal: undefined } };
      playBody = String(init.body);
      playCalls += 1;
    }
    return fetch(url, { ...init, headers });
  }, origin);

  assert.equal((await fetch(`${helperUrl}/v1/library`, { headers: { Origin: origin } })).status, 404);
  assert.equal((await fetch(`${helperUrl}/v1/challenge`, { headers: { Origin: origin } })).status, 404);
  const wrongOrigin = await fetch(`${helperUrl}/v1/play`, { method: "POST", headers: { Origin: "https://other.test" } });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(await hostProbe("rebound.test:47653"), 403);
  const preflight = await fetch(`${helperUrl}/v1/play`, { method: "OPTIONS", headers: {
    Origin: origin, "Access-Control-Request-Method": "POST",
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);

  const playbackId = randomLocalId();
  const ids = entries.map((entry) => entry.id);
  const location = { folderName: "downloads", folderKey: await library.folderKey() };
  await assert.rejects(client.play(identity, ids, ids[2], randomLocalId(), { directory: inputDir, folderKey: "not a folder key" }), /folder/i);
  const revoked = randomLocalId();
  await client.stopPlayback(revoked);
  await assert.rejects(client.play(identity, ids, ids[2], revoked, location), /was stopped/);
  const beforePlay = playCalls;
  assert.deepEqual(await client.play(identity, ids, ids[2], playbackId, location), { count: 4, directory: downloadDir });
  assert.equal(playCalls - beforePlay, 1);
  assert.equal((await fetch(captured.url, captured.init)).ok, false, "an authenticated request cannot be replayed");
  assert.ok(playBody);
  assert.equal(playBody.includes(identity), false);
  assert.equal(playBody.includes(code), false);
  assert.equal(playBody.includes(fixtureToken), false);
  assert.equal(playBody.includes(location.folderKey), false);
  assert.equal(playBody.includes(downloadDir), false);
  rc = createConnection(rcPath);
  await once(rc, "connect");
  let output = "";
  rc.on("data", (chunk) => { output += chunk; });
  rc.write("playlist\n");
  const playlist = await until(() => output.includes("End of playlist") && output, "VLC did not report its playlist");
  let before = -1;
  for (const name of videoNames) {
    const index = playlist.indexOf(name);
    assert.ok(index > before && index >= 0, "VLC must display the original names in library order");
    before = index;
  }
  const currentUri = async (entryIndex) => {
    return until(async () => {
      output = "";
      rc.write("status\n");
      await wait(100);
      const uri = output.match(/http:\/\/127\.0\.0\.1:47653\/media\/[a-f0-9]{64}\/\d+/)?.[0];
      return uri?.endsWith(`/${entryIndex}`) && uri;
    }, `VLC did not select playlist item ${entryIndex + 1}`);
  };
  const middle = await currentUri(2);
  rc.write("prev\n");
  const previous = await currentUri(1);
  rc.write("next\n");
  assert.equal(await currentUri(2), middle);
  rc.write("next\n");
  await currentUri(3);
  rc.write("goto 2\n");
  await currentUri(1);
  rc.write("seek 24\n");
  await until(async () => {
    output = "";
    rc.write("get_time\n");
    await wait(100);
    return /(?:^|\r?\n)2[4-9](?:\r?\n)/.test(output);
  }, "VLC did not seek to 24 seconds");
  const videoHeader = await fetch(previous, { method: "HEAD" });
  assert.equal(videoHeader.headers.get("Content-Length"), String(video.length));
  assert.equal(videoHeader.headers.get("Accept-Ranges"), "bytes");
  assert.equal((await fetch(previous, { headers: { Origin: origin } })).status, 404);
  const seek = await fetch(previous, { headers: { Range: "bytes=65500-69000" } });
  assert.equal(seek.status, 206);
  assert.equal(seek.headers.get("Content-Range"), `bytes 65500-69000/${video.length}`);
  assert.deepEqual(Buffer.from(await seek.arrayBuffer()), video.subarray(65500, 69001));
  const suffix = await fetch(previous, { headers: { Range: "bytes=-500" } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), video.subarray(-500));
  assert.equal((await fetch(previous, { headers: { Range: "bytes=0-2,5-8" } })).status, 416);
  rc.write("goto 1\n");
  const cliVideo = await currentUri(0);
  const cliRange = await fetch(cliVideo, { headers: { Range: `bytes=${firstChunk}-${firstChunk + 500}` } });
  assert.equal(cliRange.status, 206);
  assert.deepEqual(Buffer.from(await cliRange.arrayBuffer()), largeVideo.subarray(firstChunk, firstChunk + 501));
  await client.stopPlayback(playbackId);
  assert.equal((await fetch(middle)).status, 404);
  rc.destroy();
  rc = undefined;
  await stopHelper();

  // A damaged saved piece is rejected before it can become a playable library entry.
  const corrupt = drive.add("meta_corrupt", "r1", expected[1].meta, expected[1].payload);
  corrupt.payload = Buffer.from(corrupt.payload);
  corrupt.payload[512] ^= 0xff;
  await assert.rejects(transfer({ metaFileId: "meta_corrupt", name: "Corrupt fixture" }), /checksum did not match/i);
  const failed = (await library.list()).find((entry) => entry.pair.meta.id === "meta_corrupt");
  assert.equal(failed.status, "failed");
  assert.equal(failed.payloadBytes, 0);
  corrupt.payload = expected[1].payload;
  const repaired = await transfer({ metaFileId: "meta_corrupt", name: "Recovered fixture", resume: failed });
  assert.equal(repaired.status, "complete");
  await library.remove(repaired.id);
  assert.ok(!(await library.list()).some((entry) => entry.id === repaired.id));
  assert.equal((await library.list()).length, entries.length);
  const config = await readFile(join(tmp, "config", "vaultdrive-vlc", "config.json"), "utf8");
  assert.equal(config.includes(identity), false);
  for (const { id } of entries) {
    assert.equal((await readFile(join(downloadDir, ".vaultdrive-downloads", id, "entry.json"), "utf8")).includes(identity), false);
  }
});
