"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { DecryptedMeta } from "@/types";
import { Calendar, FileText, HardDrive, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface MetaDetailModalProps {
  meta: DecryptedMeta | null;
  onClose: () => void;
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
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function MetaDetailModal({ meta, onClose }: MetaDetailModalProps) {
  if (!meta) return null;

  const { details, thumbnailUrl, originalFileName, driveFile } = meta;

  return (
    <Dialog open={!!meta} onOpenChange={(open, _event) => { if (!open) onClose(); }}>
      <DialogContent
        id="meta-detail-modal"
        className="max-h-[90vh] w-full max-w-2xl overflow-hidden p-0"
      >
        {/* Large thumbnail */}
        <div className="relative aspect-video w-full overflow-hidden bg-black/40">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbnailUrl}
            alt={`Preview of ${originalFileName}`}
            className="h-full w-full object-contain"
          />
          {/* Close button overlay */}
          <Button
            id="meta-modal-close"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            className="absolute right-3 top-3 rounded-full bg-black/50 text-white backdrop-blur-sm hover:bg-black/70"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Details */}
        <div className="flex flex-col gap-4 overflow-y-auto p-5">
          <DialogHeader>
            <DialogTitle className="font-mono text-base">
              {originalFileName}
            </DialogTitle>
            {details.name !== originalFileName && (
              <DialogDescription>{details.name}</DialogDescription>
            )}
          </DialogHeader>

          {/* Description */}
          {details.description && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {details.description}
            </p>
          )}

          <Separator />

          {/* Metadata row */}
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            {details.date && (
              <div className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Calendar className="h-3 w-3" /> Date
                </span>
                <span className="text-foreground">{formatDate(details.date)}</span>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <HardDrive className="h-3 w-3" /> Drive size
              </span>
              <span className="text-foreground">
                {formatBytes(Number(driveFile.size))}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <FileText className="h-3 w-3" /> Modified
              </span>
              <span className="text-foreground">
                {formatDate(driveFile.modifiedTime)}
              </span>
            </div>
          </div>

          {/* Extra fields */}
          {details.extra && Object.keys(details.extra).length > 0 && (
            <>
              <Separator />
              <div className="flex flex-col gap-2">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Tag className="h-3 w-3" /> Extra metadata
                </span>
                <div className="rounded-lg border border-white/8 bg-white/3">
                  {Object.entries(details.extra).map(([k, v], i, arr) => (
                    <div
                      key={k}
                      className={`flex items-start justify-between gap-4 px-3 py-2 text-sm ${
                        i < arr.length - 1 ? "border-b border-white/6" : ""
                      }`}
                    >
                      <span className="text-muted-foreground">{k}</span>
                      <span className="text-right font-mono text-xs text-foreground">
                        {Array.isArray(v) ? (
                          <div className="flex flex-wrap justify-end gap-1">
                            {(v as unknown[]).map((item, idx) => (
                              <Badge key={idx} variant="secondary" className="h-5 rounded-full px-2 text-xs font-normal">
                                {String(item)}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          String(v)
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
