"use client";

import { AlertCircle, Check, Download, Loader2 } from "lucide-react";
import { useFileDownload, type FileDownloadTarget } from "@/components/file-download-provider";

interface FileDownloadButtonProps {
  target: FileDownloadTarget;
  className?: string;
  showLabel?: boolean;
}

export function FileDownloadButton({
  target,
  className = "",
  showLabel = false,
}: FileDownloadButtonProps) {
  const { downloadItems, downloadFile } = useFileDownload();
  const item = downloadItems[target.metaFileId];
  const isActive = Boolean(item && !["complete", "failed"].includes(item.stage));

  async function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (isActive) return;

    try {
      await downloadFile(target);
    } catch {
      // The button status communicates failure and remains retryable.
    }
  }

  const label = isActive
    ? item?.stage === "resolving"
      ? "Preparing download"
      : item?.stage === "downloading"
        ? "Downloading"
        : "Decrypting and writing"
    : item?.stage === "complete"
      ? "Downloaded"
      : item?.stage === "failed"
        ? "Retry download"
        : "Download original file";

  return (
    <button
      type="button"
      onClick={handleClick}
      onKeyDown={(event) => event.stopPropagation()}
      disabled={isActive}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-black/60 text-xs font-medium text-white shadow-lg backdrop-blur-md transition-colors hover:border-violet-400/60 hover:bg-violet-600/80 disabled:cursor-wait ${
        item?.stage === "failed"
          ? "text-amber-300 hover:border-amber-400/60 hover:bg-amber-600/80"
          : ""
      } ${showLabel ? "h-9 px-3" : "h-8 w-8"} ${className}`}
    >
      {isActive ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : item?.stage === "complete" ? (
        <Check className="h-3.5 w-3.5" />
      ) : item?.stage === "failed" ? (
        <AlertCircle className="h-3.5 w-3.5" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
      {showLabel && <span>{label}</span>}
    </button>
  );
}
