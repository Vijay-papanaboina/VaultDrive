"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useFileDelete, type FileDeleteTarget } from "@/components/file-delete-provider";

interface FileDeleteButtonProps {
  target: FileDeleteTarget;
  showLabel?: boolean;
  className?: string;
}

export function FileDeleteButton({ target, showLabel = false, className = "" }: FileDeleteButtonProps) {
  const { requestDelete, isDeleting, isDeleted, isUploadActive } = useFileDelete();
  const metaFileId = target.driveFile.id;
  const deleting = isDeleting(metaFileId);
  const deleted = isDeleted(metaFileId);
  const activeUpload = isUploadActive(metaFileId);
  const disabled = deleting || deleted || activeUpload;
  const title = activeUpload
    ? "Finish or cancel the active upload before deleting this file"
    : deleted
      ? "This file pair is already in Trash"
      : deleting
        ? "Moving both files to Trash"
        : `Delete ${target.displayName}`;

  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-black/60 p-2 text-white backdrop-blur-sm transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${showLabel ? "px-3" : ""} ${className}`}
      aria-label={`Delete ${target.displayName}`}
      title={title}
      disabled={disabled}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!disabled) requestDelete(target);
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
      {showLabel && <span className="text-xs">Move to Trash</span>}
    </button>
  );
}
