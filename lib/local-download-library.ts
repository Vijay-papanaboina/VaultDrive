"use client";

import { createMD5, createSHA256 } from "hash-wasm";
import {
  isEncryptedDownloadPair, type EncryptedDownloadPair, type LocalDownload, type LocalDownloadPart,
  type LocalDownloadStatus,
} from "./local-download-types";

const DIRECTORY = ".vaultdrive-downloads";
const MANIFEST = "entry.json";
const ID = /^[a-f0-9]{64}$/;
const LOCK_PREFIX = "vaultdrive:encrypted-download:";
const FILES = { meta: "original.meta", payload: "payload.age" } as const;
const PERMISSION = { mode: "readwrite" } as const;
const EMAIL_KEY = "vaultdrive.local-unlock-email.v1";

type BrowserDirectory = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemHandle>;
  queryPermission(options: typeof PERMISSION): Promise<PermissionState>;
  requestPermission(options: typeof PERMISSION): Promise<PermissionState>;
};
type DirectoryPicker = (options: typeof PERMISSION & {
  id: string; startIn: "downloads" | FileSystemDirectoryHandle;
}) => Promise<FileSystemDirectoryHandle>;

export function pickEncryptedDirectory(previous?: FileSystemDirectoryHandle) {
  const picker = (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (!picker) {
    throw new Error("Encrypted downloads need a browser with folder access, such as Chrome or Edge.");
  }
  return picker.call(window, { ...PERMISSION, id: "vaultdrive-encrypted", startIn: previous ?? "downloads" });
}

function directorySetting<T>(operation: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error("Browser storage is unavailable.")); return; }
    const open = indexedDB.open("vaultdrive-local-library", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("settings");
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error("Close other VaultDrive tabs and retry saving the folder."));
    open.onsuccess = () => {
      const db = open.result;
      try {
        const transaction = db.transaction("settings", mode);
        const request = operation(transaction.objectStore("settings"));
        transaction.oncomplete = () => { db.close(); resolve(request.result); };
        transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error("Could not remember the folder.")); };
      } catch (error) {
        db.close();
        reject(error);
      }
    };
  });
}

export async function savedEncryptedDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const handle: unknown = await directorySetting((store) => store.get("directory"), "readonly");
  if (handle && typeof handle === "object" && "kind" in handle && handle.kind === "directory" &&
    "getDirectoryHandle" in handle && typeof handle.getDirectoryHandle === "function") {
    return handle as FileSystemDirectoryHandle;
  }
  return null;
}

export async function rememberEncryptedDirectory(handle: FileSystemDirectoryHandle) {
  await directorySetting((store) => store.put(handle, "directory"), "readwrite");
}

export function readLocalUnlockEmail(): string | null {
  try { return localStorage.getItem(EMAIL_KEY); } catch { return null; }
}

export function rememberLocalUnlockEmail(email: string) {
  try { localStorage.setItem(EMAIL_KEY, email); } catch { /* The unlocked session still works. */ }
}

export function localDownloadMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Allow access to the download folder in Settings and try again.";
    }
    if (error.name === "QuotaExceededError") return "There is not enough disk space to save the encrypted download.";
    if (error.name === "NotFoundError") return "The download folder or file is missing. Check the disk and rescan.";
    if (error.name === "NoModificationAllowedError") return "The file is in use or read-only. Close other writers and retry.";
  }
  return error instanceof Error ? error.message : "Local download failed.";
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function localDownloadId(pair: EncryptedDownloadPair): Promise<string> {
  if (!isEncryptedDownloadPair(pair)) throw new Error("Invalid encrypted Drive file version.");
  // Stable, shared with the playback helper and earlier local libraries.
  const versions = [pair.meta, pair.payload].map(({ id, revision, size, checksum }) => ({ id, revision, size, checksum }));
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(versions)))));
}

type Manifest = Omit<LocalDownload, "id" | "metaBytes" | "payloadBytes"> & { version: 1 };

function notFound(error: unknown) { return error instanceof DOMException && error.name === "NotFoundError"; }

