import { DOWNLOAD_SETTINGS_MAX_VALUE, DOWNLOAD_SETTINGS_MIN_VALUE } from "@/lib/download-settings";

export type DownloadPipelinePhase = "read" | "write" | "between";

type ReadResult =
  | { ok: true; bytes: Uint8Array; length: number }
  | { ok: false; error: unknown; length: number };

export interface ParallelDownloadOptions {
  start: number;
  end: number;
  chunkSize: number;
  getConcurrency: () => number;
  signal: AbortSignal;
  read: (offset: number, length: number, signal: AbortSignal) => Promise<Uint8Array>;
  write: (bytes: Uint8Array) => Promise<void>;
  retainWrittenBytes?: boolean;
  onCommit: (offset: number, length: number) => void;
  onPhase: (phase: DownloadPipelinePhase) => void;
  assertCurrent: () => void;
}

function abortError() {
  return new DOMException("Download request was cancelled", "AbortError");
}

function concurrencyLimit(value: number): number {
  if (!Number.isSafeInteger(value)) return DOWNLOAD_SETTINGS_MIN_VALUE;
  return Math.max(DOWNLOAD_SETTINGS_MIN_VALUE, Math.min(DOWNLOAD_SETTINGS_MAX_VALUE, value));
}

export async function runParallelDownload(options: ParallelDownloadOptions): Promise<void> {
  const { start, end, chunkSize, signal } = options;
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start) {
    throw new Error("Download byte range is invalid.");
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("Download chunk size is invalid.");
  }

  const rangeController = new AbortController();
  const rangeSignal = AbortSignal.any([signal, rangeController.signal]);
  const pending = new Map<number, Promise<ReadResult>>();
  let nextReadOffset = start;
  let commitOffset = start;

  const fillWindow = () => {
    const limit = concurrencyLimit(options.getConcurrency());
    while (pending.size < limit && nextReadOffset < end) {
      const offset = nextReadOffset;
      const length = Math.min(chunkSize, end - offset);
      nextReadOffset += length;
      const result = Promise.resolve()
        .then(() => options.read(offset, length, rangeSignal))
        .then<ReadResult, ReadResult>(
          (bytes) => ({ ok: true, bytes, length }),
          (error: unknown) => ({ ok: false, error, length })
        );
      pending.set(offset, result);
    }
  };

  try {
    options.assertCurrent();
    if (signal.aborted) throw abortError();

    while (commitOffset < end) {
      options.assertCurrent();
      if (signal.aborted) throw abortError();
      fillWindow();

      const resultPromise = pending.get(commitOffset);
      if (!resultPromise) throw new Error("Download read window is inconsistent.");
      options.onPhase("read");
      const result = await resultPromise;
      options.assertCurrent();
      if (signal.aborted) throw abortError();
      if (!result.ok) throw result.error instanceof Error ? result.error : new Error("Could not read the next download chunk.");
      if (result.bytes.byteLength !== result.length) {
        throw new Error("Downloaded chunk has an unexpected byte length.");
      }

      options.assertCurrent();
      if (signal.aborted) throw abortError();
      options.onPhase("write");
      await options.write(result.bytes);

      options.assertCurrent();
      options.onCommit(commitOffset, result.length);
      pending.delete(commitOffset);
      commitOffset += result.length;
      if (!options.retainWrittenBytes) result.bytes.fill(0);
      options.onPhase("between");

      if (signal.aborted) throw abortError();
    }
  } finally {
    rangeController.abort();
    const settled = await Promise.all(Array.from(pending.values()));
    for (const result of settled) {
      if (result.ok) result.bytes.fill(0);
    }
    pending.clear();
  }
}
