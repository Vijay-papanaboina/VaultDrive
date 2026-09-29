export {};

type RequestMessage = {
  id: number;
  type: "open" | "write" | "read" | "delete";
  key?: string;
  offset?: number;
  bytes?: ArrayBuffer;
  length?: number;
};

type SyncHandle = {
  write(data: Uint8Array, options: { at: number }): number;
  read(data: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
};
type FileHandle = { createSyncAccessHandle(): Promise<SyncHandle> };
type DirectoryHandle = {
  getDirectoryHandle(name: string, options: { create: boolean }): Promise<DirectoryHandle>;
  getFileHandle(name: string, options: { create: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
};

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<RequestMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

let originRoot: { getDirectory(): Promise<DirectoryHandle> } | undefined;
let cacheDirectory: DirectoryHandle | undefined;
const entries = new Map<string, SyncHandle>();

async function getDirectory() {
  if (cacheDirectory) return cacheDirectory;
  if (!originRoot) originRoot = navigator.storage as unknown as { getDirectory(): Promise<DirectoryHandle> };
  const root = await originRoot.getDirectory();
  cacheDirectory = await root.getDirectoryHandle("vaultdrive-preview-encrypted", { create: true });
  return cacheDirectory;
}

async function open(key: string) {
  if (entries.has(key)) return;
  const directory = await getDirectory();
  const file = await directory.getFileHandle(key, { create: true });
  entries.set(key, await file.createSyncAccessHandle());
}

async function processMessage(message: RequestMessage) {
  try {
    if (message.type === "open" && message.key) await open(message.key);
    if (message.type === "write" && message.key && message.bytes) {
      const handle = entries.get(message.key);
      if (!handle) throw new Error("Encrypted preview cache is not open");
      handle.write(new Uint8Array(message.bytes), { at: message.offset ?? 0 });
      handle.flush();
    }
    if (message.type === "read" && message.key) {
      const handle = entries.get(message.key);
      if (!handle) throw new Error("Encrypted preview cache is not open");
      const result = new Uint8Array(message.length ?? 0);
      const read = handle.read(result, { at: message.offset ?? 0 });
      if (read !== result.byteLength) throw new Error("Encrypted preview cache range is incomplete");
      const buffer = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
      workerScope.postMessage({ id: message.id, ok: true, bytes: buffer }, [buffer]);
      return;
    }
    if (message.type === "delete" && message.key) {
      const handle = entries.get(message.key);
      if (handle) {
        handle.close();
        entries.delete(message.key);
      }
      const directory = await getDirectory();
      await directory.removeEntry(message.key).catch(() => undefined);
    }
    workerScope.postMessage({ id: message.id, ok: true });
  } catch (error) {
    workerScope.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : "Encrypted preview cache error",
    });
  }
}

let operationQueue = Promise.resolve();
workerScope.onmessage = (event: MessageEvent<RequestMessage>) => {
  operationQueue = operationQueue.then(() => processMessage(event.data));
};
