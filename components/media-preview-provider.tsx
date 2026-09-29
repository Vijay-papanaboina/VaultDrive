"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { decryptPayloadStream } from "@/lib/crypto";
import { EncryptedPreviewCache } from "@/lib/encrypted-preview-cache";
import { MediaCache } from "@/lib/media-cache";
import { createMp4Transmuxer, type Mp4Transmuxer } from "@/lib/mp4-transmuxer";
import { openRandomAccessAgeReader, type RandomAccessAgeReader } from "@/lib/random-access-age-reader";
import { useCrypto } from "@/hooks/use-crypto";
import { MediaPreviewModal } from "@/components/media-preview-modal";

export interface MediaPreviewTarget {
  metaFileId: string;
  displayName: string;
  originalFileName: string;
  mimeType?: string;
  expectedSize?: number;
}

export type MediaPreviewStage = "preparing" | "downloading" | "buffering" | "playing" | "replaying" | "paused" | "complete" | "failed";
export interface MediaPreviewState {
  target: MediaPreviewTarget;
  stage: MediaPreviewStage;
  downloadedBytes: number;
  expectedSize?: number;
  bufferedRanges: Array<{ start: number; end: number }>;
  mediaUrl: string | null;
  fallbackDownload: boolean;
  error?: string;
}

interface PreviewContextValue {
  preview: MediaPreviewState | null;
  openPreview(target: MediaPreviewTarget): Promise<void>;
  closePreview(): Promise<void>;
  updateBufferedRanges(ranges: Array<{ start: number; end: number }>): void;
  requestReplay(time: number): Promise<void>;
  setMediaElement(element: HTMLMediaElement | null): void;
  clearMediaCache(): Promise<void>;
  encryptedPreviewDiskCacheEnabled: boolean;
  setEncryptedPreviewDiskCacheEnabled(enabled: boolean): void;
}
const PreviewContext = createContext<PreviewContextValue | null>(null);

const ENCRYPTED_PREVIEW_DISK_CACHE_KEY = "vaultdrive.encrypted-preview-disk-cache.v1";

const CHUNK = 1024 * 1024;
const MP4_BOOTSTRAP_RATIO = 0.01;
const MP4_PRELOAD_RATIO = 0.05;
const MP4_URGENT_REQUEST_BYTES = 256 * 1024;
const MP4_PREFETCH_REQUEST_BYTES = 3 * 1024 * 1024;
const MP4_PREFETCH_CONCURRENCY = 6;
function mimeFor(target: MediaPreviewTarget) {
  if (target.mimeType?.startsWith("audio/") || target.mimeType?.startsWith("video/")) return target.mimeType;
  const ext = target.originalFileName.toLowerCase().split(".").pop();
  return ({ mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", weba: "audio/webm" } as Record<string, string>)[ext || ""];
}

function mp4PreloadBytes(originalSize: number, offset: number) {
  return Math.min(
    originalSize - offset,
    Math.max(MP4_URGENT_REQUEST_BYTES, Math.ceil(originalSize * MP4_PRELOAD_RATIO)),
  );
}

function mp4BootstrapBytes(originalSize: number, offset: number) {
  return Math.min(
    originalSize - offset,
    Math.max(MP4_URGENT_REQUEST_BYTES, Math.min(MP4_PREFETCH_REQUEST_BYTES, Math.ceil(originalSize * MP4_BOOTSTRAP_RATIO))),
  );
}

function mimeCandidates(mime: string) {
  const candidates = [mime];
  if (mime === "video/mp4") candidates.push('video/mp4; codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4; codecs="avc1.4d401f,mp4a.40.2"');
  if (mime === "video/webm") candidates.push('video/webm; codecs="vp8,vorbis"', 'video/webm; codecs="vp9,opus"');
  if (mime === "audio/webm") candidates.push('audio/webm; codecs="opus"', 'audio/webm; codecs="vorbis"');
  return candidates;
}

function canUseNativePlayback(mime: string) {
  if (typeof document === "undefined") return false;
  const element = document.createElement(mime.startsWith("video/") ? "video" : "audio");
  return element.canPlayType(mime) !== "";
}

function abortedError() {
  return new DOMException("Preview was closed", "AbortError");
}

function waitForSourceOpen(source: MediaSource, signal: AbortSignal, addBuffer: () => void) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      source.removeEventListener("sourceopen", open);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => { cleanup(); reject(abortedError()); };
    const open = () => {
      cleanup();
      if (signal.aborted) { reject(abortedError()); return; }
      try { addBuffer(); resolve(); } catch (error) { reject(error instanceof Error ? error : new Error("Media codec is not supported")); }
    };
    signal.addEventListener("abort", abort, { once: true });
    source.addEventListener("sourceopen", open, { once: true });
    if (signal.aborted) abort();
  });
}

function appendBuffer(source: SourceBuffer, bytes: Uint8Array, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      source.removeEventListener("updateend", finish);
      source.removeEventListener("error", fail);
      signal.removeEventListener("abort", abort);
    };
    const finish = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("The browser could not decode this media format.")); };
    const abort = () => { cleanup(); reject(abortedError()); };
    source.addEventListener("updateend", finish, { once: true });
    source.addEventListener("error", fail, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) { abort(); return; }
      source.appendBuffer(bytes as BufferSource);
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error("Media append failed"));
    }
  });
}

