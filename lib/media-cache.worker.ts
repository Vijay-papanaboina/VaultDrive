type RequestMessage = {
  id: number;
  type: "open" | "write" | "read" | "close" | "delete" | "purge";
  key?: string;
  offset?: number;
  bytes?: ArrayBuffer;
  length?: number;
};

type SyncHandle = { write(data: Uint8Array, options: { at: number }): number; read(data: Uint8Array, options: { at: number }): number; flush(): void; close(): void };
type FileHandle = { createSyncAccessHandle(): Promise<SyncHandle> };
type DirectoryHandle = { getDirectoryHandle(name: string, options: { create: boolean }): Promise<DirectoryHandle>; getFileHandle(name: string, options: { create: boolean }): Promise<FileHandle>; removeEntry(name: string): Promise<void>; [Symbol.asyncIterator](): AsyncIterator<[string, unknown]> };
type Entry = { handle: SyncHandle };
const entries = new Map<string, Entry>();
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
  entries.set(key, { handle });
}

workerScope.onmessage = async (event: MessageEvent<RequestMessage>) => {
  const message = event.data;
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
};
