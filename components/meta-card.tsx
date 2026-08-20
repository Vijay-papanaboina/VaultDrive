"use client";

import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FileDownloadButton } from "@/components/file-download-button";
import type { ProgressiveMetaFile } from "@/types";
import {
  Calendar,
  HardDrive,
  ShieldAlert,
  Check,
  Loader2,
  FileText,
} from "lucide-react";

interface MetaCardProps {
  meta: ProgressiveMetaFile;
  onClick: () => void;
  isSelectionMode?: boolean;
  isSelected?: boolean;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return "—";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export const MetaCard = memo(
  function MetaCard({
    meta,
    onClick,
    isSelectionMode = false,
    isSelected = false,
  }: MetaCardProps) {
    const {
      driveFile,
      originalFileName,
      decrypted,
      details,
      thumbnailUrl,
      decryptError,
    } = meta;

    const isClickable = isSelectionMode || (decrypted && !decryptError);

    return (
      <Card
        id={`meta-card-${driveFile.id}`}
        role={isClickable ? "button" : undefined}
        tabIndex={isClickable ? 0 : undefined}
        onClick={isClickable ? onClick : undefined}
        onKeyDown={(e) => {
          if (isClickable && (e.key === "Enter" || e.key === " ")) {
            onClick();
          }
        }}
        className={`group flex flex-col overflow-hidden transition-all duration-200 ${
          isClickable
            ? "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            : "pointer-events-none select-none"
        } ${
          isSelected
            ? "border-violet-500 bg-violet-600/5 shadow-md shadow-violet-500/5"
            : "border-white/8 bg-white/3 hover:border-violet-500/30 hover:bg-white/5 hover:shadow-lg hover:shadow-violet-500/5"
        }`}
      >
        {/* Thumbnail or Skeleton/Error */}
        <div className="relative aspect-video w-full overflow-hidden bg-black/30">
          {/* Selection Checkbox Overlay */}
          {isSelectionMode && (
            <div className="absolute left-2.5 top-2.5 z-10">
              <div
                className={`flex h-5 w-5 items-center justify-center rounded-full border transition-all ${
                  isSelected
                    ? "bg-violet-500 border-violet-500 text-white"
                    : "bg-black/40 border-white/30 group-hover:border-white/50 text-transparent"
                }`}
              >
                <Check className="h-3 w-3 stroke-[3]" />
              </div>
            </div>
          )}

          {decrypted && !decryptError && (
            <FileDownloadButton
              target={{
                metaFileId: driveFile.id,
                fallbackName: details?.name ?? originalFileName,
                expectedSize:
                  details?.extra?.size_bytes !== undefined
                    ? Number(details.extra.size_bytes)
                    : Number(driveFile.size),
              }}
              className="absolute right-2.5 top-2.5 z-10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            />
          )}

          {meta.status === "pending" || meta.status === "downloading" ? (
            <Skeleton className="h-full w-full rounded-none" />
          ) : meta.status === "decrypting" ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-white/3 text-muted-foreground p-4">
              <Loader2 className="h-10 w-10 text-violet-500 animate-spin" />
              <span className="text-[10px] font-medium uppercase tracking-wider text-violet-500/80">
                Decrypting...
              </span>
            </div>
          ) : decryptError ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-destructive/5 text-destructive p-4">
              <ShieldAlert className="h-8 w-8 text-destructive/60" />
              <span className="text-[10px] font-medium uppercase tracking-wider text-destructive/80">
                Decryption failed
              </span>
            </div>
          ) : thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbnailUrl}
              alt={`Thumbnail for ${originalFileName}`}
              // loading="eager"
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            />
          ) : (
            // Decrypted file with no thumbnail at all: show generic file icon
            <div className="flex h-full w-full items-center justify-center">
              <FileText className="h-10 w-10 text-muted-foreground/30" />
            </div>
          )}

          {/* Hover overlay — only show if clickable */}
          {isClickable && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
              <span className="rounded-full border border-white/30 bg-black/50 px-3 py-1 text-xs font-medium text-white backdrop-blur-sm">
                {isSelectionMode
                  ? isSelected
                    ? "Deselect file"
                    : "Select file"
                  : "View details"}
              </span>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex flex-1 flex-col gap-2.5 p-3">
          {/* Filename */}
          <h3
            className="truncate font-mono text-xs font-medium text-foreground"
            title={
              details?.name
                ? `${originalFileName} ${details.name}`
                : originalFileName
            }
          >
            {originalFileName}
            {details?.name && (
              <span className="text-muted-foreground ml-1.5">
                {details.name}
              </span>
            )}
          </h3>

          {meta.status === "pending" || meta.status === "downloading" ? (
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
            </div>
          ) : meta.status === "decrypting" ? (
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground/60 animate-pulse">
              Extracting metadata zip...
            </p>
          ) : decryptError ? (
            <p className="line-clamp-2 text-[11px] leading-relaxed text-destructive/70">
              {decryptError}
            </p>
          ) : details?.description ? (
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {details.description}
            </p>
          ) : (
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground/40 italic">
              No description provided.
            </p>
          )}

          {/* Meta row — size and modified date are unencrypted on GDrive, show immediately! */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              {formatDate(details?.date ?? driveFile.modifiedTime)}
            </span>
            {(driveFile.size ||
              (decrypted && details?.extra?.size_bytes !== undefined)) && (
              <span className="flex items-center gap-1">
                <HardDrive className="h-3 w-3" />
                {formatBytes(
                  decrypted && details?.extra?.size_bytes !== undefined
                    ? Number(details.extra.size_bytes)
                    : Number(driveFile.size),
                )}
              </span>
            )}
          </div>

          {/* Extra badges */}
          {!decrypted ? (
            <div className="flex gap-1.5 mt-0.5">
              <Skeleton className="h-4 w-12 rounded-full" />
              <Skeleton className="h-4 w-16 rounded-full" />
            </div>
          ) : details?.extra &&
            Object.keys(details.extra).filter((k) => k !== "size_bytes")
              .length > 0 ? (
            (() => {
              const extraEntries = Object.entries(details.extra).filter(
                ([k]) => k !== "size_bytes",
              );
              return (
                <div className="flex flex-wrap gap-1">
                  {extraEntries.slice(0, 3).map(([k, v]) => (
                    <Badge
                      key={k}
                      variant="secondary"
                      className="h-4 rounded-full px-1.5 text-xs font-normal"
                      title={`${k}: ${String(v)}`}
                    >
                      {String(v)}
                    </Badge>
                  ))}
                  {extraEntries.length > 3 && (
                    <Badge
                      variant="secondary"
                      className="h-4 rounded-full px-1.5 text-xs font-normal"
                    >
                      +{extraEntries.length - 3}
                    </Badge>
                  )}
                </div>
              );
            })()
          ) : null}
        </div>
      </Card>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.isSelectionMode === nextProps.isSelectionMode &&
      prevProps.isSelected === nextProps.isSelected &&
      prevProps.meta === nextProps.meta
    );
  },
);
