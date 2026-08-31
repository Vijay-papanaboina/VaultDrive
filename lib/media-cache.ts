const TTL = 2 * 60 * 60 * 1000;
type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export class MediaCache {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private key: string | null = null;
  private bytes = 0;

  constructor() {
    this.worker = new Worker(new URL("./media-cache.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) pending.resolve(event.data.bytes);
      else pending.reject(new Error(event.data.error || "Media cache error"));
    };
  }

  private call(type: string, message: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...message }, transfer);
    });
  }

  async open(key: string) {
    this.key = key.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.bytes = 0;
    await this.call("open", { key: this.key });
    this.touchManifest(this.key);
  }

  async write(offset: number, bytes: Uint8Array) {
    if (!this.key) throw new Error("Media cache is not open");
    const copy = bytes.slice();
    await this.call("write", { key: this.key, offset, bytes: copy.buffer }, [copy.buffer]);
    this.bytes = Math.max(this.bytes, offset + bytes.byteLength);
    this.touchManifest(this.key, this.bytes);
  }

  async read(offset: number, length: number) {
    if (!this.key) throw new Error("Media cache is not open");
    const buffer = await this.call("read", { key: this.key, offset, length });
    return new Uint8Array(buffer as ArrayBuffer);
  }

  async close() {
    if (this.key) await this.call("close", { key: this.key });
  }

  async delete() {
    if (this.key) await this.call("delete", { key: this.key });
    if (this.key) this.removeManifest(this.key);
    this.key = null;
    this.bytes = 0;
  }

  terminate() {
    this.worker.terminate();
  }

  static async purgeAll() {
    const worker = new MediaCache();
    await worker.call("purge");
    worker.worker.terminate();
    if (typeof localStorage !== "undefined") localStorage.removeItem("vaultdrive.media-cache.v1");
  }

  static async purgeExpired() {
    if (typeof localStorage === "undefined") return;
    const entries = MediaCache.manifest();
    const expired = entries.filter((entry) => Date.now() - entry.touched > TTL);
    if (!expired.length) return;
    const worker = new MediaCache();
    for (const entry of expired) {
      await worker.call("delete", { key: entry.key });
      delete entries[entries.indexOf(entry)];
    }
    worker.worker.terminate();
    localStorage.setItem("vaultdrive.media-cache.v1", JSON.stringify(entries.filter(Boolean)));
  }

  private touchManifest(key: string, bytes = 0) {
    if (typeof localStorage === "undefined") return;
    const entries = MediaCache.manifest().filter((entry) => entry.key !== key);
    entries.push({ key, bytes, touched: Date.now() });
    localStorage.setItem("vaultdrive.media-cache.v1", JSON.stringify(entries));
  }
  private removeManifest(key: string) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem("vaultdrive.media-cache.v1", JSON.stringify(MediaCache.manifest().filter((entry) => entry.key !== key)));
  }
  private static manifest(): Array<{ key: string; bytes: number; touched: number }> {
    try { return JSON.parse(localStorage.getItem("vaultdrive.media-cache.v1") || "[]"); } catch { return []; }
  }
}
