const TTL = 2 * 60 * 60 * 1000;
type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export class MediaCache {
  private static readonly manifestKey = "vaultdrive.media-cache.v1";
  private static lifecycle = Promise.resolve();
  private static readonly activeKeys = new Set<string>();
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private key: string | null = null;
  private ownsKey = false;
  private bytes = 0;
  private terminated = false;

  private static async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = MediaCache.lifecycle;
    let release!: () => void;
    MediaCache.lifecycle = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private static claim(key: string) {
    if (MediaCache.activeKeys.has(key)) return false;
    MediaCache.activeKeys.add(key);
    return true;
  }

  private static release(key: string) {
    MediaCache.activeKeys.delete(key);
  }

  constructor() {
    this.worker = new Worker(new URL("./media-cache.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) {
        pending.resolve(event.data.file !== undefined
          ? { file: event.data.file, snapshotKey: event.data.snapshotKey }
          : event.data.bytes);
      }
      else pending.reject(new Error(event.data.error || "Media cache error"));
    };
    const fail = (error: unknown) => {
      this.rejectPending(error instanceof Error ? error : new Error("Media cache worker stopped unexpectedly"));
      this.releaseOwnership();
      this.worker.terminate();
    };
    this.worker.onerror = (event) => fail(new Error(event.message || "Media cache worker failed"));
    this.worker.onmessageerror = () => fail(new Error("Media cache worker returned an unreadable response"));
  }

  private rejectPending(error: Error) {
    this.terminated = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private takeOwnership() {
    if (!this.key || !this.ownsKey) return null;
    const key = this.key;
    this.key = null;
    this.ownsKey = false;
    this.bytes = 0;
    return key;
  }

  private releaseOwnership() {
    const key = this.takeOwnership();
    if (key) void MediaCache.serialize(async () => { MediaCache.release(key); });
  }

  private call(type: string, message: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<unknown> {
    if (this.terminated) return Promise.reject(new Error("Media cache is unavailable"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, type, ...message }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Media cache request failed"));
      }
    });
  }

  async open(key: string) {
    const cacheKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (this.key || this.ownsKey) throw new Error("Media cache is already open");
    this.bytes = 0;
    await MediaCache.serialize(async () => {
      // A key has one cache owner at a time. This also prevents a second
      // worker from truncating the first owner's OPFS file during open.
      if (!MediaCache.claim(cacheKey)) throw new Error("Media cache is already in use");
      this.key = cacheKey;
      this.ownsKey = true;
      try {
        await this.call("open", { key: cacheKey });
        MediaCache.touchManifest(cacheKey);
      } catch (error) {
        // A failed open must not retain a key that could later be deleted by
        // this non-owner after another instance claims it.
        const ownedKey = this.takeOwnership();
        if (ownedKey) MediaCache.release(ownedKey);
        throw error;
      }
    });
  }

  async write(offset: number, bytes: Uint8Array) {
    const key = this.key;
    if (!key || !this.ownsKey) throw new Error("Media cache is not open");
    const copy = bytes.slice();
    await MediaCache.serialize(async () => {
      await this.call("write", { key, offset, bytes: copy.buffer }, [copy.buffer]);
      this.bytes = Math.max(this.bytes, offset + bytes.byteLength);
      MediaCache.touchManifest(key, this.bytes);
    });
  }

  async read(offset: number, length: number) {
    if (!this.key || !this.ownsKey) throw new Error("Media cache is not open");
    const buffer = await this.call("read", { key: this.key, offset, length });
    return new Uint8Array(buffer as ArrayBuffer);
  }

  async snapshot() {
    if (!this.key || !this.ownsKey) throw new Error("Media cache is not open");
    const file = await this.call("snapshot", { key: this.key });
    const result = file as { file?: unknown; snapshotKey?: unknown };
    if (!result || !(result.file instanceof File) || typeof result.snapshotKey !== "string") {
      throw new Error("Media cache snapshot was unavailable");
    }
    return { file: result.file, key: result.snapshotKey };
  }

  async releaseSnapshot(key: string) {
    await this.call("releaseSnapshot", { key });
  }

  async close() {
    if (this.key && this.ownsKey) await this.call("close", { key: this.key });
  }

  async delete() {
    const key = this.takeOwnership();
    if (key) {
      await MediaCache.serialize(async () => {
        try {
          await this.call("delete", { key });
          MediaCache.removeManifest(key);
        } finally {
          MediaCache.release(key);
        }
      });
    }
  }

  terminate() {
    this.releaseOwnership();
    if (!this.terminated) this.rejectPending(new Error("Media cache was closed"));
    this.worker.terminate();
  }

  static async purgeAll() {
    await MediaCache.serialize(async () => {
      const worker = new MediaCache();
      try { await worker.call("purge"); } finally { worker.terminate(); }
      if (typeof localStorage !== "undefined") localStorage.removeItem(MediaCache.manifestKey);
    });
  }

  static async purgeExpired() {
    if (typeof localStorage === "undefined") return;
    await MediaCache.serialize(async () => {
      const now = Date.now();
      const expired = MediaCache.manifest().filter((entry) => now - entry.touched > TTL && !MediaCache.activeKeys.has(entry.key));
      if (!expired.length) return;
      const worker = new MediaCache();
      try {
        for (const entry of expired) await worker.call("delete", { key: entry.key });
      } finally { worker.terminate(); }
      // Re-read immediately before committing. This prevents an old snapshot
      // from overwriting a manifest entry that was refreshed while a purge was
      // pending, and only removes entries proved expired above.
      const deleted = new Map(expired.map((entry) => [entry.key, entry.touched]));
      const entries = MediaCache.manifest().filter((entry) =>
        deleted.get(entry.key) !== entry.touched || MediaCache.activeKeys.has(entry.key),
      );
      localStorage.setItem(MediaCache.manifestKey, JSON.stringify(entries));
    });
  }

  private static touchManifest(key: string, bytes = 0) {
    if (typeof localStorage === "undefined") return;
    const entries = MediaCache.manifest().filter((entry) => entry.key !== key);
    entries.push({ key, bytes, touched: Date.now() });
    localStorage.setItem(MediaCache.manifestKey, JSON.stringify(entries));
  }
  private static removeManifest(key: string) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(MediaCache.manifestKey, JSON.stringify(MediaCache.manifest().filter((entry) => entry.key !== key)));
  }
  private static manifest(): Array<{ key: string; bytes: number; touched: number }> {
    try { return JSON.parse(localStorage.getItem(MediaCache.manifestKey) || "[]"); } catch { return []; }
  }
}
