type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type CachedRange = { start: number; end: number };
export type CachedEncryptedSegment = CachedRange & { bytes: Uint8Array };
type PendingWrite = CachedRange & { promise: Promise<void> };

function appendRange(ranges: CachedRange[], next: CachedRange) {
  const merged: CachedRange[] = [];
  for (const range of ranges) {
    if (range.end + 1 < next.start) {
      merged.push(range);
    } else if (next.end < range.start) {
      merged.push(next);
      next = range;
    } else {
      next = { start: Math.min(next.start, range.start), end: Math.max(next.end, range.end) };
    }
  }
  merged.push(next);
  return merged;
}

export class EncryptedPreviewCache {
  private readonly worker = new Worker(new URL("./encrypted-preview-cache.worker.ts", import.meta.url), { type: "module" });
  private readonly pending = new Map<number, Pending>();
  private readonly ranges: CachedRange[] = [];
  private readonly pendingWrites = new Set<PendingWrite>();
  private nextId = 1;
  private key: string | null = null;
  private terminated = false;

  constructor() {
    this.worker.onmessage = (event) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) pending.resolve(event.data.bytes);
      else pending.reject(new Error(event.data.error || "Encrypted preview cache error"));
    };
    const fail = (error: Error) => {
      if (this.terminated) return;
      this.terminated = true;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.worker.terminate();
    };
    this.worker.onerror = (event) => fail(new Error(event.message || "Encrypted preview cache worker failed"));
    this.worker.onmessageerror = () => fail(new Error("Encrypted preview cache worker returned unreadable data"));
  }

  private call(type: string, message: Record<string, unknown> = {}, transfer: Transferable[] = []) {
    if (this.terminated) return Promise.reject(new Error("Encrypted preview cache is unavailable"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, type, ...message }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Encrypted preview cache request failed"));
      }
    });
  }

  async open(metaFileId: string) {
    if (this.key) throw new Error("Encrypted preview cache is already open");
    const safeId = metaFileId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const token = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.key = `${safeId}-${token}`;
    try {
      await this.call("open", { key: this.key });
    } catch (error) {
      this.key = null;
      throw error;
    }
  }

  async read(start: number, end: number): Promise<Uint8Array | null> {
    const segments = await this.readSegments(start, end);
    if (segments.length !== 1 || segments[0].start !== start || segments[0].end !== end) return null;
    return segments[0].bytes;
  }

  async readSegments(start: number, end: number): Promise<CachedEncryptedSegment[]> {
    const key = this.key;
    if (!key || this.terminated || end < start) return [];
    const overlappingWrites = [...this.pendingWrites]
      .filter((pending) => pending.end >= start && pending.start <= end)
      .map((pending) => pending.promise);
    if (overlappingWrites.length) await Promise.all(overlappingWrites);
    if (this.key !== key || this.terminated) return [];
    const covered = this.ranges
      .filter((range) => range.end >= start && range.start <= end)
      .map((range) => ({ start: Math.max(start, range.start), end: Math.min(end, range.end) }));
    if (!covered.length) return [];
    const segments: CachedEncryptedSegment[] = [];
    try {
      for (const range of covered) {
        const buffer = await this.call("read", { key, offset: range.start, length: range.end - range.start + 1 });
        segments.push({ ...range, bytes: new Uint8Array(buffer as ArrayBuffer) });
      }
      return segments;
    } catch {
      return [];
    }
  }

  write(start: number, bytes: Uint8Array) {
    const key = this.key;
    if (!key || this.terminated || !bytes.byteLength) return;
    const end = start + bytes.byteLength - 1;
    const copy = bytes.slice();
    const pending: PendingWrite = { start, end, promise: Promise.resolve() };
    this.pendingWrites.add(pending);
    pending.promise = this.call("write", { key, offset: start, bytes: copy.buffer }, [copy.buffer])
      .then(() => {
        if (this.key === key && !this.terminated) this.ranges.splice(0, this.ranges.length, ...appendRange(this.ranges, { start, end }));
      })
      .catch(() => undefined)
      .finally(() => this.pendingWrites.delete(pending));
    void pending.promise;
  }

  async delete() {
    const key = this.key;
    this.key = null;
    this.ranges.splice(0, this.ranges.length);
    this.pendingWrites.clear();
    if (!key || this.terminated) return;
    await this.call("delete", { key }).catch(() => undefined);
  }

  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    this.pendingWrites.clear();
    for (const pending of this.pending.values()) pending.reject(new Error("Encrypted preview cache was closed"));
    this.pending.clear();
    this.worker.terminate();
  }
}
