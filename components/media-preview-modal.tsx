"use client";

import { useCallback, useEffect, useRef, useState, type RefCallback } from "react";
import { AudioLines, Loader2, ShieldCheck, Video, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useMediaPreview } from "@/components/media-preview-provider";
import { FileDownloadButton } from "@/components/file-download-button";

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function MediaPreviewModal() {
  const { preview, closePreview, updateBufferedRanges, requestReplay, setMediaElement } = useMediaPreview();
  const mediaRef = useRef<HTMLMediaElement>(null);
  const [mountedMedia, setMountedMedia] = useState<HTMLMediaElement | null>(null);
  const previewId = preview?.target.metaFileId;
  const isVideo = preview?.target.mimeType?.startsWith("video/") || /\.(mp4|m4v|webm|ogv|mov)$/i.test(preview?.target.originalFileName || "");
  const mediaCallbackRef = useCallback<RefCallback<HTMLMediaElement>>((element) => {
    mediaRef.current = element;
    setMountedMedia(element);
  }, []);

  useEffect(() => {
    const media = mountedMedia;
    if (!media || !previewId) return;
    setMediaElement(media);
    const sync = () => {
      const ranges = Array.from({ length: media.buffered.length }, (_, index) => ({ start: media.buffered.start(index), end: media.buffered.end(index) }));
      updateBufferedRanges(ranges);
    };
    media.addEventListener("progress", sync);
    media.addEventListener("timeupdate", sync);
    media.addEventListener("waiting", sync);
    return () => {
      media.removeEventListener("progress", sync);
      media.removeEventListener("timeupdate", sync);
      media.removeEventListener("waiting", sync);
      setMediaElement(null);
    };
  }, [mountedMedia, previewId, setMediaElement, updateBufferedRanges]);

  const content = preview && !preview.fallbackDownload && preview.mediaUrl ? (
    isVideo ? <video ref={mediaCallbackRef as RefCallback<HTMLVideoElement>} className="max-h-[76vh] w-full rounded-lg bg-black" src={preview.mediaUrl} controls playsInline preload="metadata" onSeeking={() => { const media = mediaRef.current; if (!media) return; const time = media.currentTime; for (let index = 0; index < media.buffered.length; index++) if (time >= media.buffered.start(index) && time <= media.buffered.end(index)) return; void requestReplay(time); }} />
      : <audio ref={mediaCallbackRef as RefCallback<HTMLAudioElement>} className="w-full" src={preview.mediaUrl} controls preload="metadata" onSeeking={() => { const media = mediaRef.current; if (!media) return; const time = media.currentTime; for (let index = 0; index < media.buffered.length; index++) if (time >= media.buffered.start(index) && time <= media.buffered.end(index)) return; void requestReplay(time); }} />
  ) : <div className="flex min-h-48 items-center justify-center rounded-lg border border-white/10 bg-black/30 p-6 text-center text-sm text-muted-foreground">{preview?.error || "Preparing preview…"}</div>;

  return <Dialog open={!!preview} onOpenChange={(open) => { if (!open) void closePreview(); }}>
    <DialogContent showCloseButton={false} className="max-h-[94vh] w-[98vw] max-w-[98vw] overflow-y-auto border-white/10 bg-[#0f0f13]/95 text-foreground sm:max-w-[min(98vw,120rem)]">
      {preview && <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 break-all font-mono text-sm">{isVideo ? <Video className="h-4 w-4 text-violet-400" /> : <AudioLines className="h-4 w-4 text-violet-400" />}{preview.target.displayName}</DialogTitle>
          <DialogDescription className="flex items-center gap-2 text-xs"><ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />Decrypted locally · temporary cache is removed on lock or expiry</DialogDescription>
        </DialogHeader>
        {content}
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">{(preview.stage === "downloading" || preview.stage === "buffering") && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{preview.stage} · {formatBytes(preview.downloadedBytes)}{preview.expectedSize ? ` / ${formatBytes(preview.expectedSize)}` : ""}</span>
          <div className="flex gap-2"><FileDownloadButton target={{ metaFileId: preview.target.metaFileId, fallbackName: preview.target.displayName, expectedSize: preview.expectedSize }} showLabel className="gap-1.5" /><Button variant="ghost" size="icon-sm" onClick={() => void closePreview()} aria-label="Close preview"><X className="h-4 w-4" /></Button></div>
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}
