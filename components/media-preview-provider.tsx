"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { decryptPayloadStream } from "@/lib/crypto";
import { MediaCache } from "@/lib/media-cache";
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
}
const PreviewContext = createContext<PreviewContextValue | null>(null);

const CHUNK = 1024 * 1024;
function mimeFor(target: MediaPreviewTarget) {
  if (target.mimeType?.startsWith("audio/") || target.mimeType?.startsWith("video/")) return target.mimeType;
  const ext = target.originalFileName.toLowerCase().split(".").pop();
  return ({ mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", weba: "audio/webm" } as Record<string, string>)[ext || ""];
}

export function MediaPreviewProvider({ children }: { children: React.ReactNode }) {
  const { getPassphrase, registerSensitiveCleanup } = useCrypto();
  const [preview, setPreview] = useState<MediaPreviewState | null>(null);
  const cacheRef = useRef<MediaCache | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const mediaElementRef = useRef<HTMLMediaElement | null>(null);
  const targetRef = useRef<MediaPreviewTarget | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const downloadedRef = useRef(0);
  const appendChainRef = useRef(Promise.resolve());

  const clearMediaCache = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    mediaSourceRef.current = null;
    sourceBufferRef.current = null;
    targetRef.current = null;
    downloadedRef.current = 0;
    if (cacheRef.current) {
      await cacheRef.current.delete().catch(() => undefined);
      cacheRef.current.terminate();
      cacheRef.current = null;
    }
    setPreview(null);
  }, []);

  useEffect(() => {
    const unregister = registerSensitiveCleanup(clearMediaCache);
    void MediaCache.purgeExpired();
    return unregister;
  }, [clearMediaCache, registerSensitiveCleanup]);

  const updateBufferedRanges = useCallback((ranges: Array<{ start: number; end: number }>) => {
    setPreview((current) => current ? { ...current, bufferedRanges: ranges } : current);
  }, []);

  const append = useCallback(async (bytes: Uint8Array) => {
    const source = sourceBufferRef.current;
    if (!source) return;
    appendChainRef.current = appendChainRef.current.then(() => new Promise<void>((resolve, reject) => {
      const finish = () => { source.removeEventListener("updateend", finish); source.removeEventListener("error", fail); resolve(); };
      const fail = () => { source.removeEventListener("updateend", finish); source.removeEventListener("error", fail); reject(new Error("The browser could not decode this media format.")); };
      source.addEventListener("updateend", finish, { once: true });
      source.addEventListener("error", fail, { once: true });
      try { source.appendBuffer(bytes as BufferSource); } catch (error) { fail(); reject(error instanceof Error ? error : new Error("Media append failed")); }
    }));
    return appendChainRef.current;
  }, []);

  const openPreview = useCallback(async (target: MediaPreviewTarget) => {
    await clearMediaCache();
    const mime = mimeFor(target);
    if (!mime || typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(mime) || !navigator.storage?.getDirectory) {
      setPreview({ target, stage: "failed", downloadedBytes: 0, expectedSize: target.expectedSize, bufferedRanges: [], mediaUrl: null, fallbackDownload: true, error: "This browser or media codec cannot preview this file. Use Download instead." });
      return;
    }
    const identity = getPassphrase();
    if (!identity) throw new Error("Enter your decryption passphrase first");
    const controller = new AbortController();
    abortRef.current = controller;
    const cache = new MediaCache();
    cacheRef.current = cache;
    targetRef.current = target;
    setPreview({ target, stage: "preparing", downloadedBytes: 0, expectedSize: target.expectedSize, bufferedRanges: [], mediaUrl: null, fallbackDownload: false });
    try {
      await cache.open(target.metaFileId);
      const mediaSource = new MediaSource();
      mediaSourceRef.current = mediaSource;
      const url = URL.createObjectURL(mediaSource);
      objectUrlRef.current = url;
      await new Promise<void>((resolve, reject) => {
        mediaSource.addEventListener("sourceopen", () => {
          try { sourceBufferRef.current = mediaSource.addSourceBuffer(mime); resolve(); } catch (error) { reject(error instanceof Error ? error : new Error("Media codec is not supported")); }
        }, { once: true });
      });
      setPreview((current) => current ? { ...current, stage: "downloading", mediaUrl: url } : current);
      const response = await fetch(`/api/drive/payload/${encodeURIComponent(target.metaFileId)}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`Failed to fetch payload (HTTP ${response.status})`);
      const decrypted = await decryptPayloadStream(identity, response.body);
      const reader = decrypted.content.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;
          const offset = downloadedRef.current;
          await cache.write(offset, value);
          downloadedRef.current += value.byteLength;
          await append(value);
          setPreview((current) => current ? { ...current, stage: "playing", downloadedBytes: downloadedRef.current } : current);
        }
      } finally { reader.releaseLock(); }
      await appendChainRef.current;
      if (mediaSource.readyState === "open") mediaSource.endOfStream();
      setPreview((current) => current ? { ...current, stage: "complete", downloadedBytes: downloadedRef.current } : current);
    } catch (error) {
      if (controller.signal.aborted) return;
      await cache.delete().catch(() => undefined);
      cache.terminate();
      if (cacheRef.current === cache) cacheRef.current = null;
      setPreview((current) => current ? { ...current, stage: "failed", fallbackDownload: true, error: error instanceof Error ? error.message : "Preview failed" } : current);
    }
  }, [append, clearMediaCache, getPassphrase]);

  const setMediaElement = useCallback((element: HTMLMediaElement | null) => { mediaElementRef.current = element; }, []);
  const requestReplay = useCallback(async (time: number) => {
    let source = sourceBufferRef.current;
    const cache = cacheRef.current;
    if (!source || !cache || downloadedRef.current === 0) return;
    setPreview((current) => current ? { ...current, stage: "replaying" } : current);
    if (mediaSourceRef.current?.readyState === "ended") {
      const replacement = new MediaSource();
      const replacementUrl = URL.createObjectURL(replacement);
      await new Promise<void>((resolve, reject) => {
        replacement.addEventListener("sourceopen", () => {
          try {
            const mime = targetRef.current && mimeFor(targetRef.current);
            if (!mime) throw new Error("Media codec is not supported");
            sourceBufferRef.current = replacement.addSourceBuffer(mime);
            mediaSourceRef.current = replacement;
            resolve();
          } catch (error) { reject(error instanceof Error ? error : new Error("Media codec is not supported")); }
        }, { once: true });
      });
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = replacementUrl;
      source = sourceBufferRef.current;
      setPreview((current) => current ? { ...current, mediaUrl: replacementUrl } : current);
    }
    if (!source) return;
    if (source.updating) await new Promise<void>((resolve) => source.addEventListener("updateend", () => resolve(), { once: true }));
    try {
      source.remove(0, Number.POSITIVE_INFINITY);
      if (source.updating) await new Promise<void>((resolve) => source.addEventListener("updateend", () => resolve(), { once: true }));
      appendChainRef.current = Promise.resolve();
      for (let offset = 0; offset < downloadedRef.current; offset += CHUNK) {
        await append(await cache.read(offset, Math.min(CHUNK, downloadedRef.current - offset)));
      }
      await appendChainRef.current;
      const media = mediaElementRef.current;
      if (media) {
        const seek = () => { media.currentTime = time; };
        media.addEventListener("loadedmetadata", seek, { once: true });
        window.setTimeout(seek, 0);
      }
      setPreview((current) => current ? { ...current, stage: "playing" } : current);
    } catch (error) {
      setPreview((current) => current ? { ...current, stage: "failed", error: error instanceof Error ? error.message : "Unable to replay cached media" } : current);
    }
  }, [append]);

  const closePreview = useCallback(async () => { await clearMediaCache(); }, [clearMediaCache]);
  return <PreviewContext.Provider value={{ preview, openPreview, closePreview, updateBufferedRanges, requestReplay, setMediaElement, clearMediaCache }}>
    {children}
    <MediaPreviewModal />
  </PreviewContext.Provider>;
}

export function useMediaPreview() {
  const context = useContext(PreviewContext);
  if (!context) throw new Error("useMediaPreview must be used within a MediaPreviewProvider");
  return context;
}
