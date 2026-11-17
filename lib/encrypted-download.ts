import { createEncryptedPayloadSource, RemoteDownloadMissingError, type EncryptedPayloadSource } from "./direct-payload-source";
import { sameEncryptedDownloadPair, type LocalDownload, type LocalDownloadPart } from "./local-download-types";
import { localDownloadId, localDownloadMessage, type LocalDownloadLibrary } from "./local-download-library";

const CHUNK_BYTES = 4 * 1024 * 1024;

/** Move only raw ciphertext, with backpressure from the last saved checkpoint. */
export async function copyEncryptedPart(
  response: Response,
  offset: number,
  size: number,
  write: (bytes: Uint8Array<ArrayBuffer>, current: number) => Promise<number>,
  signal: AbortSignal,
) {
  if (!response.body || offset < 0 || offset >= size) throw new Error("Invalid encrypted Drive stream.");
  const reader = response.body.getReader();
  const cleanup = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", cleanup, { once: true });
  let committed = offset;
  const buffer = new Uint8Array(Math.min(CHUNK_BYTES, size - offset));
  let used = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (value.length + used > size - committed) throw new Error("Drive returned extra encrypted bytes.");
      for (let cursor = 0; cursor < value.length;) {
        const limit = Math.min(buffer.length, size - committed);
        const count = Math.min(limit - used, value.length - cursor);
        buffer.set(value.subarray(cursor, cursor + count), used);
        used += count;
        cursor += count;
        if (used === limit) {
          const next = await write(buffer.subarray(0, limit), committed);
          if (next !== committed + used) throw new Error("Invalid saved encrypted download offset.");
          committed = next;
          used = 0;
        }
      }
    }
    if (committed !== size) throw new Error("Drive transfer ended before all encrypted bytes were saved.");
  } finally {
    signal.removeEventListener("abort", cleanup);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export interface EncryptedDownloadTarget {
  metaFileId: string;
  name: string;
  resume?: LocalDownload;
}

export interface EncryptedTransferCallbacks {
  entry(entry: LocalDownload): void;
  progress(entry: LocalDownload, part: LocalDownloadPart, offset: number): void;
  verify(): void;
}

export async function transferEncryptedDownload(
  target: EncryptedDownloadTarget,
  library: LocalDownloadLibrary,
  callbacks: EncryptedTransferCallbacks,
  signal: AbortSignal,
  open: (metaId: string, signal: AbortSignal) => EncryptedPayloadSource =
    (metaId, signal) => createEncryptedPayloadSource(metaId, { signal }),
) {
  const source = open(target.metaFileId, signal);
  try {
    const pair = await source.pair(signal);
    if (target.resume && !sameEncryptedDownloadPair(target.resume.pair, pair)) {
      throw new Error("The Drive files changed. Download the current version from Drive instead of resuming this copy.");
    }
    signal.throwIfAborted();
    const id = await localDownloadId(pair);
    if (target.resume && target.resume.id !== id) throw new Error("The saved download version changed. Rescan the folder.");
    return await library.exclusive(id, async () => {
      signal.throwIfAborted();
      const entry = await library.begin(id, pair, !!target.resume);
      callbacks.entry(entry);
      if (entry.status === "complete") return entry;
      try {
        for (const part of ["meta", "payload"] as const) {
          signal.throwIfAborted();
          const offset = part === "meta" ? entry.metaBytes : entry.payloadBytes;
          const size = pair[part].size;
          if (offset === size) continue;
          await library.savePart(id, part, offset, async (write) => {
            signal.throwIfAborted();
            const response = await source.fetchPart(part, offset, signal);
            await copyEncryptedPart(response, offset, size, async (bytes, current) => {
              const saved = await write(bytes, current);
              callbacks.progress(entry, part, saved);
              return saved;
            }, signal);
          });
        }
        signal.throwIfAborted();
        callbacks.verify();
        const completed = await library.finish(entry);
        callbacks.entry(completed);
        return completed;
      } catch (error) {
        const paused = signal.aborted && error instanceof DOMException && error.name === "AbortError";
        await library.setStatus(id, paused ? "paused" : "failed", paused ? null : localDownloadMessage(error))
          .catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof RemoteDownloadMissingError) {
      await library.markRemoteDeleted([target.metaFileId]).catch(() => undefined);
    }
    throw error;
  } finally {
    source.close();
  }
}