function waitForUpdateEnd(source: SourceBuffer, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      source.removeEventListener("updateend", finish);
      signal.removeEventListener("abort", abort);
    };
    const finish = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(abortedError()); };
    source.addEventListener("updateend", finish, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function MediaPreviewProvider({ children }: { children: React.ReactNode }) {
  const { getPassphrase, registerSensitiveCleanup } = useCrypto();
  const [preview, setPreview] = useState<MediaPreviewState | null>(null);
  const [encryptedPreviewDiskCacheEnabled, setEncryptedPreviewDiskCacheEnabledState] = useState(false);
  const cacheRef = useRef<MediaCache | null>(null);
  const encryptedPreviewCacheRef = useRef<EncryptedPreviewCache | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const mediaElementRef = useRef<HTMLMediaElement | null>(null);
  const targetRef = useRef<MediaPreviewTarget | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const downloadedRef = useRef(0);
  const playbackModeRef = useRef<"mse" | "transmux" | "native">("mse");
  const snapshotKeyRef = useRef<string | null>(null);
  const transmuxerRef = useRef<Mp4Transmuxer | null>(null);
  const randomReaderRef = useRef<RandomAccessAgeReader | null>(null);
  const rangeAbortRef = useRef(new Set<AbortController>());
  const randomSeekRef = useRef<((time: number) => Promise<void>) | null>(null);
  const requestMp4PrefetchRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef(0);
  const appendStateRef = useRef({ session: 0, promise: Promise.resolve() });
  const timersRef = useRef(new Map<number, Set<number>>());

  const current = useCallback((session: number, signal?: AbortSignal) => sessionRef.current === session && !signal?.aborted, []);
  const cancelTimers = useCallback((session?: number) => {
    const groups = session === undefined ? [...timersRef.current.entries()] : [[session, timersRef.current.get(session)] as const];
    for (const [key, timers] of groups) {
      if (!timers) continue;
      for (const timer of timers) window.clearTimeout(timer);
      timersRef.current.delete(key);
    }
  }, []);
  const schedule = useCallback((session: number, callback: () => void, delay = 0) => {
    const timers = timersRef.current.get(session) || new Set<number>();
    timersRef.current.set(session, timers);
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      if (timers.size === 0) timersRef.current.delete(session);
      if (sessionRef.current === session) callback();
    }, delay);
    timers.add(timer);
  }, []);

  const disposeCurrent = useCallback(async () => {
    const controller = abortRef.current;
    const cache = cacheRef.current;
    const encryptedPreviewCache = encryptedPreviewCacheRef.current;
    const url = objectUrlRef.current;
    const snapshotKey = snapshotKeyRef.current;
    const transmuxer = transmuxerRef.current;
    const randomReader = randomReaderRef.current;
    const rangeAborts = rangeAbortRef.current;
    abortRef.current = null;
    cacheRef.current = null;
    encryptedPreviewCacheRef.current = null;
    objectUrlRef.current = null;
    snapshotKeyRef.current = null;
    transmuxerRef.current = null;
    randomReaderRef.current = null;
    rangeAbortRef.current = new Set();
    randomSeekRef.current = null;
    requestMp4PrefetchRef.current = null;
    mediaSourceRef.current = null;
    sourceBufferRef.current = null;
    targetRef.current = null;
    playbackModeRef.current = "mse";
    downloadedRef.current = 0;
    appendStateRef.current = { session: 0, promise: Promise.resolve() };
    controller?.abort();
    for (const rangeAbort of rangeAborts) rangeAbort.abort();
    randomReader?.close();
    transmuxer?.dispose();
    cancelTimers();
    if (url) URL.revokeObjectURL(url);
    if (cache) {
      if (snapshotKey) await cache.releaseSnapshot(snapshotKey).catch(() => undefined);
      await cache.delete().catch(() => undefined);
      cache.terminate();
    }
    if (encryptedPreviewCache) {
      await encryptedPreviewCache.delete();
      encryptedPreviewCache.terminate();
    }
  }, [cancelTimers]);

  const clearMediaCache = useCallback(async () => {
    sessionRef.current += 1;
    setPreview(null);
    await disposeCurrent();
  }, [disposeCurrent]);

  useEffect(() => {
    const unregister = registerSensitiveCleanup(clearMediaCache);
    void MediaCache.purgeExpired();
    return () => { unregister(); void clearMediaCache(); };
  }, [clearMediaCache, registerSensitiveCleanup]);

  useEffect(() => {
    const syncPreference = () => {
      try {
        setEncryptedPreviewDiskCacheEnabledState(localStorage.getItem(ENCRYPTED_PREVIEW_DISK_CACHE_KEY) === "true");
      } catch {
        setEncryptedPreviewDiskCacheEnabledState(false);
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === ENCRYPTED_PREVIEW_DISK_CACHE_KEY) syncPreference();
    };
    syncPreference();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setEncryptedPreviewDiskCacheEnabled = useCallback((enabled: boolean) => {
    setEncryptedPreviewDiskCacheEnabledState(enabled);
    try {
      localStorage.setItem(ENCRYPTED_PREVIEW_DISK_CACHE_KEY, String(enabled));
    } catch {
      // The current session keeps the selected behavior even if persistence is unavailable.
    }
  }, []);

  const updateBufferedRanges = useCallback((ranges: Array<{ start: number; end: number }>) => {
    setPreview((state) => state ? { ...state, bufferedRanges: ranges } : state);
    requestMp4PrefetchRef.current?.();
  }, []);

  const enqueueSourceOperation = useCallback(async (session: number, operation: () => Promise<void>) => {
    if (appendStateRef.current.session !== session) appendStateRef.current = { session, promise: Promise.resolve() };
    // Keep the queue usable after a failed append so a later native fallback
    // or replay can still cleanly take ownership of the SourceBuffer.
    const queued = appendStateRef.current.promise.catch(() => undefined).then(operation);
    appendStateRef.current.promise = queued;
    return queued;
  }, []);

  const enqueueAppend = useCallback(async (session: number, source: SourceBuffer, bytes: Uint8Array, signal: AbortSignal) => {
    if (!current(session, signal)) throw abortedError();
    return enqueueSourceOperation(session, () => appendBuffer(source, bytes, signal));
  }, [current, enqueueSourceOperation]);

  const openPreview = useCallback(async (target: MediaPreviewTarget) => {
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    setPreview(null);
    await disposeCurrent();
    if (!current(session)) return;

    const mime = mimeFor(target);
    const mseMime = mime && typeof MediaSource !== "undefined"
      ? mimeCandidates(mime).find((candidate) => MediaSource.isTypeSupported(candidate))
      : undefined;
    const isMp4 = mime === "video/mp4" || mime === "audio/mp4";
    const canTransmuxMp4 = isMp4 && typeof MediaSource !== "undefined";
    const nativePlayable = !!mime && canUseNativePlayback(mime);
    if (!mime || (!mseMime && !nativePlayable && !canTransmuxMp4)) {
      setPreview({ target, stage: "failed", downloadedBytes: 0, expectedSize: target.expectedSize, bufferedRanges: [], mediaUrl: null, fallbackDownload: true, error: `This browser cannot play ${mime || "this file type"}.` });
      return;
    }
    const identity = getPassphrase();
    if (!identity) throw new Error("Enter your decryption passphrase first");
    const controller = new AbortController();
    let cache: MediaCache | null = null;
    let encryptedPreviewCache: EncryptedPreviewCache | null = null;
    const fail = async (error: unknown) => {
      if (!current(session, controller.signal)) return;
      const message = error instanceof Error ? error.message : "Preview failed";
      const url = objectUrlRef.current;
      const snapshotKey = snapshotKeyRef.current;
      const transmuxer = transmuxerRef.current;
      const randomReader = randomReaderRef.current;
      const activeEncryptedPreviewCache = encryptedPreviewCacheRef.current;
      const rangeAborts = rangeAbortRef.current;
      objectUrlRef.current = null;
      snapshotKeyRef.current = null;
      transmuxerRef.current = null;
      randomReaderRef.current = null;
      encryptedPreviewCacheRef.current = null;
      rangeAbortRef.current = new Set();
      randomSeekRef.current = null;
      requestMp4PrefetchRef.current = null;
      mediaSourceRef.current = null;
      sourceBufferRef.current = null;
      cancelTimers(session);
      controller.abort();
      for (const rangeAbort of rangeAborts) rangeAbort.abort();
      randomReader?.close();
      transmuxer?.dispose();
      if (abortRef.current === controller) abortRef.current = null;
      if (url) URL.revokeObjectURL(url);
      if (cache) {
        if (snapshotKey) await cache.releaseSnapshot(snapshotKey).catch(() => undefined);
        await cache.delete().catch(() => undefined);
        cache.terminate();
        if (cacheRef.current === cache) cacheRef.current = null;
      }
      if (activeEncryptedPreviewCache) {
        await activeEncryptedPreviewCache.delete();
        activeEncryptedPreviewCache.terminate();
      }
      if (sessionRef.current === session) setPreview({ target, stage: "failed", downloadedBytes: downloadedRef.current, expectedSize: target.expectedSize, bufferedRanges: [], mediaUrl: null, fallbackDownload: true, error: message });
    };

    abortRef.current = controller;
    playbackModeRef.current = "mse";
    targetRef.current = target;
    downloadedRef.current = 0;
    setPreview({ target, stage: "preparing", downloadedBytes: 0, expectedSize: target.expectedSize, bufferedRanges: [], mediaUrl: null, fallbackDownload: false });
    try {
      if (canTransmuxMp4) {
        if (encryptedPreviewDiskCacheEnabled) {
          const candidate = new EncryptedPreviewCache();
          try {
            await candidate.open(target.metaFileId);
            if (!current(session, controller.signal)) {
              await candidate.delete();
              candidate.terminate();
              return;
            }
            encryptedPreviewCache = candidate;
            encryptedPreviewCacheRef.current = candidate;
          } catch {
            await candidate.delete();
            candidate.terminate();
          }
        }
        const randomReader = await openRandomAccessAgeReader({
          identity,
          metaFileId: target.metaFileId,
          signal: controller.signal,
          encryptedCache: encryptedPreviewCache,
        });
        if (!current(session, controller.signal)) {
          randomReader.close();
          return;
        }
        randomReaderRef.current = randomReader;
        const mediaSource = new MediaSource();
        mediaSourceRef.current = mediaSource;
        const url = URL.createObjectURL(mediaSource);
        objectUrlRef.current = url;
        setPreview((state) => current(session, controller.signal) && state ? {
          ...state,
          expectedSize: randomReader.originalSize,
          mediaUrl: url,
          stage: "buffering",
        } : state);
        await waitForSourceOpen(mediaSource, controller.signal, () => undefined);
        if (!current(session, controller.signal)) return;

        const transmuxer = createMp4Transmuxer(mediaSource, controller.signal, () => {
          if (!current(session, controller.signal) || playbackModeRef.current !== "transmux") return;
          setPreview((state) => current(session, controller.signal) && state ? { ...state, stage: "playing" } : state);
        });
        transmuxerRef.current = transmuxer;
        playbackModeRef.current = "transmux";
        let generation = 0;
        let seekQueue = Promise.resolve();
        let pendingSeekTime: number | null = null;
        let prefetchOffset: number | null = null;
        let prefetchMode: "parser" | "seek" = "parser";
        let prefetchBudget = 0;
        let prefetchRunning = false;
        let reachedEnd = false;
        const fetchedRanges: Array<{ start: number; end: number }> = [];
        const requestedOffsets = new Map<number, number>();
        const recordFetchedRange = (start: number, length: number) => {
          let next = { start, end: start + length };
          const merged: Array<{ start: number; end: number }> = [];
          for (const range of fetchedRanges) {
            if (range.end < next.start) {
              merged.push(range);
            } else if (next.end < range.start) {
              merged.push(next);
              next = range;
            } else {
              next = { start: Math.min(next.start, range.start), end: Math.max(next.end, range.end) };
            }
          }
          merged.push(next);
          fetchedRanges.splice(0, fetchedRanges.length, ...merged);
          return fetchedRanges.reduce((total, range) => total + range.end - range.start, 0);
        };
        const reportRangeFailure = async (error: unknown, requestGeneration: number, requestController?: AbortController) => {
          if (requestController?.signal.aborted || requestGeneration !== generation || !current(session, controller.signal)) return;
          await fail(error);
        };
        type FetchedMp4Range = { offset: number; bytes: Uint8Array };
        type LoadedMp4Range = { parserNextOffset: number; endOffset: number; bytesRead: number };
        const fetchAt = async (offset: number, requestGeneration: number, requestBytes: number): Promise<FetchedMp4Range | null> => {
          if (requestGeneration !== generation || !current(session, controller.signal)) return null;
          if (!Number.isSafeInteger(offset) || offset < 0 || offset >= randomReader.originalSize) {
            await reportRangeFailure(new Error("MP4Box requested an invalid media byte range."), requestGeneration);
            return null;
          }
          const requestCount = (requestedOffsets.get(offset) || 0) + 1;
          requestedOffsets.set(offset, requestCount);
          if (requestCount > 3) {
            await reportRangeFailure(new Error("MP4Box repeatedly requested the same media byte range."), requestGeneration);
            return null;
          }
          const requestController = new AbortController();
          rangeAbortRef.current.add(requestController);
          try {
            const bytes = await randomReader.read(offset, Math.min(requestBytes, randomReader.originalSize - offset), requestController.signal);
            if (requestController.signal.aborted || requestGeneration !== generation || !current(session, controller.signal)) return null;
            return { offset, bytes };
          } catch (error) {
            await reportRangeFailure(error, requestGeneration, requestController);
            return null;
          } finally {
            rangeAbortRef.current.delete(requestController);
          }
        };
        const appendFetched = async (fetched: FetchedMp4Range, requestGeneration: number): Promise<LoadedMp4Range | null> => {
          if (requestGeneration !== generation || !current(session, controller.signal)) return null;
          try {
            const { bytes, offset } = fetched;
            const nextOffset = transmuxer.append(bytes, offset);
            if (transmuxer.failed) throw transmuxer.failed;
            if (nextOffset === null) throw new Error("MP4Box could not determine the next media byte range.");
            downloadedRef.current = recordFetchedRange(offset, bytes.byteLength);
            setPreview((state) => current(session, controller.signal) && requestGeneration === generation && state ? {
              ...state,
              stage: transmuxer.ready ? "playing" : "buffering",
              downloadedBytes: downloadedRef.current,
              expectedSize: randomReader.originalSize,
            } : state);
            return { parserNextOffset: nextOffset, endOffset: offset + bytes.byteLength, bytesRead: bytes.byteLength };
          } catch (error) {
            await reportRangeFailure(error, requestGeneration);
            return null;
          }
        };
        const loadAt = async (offset: number, requestGeneration: number, requestBytes: number) => {
          const fetched = await fetchAt(offset, requestGeneration, requestBytes);
          return fetched ? appendFetched(fetched, requestGeneration) : null;
        };
        const startPendingSeek = () => {
          if (pendingSeekTime === null || !transmuxer.ready) return false;
          const deferredTime = pendingSeekTime;
          pendingSeekTime = null;
          prefetchOffset = null;
          prefetchBudget = 0;
          void randomSeekRef.current?.(deferredTime);
          return true;
        };
        const pumpPrefetch = async (): Promise<void> => {
          if (prefetchRunning || prefetchOffset === null || prefetchBudget <= 0 || reachedEnd || !current(session, controller.signal)) return;
          prefetchRunning = true;
          try {
            if (prefetchMode === "seek") {
              const requestGeneration = generation;
              const targetEnd = Math.min(randomReader.originalSize, prefetchOffset + prefetchBudget);
              let nextReadOffset = prefetchOffset;
              const pending: Array<{ offset: number; endOffset: number; read: Promise<FetchedMp4Range | null> }> = [];
              const queueReads = () => {
                while (pending.length < MP4_PREFETCH_CONCURRENCY && nextReadOffset < targetEnd) {
                  const offset = nextReadOffset;
                  const byteLength = Math.min(MP4_PREFETCH_REQUEST_BYTES, targetEnd - offset);
                  nextReadOffset += byteLength;
                  pending.push({ offset, endOffset: offset + byteLength, read: fetchAt(offset, requestGeneration, byteLength) });
                }
              };
              queueReads();
              while (pending.length && requestGeneration === generation && current(session, controller.signal)) {
                const next = pending.shift()!;
                const fetched = await next.read;
                if (!fetched || requestGeneration !== generation || !current(session, controller.signal)) return;
                const loaded = await appendFetched(fetched, requestGeneration);
                if (!loaded || requestGeneration !== generation || !current(session, controller.signal)) return;
                if (loaded.endOffset !== next.endOffset) {
                  await reportRangeFailure(new Error("Preview prefetch range ended at an unexpected byte offset."), requestGeneration);
                  return;
                }
                prefetchOffset = loaded.endOffset;
                prefetchBudget = Math.max(0, targetEnd - loaded.endOffset);
                if (loaded.endOffset >= randomReader.originalSize) {
                  reachedEnd = true;
                  return;
                }
                queueReads();
              }
              return;
            }
            while (prefetchOffset !== null && prefetchBudget > 0 && !reachedEnd && current(session, controller.signal)) {
              const requestGeneration = generation;
              const offset: number = prefetchOffset;
              prefetchOffset = null;
              // The player starts from one urgent range. Once that is done,
              // use substantially larger ranges to keep network overhead from
              // consuming the headroom that preloading is meant to create.
              const loaded = await loadAt(offset, requestGeneration, MP4_PREFETCH_REQUEST_BYTES);
              if (!loaded || requestGeneration !== generation || !current(session, controller.signal)) return;
              if (startPendingSeek()) return;
              // Before MP4 metadata is available, MP4Box's cursor can jump to
              // a tail moov box. This parser-only branch follows that cursor
              // until the first media range is known.
              const nextOffset = loaded.parserNextOffset;
              if (!Number.isSafeInteger(nextOffset) || nextOffset < 0 || nextOffset > randomReader.originalSize) {
                await reportRangeFailure(new Error("MP4Box requested an invalid follow-up media byte range."), requestGeneration);
                return;
              }
              if (nextOffset === offset) {
                await reportRangeFailure(new Error("MP4Box did not advance to a new media byte range."), requestGeneration);
                return;
              }
              if (nextOffset >= randomReader.originalSize) {
                // Do not end the MediaSource here. A random-access preview
                // must remain seekable after MP4Box reaches the file end.
                reachedEnd = true;
                return;
              }
              prefetchBudget -= loaded.bytesRead;
              prefetchOffset = nextOffset;
              if (transmuxer.ready) {
                // Metadata discovery may jump between boxes. Once it has
                // identified the first media bytes, switch to a linear pool
                // so range requests can run ahead in parallel.
                prefetchMode = "seek";
                return;
              }
              // Yield after each request so playback, controls, and a fresh
              // seek can run before more background buffering is scheduled.
              await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
            }
          } catch (error) {
            await reportRangeFailure(error, generation);
          } finally {
            prefetchRunning = false;
            if (prefetchOffset !== null && prefetchBudget > 0 && !reachedEnd && current(session, controller.signal)) void pumpPrefetch();
          }
        };
        const beginPrefetch = (nextOffset: number, remainingBudget: number, mode: "parser" | "seek") => {
          if (nextOffset >= randomReader.originalSize) {
            reachedEnd = true;
            return;
          }
          prefetchOffset = nextOffset;
          prefetchMode = mode;
          prefetchBudget = Math.max(0, remainingBudget);
          void pumpPrefetch();
        };
        requestMp4PrefetchRef.current = () => {
          if (prefetchRunning || prefetchOffset === null || prefetchBudget > 0 || reachedEnd || !current(session, controller.signal)) return;
          const media = mediaElementRef.current;
          if (!media || !Number.isFinite(media.currentTime)) return;
          let bufferedEnd: number | null = null;
          for (let index = 0; index < media.buffered.length; index++) {
            const start = media.buffered.start(index);
            const end = media.buffered.end(index);
            if (media.currentTime >= start && media.currentTime <= end) {
              bufferedEnd = end;
              break;
            }
          }
          const targetAheadSeconds = Number.isFinite(media.duration) && media.duration > 0
            ? Math.max(2, media.duration * MP4_PRELOAD_RATIO)
            : 5;
          if (bufferedEnd !== null && bufferedEnd - media.currentTime >= targetAheadSeconds) return;
          prefetchBudget = mp4PreloadBytes(randomReader.originalSize, prefetchOffset);
          void pumpPrefetch();
        };
        randomSeekRef.current = async (time: number) => {
          if (!transmuxer.ready) {
            pendingSeekTime = time;
            setPreview((state) => current(session, controller.signal) && state ? { ...state, stage: "buffering" } : state);
            return;
          }
          generation += 1;
          const seekGeneration = generation;
          requestedOffsets.clear();
          prefetchOffset = null;
          prefetchMode = "seek";
          prefetchBudget = 0;
          reachedEnd = false;
          for (const rangeAbort of rangeAbortRef.current) rangeAbort.abort();
          rangeAbortRef.current.clear();
          setPreview((state) => current(session, controller.signal) && state ? { ...state, stage: "replaying" } : state);
          const shouldResume = mediaElementRef.current ? !mediaElementRef.current.paused : false;
          const queuedSeek = seekQueue.catch(() => undefined).then(async () => {
            if (seekGeneration !== generation || !current(session, controller.signal)) return;
            const position = await transmuxer.seek(time);
            if (seekGeneration !== generation || !current(session, controller.signal)) return;
            const media = mediaElementRef.current;
            const loaded = await loadAt(position.offset, seekGeneration, mp4BootstrapBytes(randomReader.originalSize, position.offset));
            if (!loaded || seekGeneration !== generation || !current(session, controller.signal)) return;
            // Continue directly after the bytes returned for the target RAP.
            // Do not use parserNextOffset here: it tracks the initial scan,
            // which may be far earlier than this sought position.
            beginPrefetch(loaded.endOffset, mp4PreloadBytes(randomReader.originalSize, position.offset) - loaded.bytesRead, "seek");
            if (shouldResume && media && seekGeneration === generation && current(session, controller.signal)) {
              void media.play().catch(() => undefined);
            }
          });
          seekQueue = queuedSeek.catch(() => undefined);
          try {
            await queuedSeek;
          } catch (error) {
            await reportRangeFailure(error, seekGeneration);
          }
        };
        const initial = await loadAt(0, generation, mp4BootstrapBytes(randomReader.originalSize, 0));
        if (initial && !startPendingSeek()) {
          beginPrefetch(initial.parserNextOffset, mp4PreloadBytes(randomReader.originalSize, 0) - initial.bytesRead, "parser");
        }
        return;
      }

      const hasOpfs = encryptedPreviewDiskCacheEnabled
        && typeof (navigator.storage as unknown as { getDirectory?: unknown }).getDirectory === "function";
      if (hasOpfs) {
        const candidate = new MediaCache();
        try {
          await candidate.open(target.metaFileId);
          if (!current(session, controller.signal)) {
            await candidate.delete().catch(() => undefined);
            candidate.terminate();
            return;
          }
          cache = candidate;
          cacheRef.current = candidate;
          // OPFS holds decrypted plaintext. Do not keep an active preview's
          // cache beyond its documented TTL merely because the tab stays open.
          schedule(session, () => { void clearMediaCache(); }, 2 * 60 * 60 * 1000);
        } catch {
          // MSE itself is still usable without OPFS. Only disk-backed native
          // fallback and replay are unavailable in that browser/session.
          // `open` can create the file before discovering that sync access
          // handles are unavailable, so remove that candidate before ending
          // the worker. It must not become a stale plaintext cache entry.
          await candidate.delete().catch(() => undefined);
          candidate.terminate();
        }
      }
      const useTransmuxMp4 = canTransmuxMp4;
      const useMse = !!mseMime || useTransmuxMp4;
      if (!useMse && !cache) throw new Error("This file requires native playback, but temporary disk playback is unavailable. Use Download instead.");

      let mediaSource: MediaSource | null = null;
      let transmuxer: Mp4Transmuxer | null = null;
      let usingNative = !useMse;
      let transmuxPlayable = false;
      const switchToNativeFallback = async () => {
        if (!cache) throw new Error("The browser could not decode this media format. Use Download instead.");
        const activeTransmuxer = transmuxer;
        transmuxer = null;
        if (transmuxerRef.current === activeTransmuxer) transmuxerRef.current = null;
        activeTransmuxer?.dispose();
        usingNative = true;
        playbackModeRef.current = "native";
        mediaSourceRef.current = null;
        sourceBufferRef.current = null;
        setPreview((state) => current(session, controller.signal) && state ? { ...state, mediaUrl: null, stage: "buffering" } : state);
      };
      if (!usingNative) {
        mediaSource = new MediaSource();
        mediaSourceRef.current = mediaSource;
        const url = URL.createObjectURL(mediaSource);
        objectUrlRef.current = url;
        setPreview((state) => current(session, controller.signal) && state ? { ...state, mediaUrl: url } : state);
        if (useTransmuxMp4) {
          try {
            await waitForSourceOpen(mediaSource, controller.signal, () => undefined);
            transmuxer = createMp4Transmuxer(mediaSource, controller.signal, () => {
              if (!current(session, controller.signal) || playbackModeRef.current !== "transmux") return;
              transmuxPlayable = true;
              setPreview((state) => current(session, controller.signal) && state ? { ...state, stage: "playing" } : state);
            });
            transmuxerRef.current = transmuxer;
            playbackModeRef.current = "transmux";
          } catch {
            if (!current(session, controller.signal)) throw abortedError();
            await switchToNativeFallback();
          }
        } else if (mseMime) {
          await waitForSourceOpen(mediaSource, controller.signal, () => {
            if (!current(session, controller.signal)) throw abortedError();
            sourceBufferRef.current = mediaSource!.addSourceBuffer(mseMime);
          });
        }
      }
      if (!current(session, controller.signal)) return;
      setPreview((state) => current(session, controller.signal) && state ? { ...state, stage: usingNative ? "buffering" : "downloading" } : state);

      const response = await fetch(`/api/drive/payload/${encodeURIComponent(target.metaFileId)}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`Failed to fetch payload (HTTP ${response.status})`);
      const decrypted = await decryptPayloadStream(identity, response.body);
      const reader = decrypted.content.getReader();
      if (usingNative) playbackModeRef.current = "native";
      const publishNativeSnapshot = async () => {
        if (!current(session, controller.signal)) throw abortedError();
        if (!cache) throw new Error("This file needs native playback, but temporary disk playback is unavailable. Use Download instead.");
        const snapshot = await cache.snapshot();
        if (!current(session, controller.signal)) { await cache.releaseSnapshot(snapshot.key).catch(() => undefined); throw abortedError(); }
        const nextUrl = URL.createObjectURL(new Blob([snapshot.file], { type: mime }));
        const previousUrl = objectUrlRef.current;
        const previousSnapshot = snapshotKeyRef.current;
        playbackModeRef.current = "native";
        mediaSourceRef.current = null;
        sourceBufferRef.current = null;
        objectUrlRef.current = nextUrl;
        snapshotKeyRef.current = snapshot.key;
        setPreview((state) => current(session, controller.signal) && state ? { ...state, mediaUrl: nextUrl, stage: "playing" } : state);
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        if (previousSnapshot) await cache.releaseSnapshot(previousSnapshot).catch(() => undefined);
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (!current(session, controller.signal)) return;
          if (done) break;
          if (!value?.byteLength) continue;
          const offset = downloadedRef.current;
          if (cache) await cache.write(offset, value);
          if (!current(session, controller.signal)) return;
          downloadedRef.current += value.byteLength;
          if (!usingNative) {
            try {
              if (transmuxer) {
                transmuxer.append(value, offset);
                if (transmuxer.failed) throw transmuxer.failed;
              } else {
                const source = sourceBufferRef.current;
                if (!source) throw new Error("Streaming playback ended unexpectedly");
                await enqueueAppend(session, source, value, controller.signal);
              }
            } catch {
              if (!current(session, controller.signal)) return;
              appendStateRef.current = { session, promise: Promise.resolve() };
              transmuxer?.dispose();
              if (transmuxerRef.current === transmuxer) transmuxerRef.current = null;
              transmuxer = null;
              await switchToNativeFallback();
            }
          }
          setPreview((state) => current(session, controller.signal) && state ? { ...state, stage: usingNative ? "buffering" : transmuxer && !transmuxPlayable ? "downloading" : "playing", downloadedBytes: downloadedRef.current } : state);
        }
      } finally {
        reader.releaseLock();
      }
      let publishNativeAtEof = usingNative;
      if (!usingNative) {
        if (transmuxer) {
          try {
            await transmuxer.finish();
          } catch {
            if (!current(session, controller.signal)) return;
            transmuxer.dispose();
            if (transmuxerRef.current === transmuxer) transmuxerRef.current = null;
            transmuxer = null;
            await switchToNativeFallback();
            publishNativeAtEof = true;
          }
        } else {
          await appendStateRef.current.promise;
          if (current(session, controller.signal) && mediaSource?.readyState === "open") mediaSource.endOfStream();
        }
      }
      if (publishNativeAtEof) await publishNativeSnapshot();
      if (current(session, controller.signal)) setPreview((state) => state ? { ...state, stage: "complete", downloadedBytes: downloadedRef.current } : state);
    } catch (error) {
      if (!controller.signal.aborted) await fail(error);
    }
  }, [cancelTimers, clearMediaCache, current, disposeCurrent, encryptedPreviewDiskCacheEnabled, enqueueAppend, getPassphrase, schedule]);

  const setMediaElement = useCallback((element: HTMLMediaElement | null) => { mediaElementRef.current = element; }, []);

  const requestReplay = useCallback(async (time: number) => {
    const session = sessionRef.current;
    const controller = abortRef.current;
    if (!controller) return;
    if (playbackModeRef.current === "transmux") {
      await randomSeekRef.current?.(time);
      return;
    }
    const cache = cacheRef.current;
    if (!sourceBufferRef.current || !cache || downloadedRef.current === 0 || playbackModeRef.current !== "mse") return;
    const signal = controller.signal;
    const isCurrent = () => current(session, signal);
    setPreview((state) => isCurrent() && state ? { ...state, stage: "replaying" } : state);
    let replacedUrl: string | null = null;
    try {
      // A replay removes buffered media and then reads/appends the cache. It
      // must share the same queue as live appends; otherwise rapid seeks can
      // overlap remove(), cache reads, and appendBuffer() on one SourceBuffer.
      await enqueueSourceOperation(session, async () => {
        let source = sourceBufferRef.current;
        if (mediaSourceRef.current?.readyState === "ended") {
          const replacement = new MediaSource();
          const replacementUrl = URL.createObjectURL(replacement);
          replacedUrl = replacementUrl;
          const previousUrl = objectUrlRef.current;
          // Track the replacement before waiting for sourceopen so a close
          // can revoke it even if the event never fires.
          objectUrlRef.current = replacementUrl;
          if (previousUrl) URL.revokeObjectURL(previousUrl);
          setPreview((state) => isCurrent() && state ? { ...state, mediaUrl: replacementUrl } : state);
          await waitForSourceOpen(replacement, signal, () => {
            if (!isCurrent()) throw abortedError();
            const target = targetRef.current;
            const mime = target && mimeFor(target);
            const supported = mime && mimeCandidates(mime).find((candidate) => MediaSource.isTypeSupported(candidate));
            if (!supported) throw new Error("Media codec is not supported");
            sourceBufferRef.current = replacement.addSourceBuffer(supported);
            mediaSourceRef.current = replacement;
          });
          if (!isCurrent()) { URL.revokeObjectURL(replacementUrl); return; }
          source = sourceBufferRef.current;
        }
        if (!source || !isCurrent()) return;
        if (source.updating) await waitForUpdateEnd(source, signal);
        if (!isCurrent()) return;
        if (source.buffered.length) {
          source.remove(0, Number.POSITIVE_INFINITY);
          await waitForUpdateEnd(source, signal);
        }
        for (let offset = 0; offset < downloadedRef.current; offset += CHUNK) {
          if (!isCurrent()) return;
          const bytes = await cache.read(offset, Math.min(CHUNK, downloadedRef.current - offset));
          if (!isCurrent()) return;
          await appendBuffer(source, bytes, signal);
        }
      });
      if (!isCurrent()) return;
      const media = mediaElementRef.current;
      if (media) {
        const seek = () => { if (isCurrent()) media.currentTime = time; };
        media.addEventListener("loadedmetadata", seek, { once: true });
        schedule(session, seek);
      }
      setPreview((state) => isCurrent() && state ? { ...state, stage: "playing" } : state);
    } catch (error) {
      if (!isCurrent()) return;
      if (replacedUrl && objectUrlRef.current !== replacedUrl) URL.revokeObjectURL(replacedUrl);
      const url = objectUrlRef.current;
      const snapshotKey = snapshotKeyRef.current;
      objectUrlRef.current = null;
      snapshotKeyRef.current = null;
      mediaSourceRef.current = null;
      sourceBufferRef.current = null;
      cancelTimers(session);
      controller.abort();
      if (abortRef.current === controller) abortRef.current = null;
      if (url) URL.revokeObjectURL(url);
      if (snapshotKey) await cache.releaseSnapshot(snapshotKey).catch(() => undefined);
      await cache.delete().catch(() => undefined);
      cache.terminate();
      if (cacheRef.current === cache) cacheRef.current = null;
      if (sessionRef.current === session) setPreview((state) => state ? { ...state, stage: "failed", fallbackDownload: true, mediaUrl: null, error: error instanceof Error ? error.message : "Unable to replay cached media" } : state);
    }
  }, [cancelTimers, current, enqueueSourceOperation, schedule]);

  const closePreview = useCallback(async () => { await clearMediaCache(); }, [clearMediaCache]);
  return <PreviewContext.Provider value={{ preview, openPreview, closePreview, updateBufferedRanges, requestReplay, setMediaElement, clearMediaCache, encryptedPreviewDiskCacheEnabled, setEncryptedPreviewDiskCacheEnabled }}>
    {children}
    <MediaPreviewModal />
  </PreviewContext.Provider>;
}

export function useMediaPreview() {
  const context = useContext(PreviewContext);
  if (!context) throw new Error("useMediaPreview must be used within a MediaPreviewProvider");
  return context;
}
