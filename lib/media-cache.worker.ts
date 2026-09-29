export {};

type RequestMessage = {
  id: number;
  type: "open" | "write" | "read" | "snapshot" | "releaseSnapshot" | "close" | "delete" | "purge";
  key?: string;
  offset?: number;
  bytes?: ArrayBuffer;
  length?: number;
};

type SyncHandle = { write(data: Uint8Array, options: { at: number }): number; read(data: Uint8Array, options: { at: number }): number; getSize(): number; truncate(size: number): void; flush(): void; close(): void };
type FileHandle = { createSyncAccessHandle(): Promise<SyncHandle>; getFile(): Promise<File> };
type DirectoryHandle = { getDirectoryHandle(name: string, options: { create: boolean }): Promise<DirectoryHandle>; getFileHandle(name: string, options: { create: boolean }): Promise<FileHandle>; removeEntry(name: string): Promise<void>; [Symbol.asyncIterator](): AsyncIterator<[string, unknown]> };
type Entry = { handle: SyncHandle; file: FileHandle };
const entries = new Map<string, Entry>();
let snapshotNumber = 0;
let originRoot: { getDirectoryHandle(name: string, options: { create: boolean }): Promise<DirectoryHandle> } | undefined;
let cacheDirectory: DirectoryHandle | undefined;
const workerScope = self as unknown as { onmessage: ((event: MessageEvent<RequestMessage>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void };

async function getRoot() {
  if (cacheDirectory) return cacheDirectory;
  if (!originRoot) originRoot = await (navigator.storage as unknown as { getDirectory(): Promise<{ getDirectoryHandle(name: string, options: { create: boolean }): Promise<DirectoryHandle> }> }).getDirectory();
  cacheDirectory = await originRoot.getDirectoryHandle("vaultdrive-media", { create: true });
  return cacheDirectory;
}

async function open(key: string) {
  if (entries.has(key)) return;
  const directory = await getRoot();
  const file = await directory.getFileHandle(key, { create: true });
  const handle = await file.createSyncAccessHandle();
  // File names are deliberately reused. Remove any prior plaintext tail
  // before a shorter preview starts writing at offset zero.
  handle.truncate(0);
  handle.flush();
  entries.set(key, { handle, file });
}

async function processMessage(message: RequestMessage) {
  try {
    if (message.type === "open" && message.key) await open(message.key);
    if (message.type === "write" && message.key && message.bytes) {
      const entry = entries.get(message.key);
      if (!entry) throw new Error("Media cache is not open");
      entry.handle.write(new Uint8Array(message.bytes), { at: message.offset ?? 0 });
      entry.handle.flush();
    }
    if (message.type === "read" && message.key) {
      const entry = entries.get(message.key);
      if (!entry) throw new Error("Media cache is not open");
      const result = new Uint8Array(message.length ?? 0);
      entry.handle.read(result, { at: message.offset ?? 0 });
      const buffer = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
      workerScope.postMessage({ id: message.id, ok: true, bytes: buffer }, [buffer]);
      return;
    }
    if (message.type === "snapshot" && message.key) {
      const entry = entries.get(message.key);
      if (!entry) throw new Error("Media cache is not open");
      entry.handle.flush();
      const directory = await getRoot();
      const snapshotName = `${message.key}.snapshot-${snapshotNumber++}`;
      const snapshotFile = await directory.getFileHandle(snapshotName, { create: true });
      const snapshotHandle = await snapshotFile.createSyncAccessHandle();
      const size = entry.handle.getSize();
      const buffer = new Uint8Array(1024 * 1024);
      try {
        // A restarted worker can reuse a snapshot name, so this must happen
        // before copying the current (possibly shorter) source file.
        snapshotHandle.truncate(0);
        for (let offset = 0; offset < size; offset += buffer.byteLength) {
          const read = entry.handle.read(buffer, { at: offset });
          if (read <= 0) break;
          snapshotHandle.write(buffer.subarray(0, read), { at: offset });
        }
        snapshotHandle.flush();
      } finally {
        snapshotHandle.close();
      }
      workerScope.postMessage({ id: message.id, ok: true, file: await snapshotFile.getFile(), snapshotKey: snapshotName });
      return;
    }
    if (message.type === "releaseSnapshot" && message.key) {
      const directory = await getRoot();
      await directory.removeEntry(message.key).catch(() => undefined);
    }
    if (message.type === "close" && message.key) {
      const entry = entries.get(message.key);
      if (entry) {
        entry.handle.flush();
        entry.handle.close();
        entries.delete(message.key);
      }
    }
    if (message.type === "delete" && message.key) {
      const entry = entries.get(message.key);
      if (entry) {
        entry.handle.close();
        entries.delete(message.key);
      }
      const directory = await getRoot();
      await directory.removeEntry(message.key).catch(() => undefined);
      for await (const [name] of directory) {
        if (name.startsWith(`${message.key}.snapshot-`)) await directory.removeEntry(name).catch(() => undefined);
      }
    }
    if (message.type === "purge") {
      for (const [key, entry] of entries) {
        entry.handle.close();
        entries.delete(key);
      }
      const directory = await getRoot();
      for await (const [name] of directory) await directory.removeEntry(name).catch(() => undefined);
    }
    workerScope.postMessage({ id: message.id, ok: true });
  } catch (error) {
    workerScope.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : "Media cache error" });
  }
}

let operationQueue = Promise.resolve();
workerScope.onmessage = (event: MessageEvent<RequestMessage>) => {
  operationQueue = operationQueue.then(() => processMessage(event.data));
};