async function readOptional(dir: FileSystemDirectoryHandle, name: string) {
  try {
    const handle = await dir.getFileHandle(name);
    return { name, handle, file: await handle.getFile() };
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

async function partFile(dir: FileSystemDirectoryHandle, part: LocalDownloadPart) {
  return (await readOptional(dir, FILES[part])) ?? readOptional(dir, `${FILES[part]}.part`);
}

async function writeText(dir: FileSystemDirectoryHandle, name: string, text: string) {
  const file = await dir.getFileHandle(name, { create: true });
  const writer = await file.createWritable();
  try {
    await writer.write(text);
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
}

async function loadManifest(dir: FileSystemDirectoryHandle, id: string): Promise<Manifest> {
  const stored = await readOptional(dir, MANIFEST);
  if (!stored || stored.file.size > 8192) throw new Error("Local download manifest is missing or invalid.");
  const data: unknown = JSON.parse(await stored.file.text());
  const record = data as Manifest | null;
  if (!record || record.version !== 1 || !isEncryptedDownloadPair(record.pair) ||
    !Number.isSafeInteger(record.addedAt) || record.addedAt < 0 || record.addedAt > 8_640_000_000_000_000 ||
    !["downloading", "paused", "failed", "complete"].includes(record.status) ||
    typeof record.remoteDeleted !== "boolean" || (record.error !== null && typeof record.error !== "string") ||
    await localDownloadId(record.pair) !== id) {
    throw new Error("Local download manifest is invalid.");
  }
  return record;
}

async function inspect(id: string, dir: FileSystemDirectoryHandle, manifest: Manifest, active = false): Promise<LocalDownload> {
  const [meta, payload] = await Promise.all([partFile(dir, "meta"), partFile(dir, "payload")]);
  const record = {
    pair: manifest.pair, addedAt: manifest.addedAt, status: manifest.status,
    error: manifest.error, remoteDeleted: manifest.remoteDeleted,
  };
  const metaBytes = meta?.file.size ?? 0;
  const payloadBytes = payload?.file.size ?? 0;
  if (record.status === "complete" && (meta?.name !== FILES.meta || payload?.name !== FILES.payload ||
    metaBytes !== record.pair.meta.size || payloadBytes !== record.pair.payload.size)) {
    record.status = "failed";
    record.error = "Saved files are missing or changed. Resume to repair.";
  } else if (record.status === "downloading" && !active) {
    record.status = "paused";
    record.error = "Transfer interrupted. Resume to continue.";
  }
  return { ...record, id, metaBytes, payloadBytes };
}

async function checksumMatches(file: File, checksum: string) {
  const hash = await (checksum.length === 64 ? createSHA256() : createMD5());
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
    return hash.digest("hex") === checksum;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class LocalDownloadLibrary {
  readonly directory: FileSystemDirectoryHandle;
  constructor(directory: FileSystemDirectoryHandle) { this.directory = directory; }

  queryAccess() {
    return (this.directory as BrowserDirectory).queryPermission(PERMISSION);
  }

  requestAccess() {
    return (this.directory as BrowserDirectory).requestPermission(PERMISSION);
  }

  private root(create = false) {
    return this.directory.getDirectoryHandle(DIRECTORY, { create });
  }

  private async entryDir(id: string, create = false) {
    if (!ID.test(id)) throw new Error("Invalid local download ID.");
    return (await this.root(create)).getDirectoryHandle(id, { create });
  }

  async exclusive<T>(id: string, action: () => Promise<T>, wait = false): Promise<T> {
    if (!globalThis.navigator?.locks) return action();
    return navigator.locks.request(`${LOCK_PREFIX}${id}`, { ifAvailable: !wait }, (lock) => {
      if (!lock) throw new Error("This encrypted download is in use in another tab.");
      return action();
    });
  }

  async list(): Promise<LocalDownload[]> {
    let root: FileSystemDirectoryHandle;
    try { root = await this.root(); }
    catch (error) { if (notFound(error)) return []; throw error; }
    const entries: LocalDownload[] = [];
    for await (const handle of (root as BrowserDirectory).values()) {
      if (handle.kind !== "directory" || !ID.test(handle.name)) continue;
      const dir = handle as FileSystemDirectoryHandle;
      try {
        entries.push(await inspect(handle.name, dir, await loadManifest(dir, handle.name)));
      } catch (error) {
        // An unrelated or damaged directory is not a catalog entry.
        if (error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name)) throw error;
      }
    }
    return entries;
  }

  async begin(id: string, pair: EncryptedDownloadPair, resume: boolean) {
    const dir = await this.entryDir(id, !resume);
    const record: Manifest = (await readOptional(dir, MANIFEST)) ? await loadManifest(dir, id) : {
      version: 1, pair, addedAt: Date.now(), status: "paused", error: null, remoteDeleted: false,
    };
    if (record.status === "complete") {
      const existing = await inspect(id, dir, record);
      if (existing.status === "complete") return existing;
    }
    for (const part of ["meta", "payload"] as const) {
      const stored = await partFile(dir, part);
      if (stored && stored.file.size > pair[part].size) {
        await dir.removeEntry(stored.name);
      }
    }
    record.status = "downloading";
    record.remoteDeleted = false;
    record.error = null;
    await writeText(dir, MANIFEST, JSON.stringify(record));
    return inspect(id, dir, record, true);
  }

  async savePart(
    id: string, part: LocalDownloadPart, offset: number,
    transfer: (write: (bytes: Uint8Array<ArrayBuffer>, position: number) => Promise<number>) => Promise<void>,
  ) {
    const dir = await this.entryDir(id);
    const stored = await partFile(dir, part);
    if ((stored?.file.size ?? 0) !== offset) throw new Error("The saved encrypted offset changed. Rescan and resume.");
    const native = stored?.name === FILES[part];
    const handle = native ? stored.handle : await dir.getFileHandle(FILES[part], { create: true });
    const writer = await handle.createWritable({ keepExistingData: native && offset > 0 }).catch(async (error) => {
      if (stored && !native) await dir.removeEntry(FILES[part]).catch(() => undefined);
      throw error;
    });
    try {
      // Only old helper downloads have .part files. Copy their committed prefix once.
      if (!native && offset && stored) await stored.file.stream().pipeTo(writer, { preventClose: true });
      if (offset) await writer.seek(offset);
    } catch (error) {
      await writer.abort().catch(() => undefined);
      // A newly created empty final file should not hide a recoverable legacy checkpoint.
      if (stored && !native) await dir.removeEntry(FILES[part]).catch(() => undefined);
      throw error;
    }
    let cursor = offset;
    const commit = async () => {
      try { await writer.close(); }
      catch (error) {
        await writer.abort().catch(() => undefined);
        if (stored && !native) await dir.removeEntry(FILES[part]).catch(() => undefined);
        throw error;
      }
      if (stored && !native) await dir.removeEntry(stored.name).catch(() => undefined);
    };
    try {
      await transfer(async (bytes, position) => {
        if (position !== cursor) throw new Error("Invalid encrypted write offset.");
        await writer.write(bytes);
        cursor += bytes.byteLength;
        return cursor;
      });
    } catch (error) {
      // Native writes become visible at close. Preserve the committed prefix on Pause or network failure.
      await commit();
      throw error;
    }
    await commit();
  }

  async setStatus(id: string, status: LocalDownloadStatus, error: string | null) {
    const dir = await this.entryDir(id);
    const record = await loadManifest(dir, id);
    record.status = status;
    record.error = error?.slice(0, 500) ?? null;
    await writeText(dir, MANIFEST, JSON.stringify(record));
    return inspect(id, dir, record);
  }

  async finish(entry: LocalDownload) {
    const dir = await this.entryDir(entry.id);
    for (const part of ["meta", "payload"] as const) {
      const expected = entry.pair[part];
      const stored = await partFile(dir, part);
      if (!stored || stored.file.size !== expected.size) throw new Error("The encrypted download is incomplete.");
      if (!(await checksumMatches(stored.file, expected.checksum))) {
        await dir.removeEntry(stored.name);
        throw new Error("The Drive checksum did not match. Resume to replace the damaged part.");
      }
      if (stored.name !== FILES[part]) await this.savePart(entry.id, part, stored.file.size, async () => {});
    }
    return this.setStatus(entry.id, "complete", null);
  }

  async meta(entry: LocalDownload, signal: AbortSignal) {
    signal.throwIfAborted();
    const stored = await partFile(await this.entryDir(entry.id), "meta");
    if (!stored || stored.file.size !== entry.pair.meta.size) throw new Error("Saved metadata is missing or incomplete.");
    const bytes = new Uint8Array(await stored.file.arrayBuffer());
    signal.throwIfAborted();
    return bytes;
  }

  async prefix(entry: LocalDownload, signal: AbortSignal) {
    signal.throwIfAborted();
    const stored = await readOptional(await this.entryDir(entry.id), FILES.payload);
    if (!stored || stored.file.size !== entry.pair.payload.size) throw new Error("The saved payload size changed.");
    const bytes = new Uint8Array(await stored.file.slice(0, 128 * 1024 + 64).arrayBuffer());
    signal.throwIfAborted();
    return bytes;
  }

  async remove(id: string) {
    await this.exclusive(id, async () => {
      const dir = await this.entryDir(id);
      await loadManifest(dir, id); // Do not delete anything the library did not create.
      for (const name of [FILES.meta, FILES.payload, `${FILES.meta}.part`, `${FILES.payload}.part`, MANIFEST]) {
        try { await dir.removeEntry(name); }
        catch (error) { if (!notFound(error)) throw error; }
      }
      await (await this.root()).removeEntry(id).catch((error: unknown) => {
        if (!(error instanceof DOMException && ["InvalidModificationError", "NotFoundError"].includes(error.name))) throw error;
      });
    });
  }

  async markRemoteDeleted(ids: string[]) {
    const deleted = new Set(ids);
    for (const entry of await this.list()) {
      if (entry.remoteDeleted || !deleted.has(entry.pair.meta.id)) continue;
      await this.exclusive(entry.id, async () => {
        const dir = await this.entryDir(entry.id);
        const record = await loadManifest(dir, entry.id);
        record.remoteDeleted = true;
        await writeText(dir, MANIFEST, JSON.stringify(record));
      }, true);
    }
  }

  async folderKey(): Promise<string> {
    return this.exclusive("folder-key", async () => {
      const dir = await this.root();
      const saved = await readOptional(dir, ".folder-id");
      if (saved) {
        const key = saved.file.size === 64 ? await saved.file.text() : "";
        if (!ID.test(key)) throw new Error("The VLC folder marker is invalid.");
        return key;
      }
      const key = hex(crypto.getRandomValues(new Uint8Array(32)));
      await writeText(dir, ".folder-id", key);
      return key;
    }, true);
  }
}
