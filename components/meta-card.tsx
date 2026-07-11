"use client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { DecryptedMeta } from "@/types";
import { Calendar, HardDrive } from "lucide-react";

interface MetaCardProps {
  meta: DecryptedMeta;
  onClick: () => void;
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

export function MetaCard({ meta, onClick }: MetaCardProps) {
  const { details, thumbnailUrl, originalFileName, driveFile } = meta;

  return (
    <Card
      id={`meta-card-${driveFile.id}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(); }}
      className="group flex cursor-pointer flex-col overflow-hidden border-white/8 bg-white/3 backdrop-blur-sm transition-all duration-200 hover:border-violet-500/30 hover:bg-white/5 hover:shadow-lg hover:shadow-violet-500/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* Thumbnail */}
      <div className="relative aspect-video w-full overflow-hidden bg-black/30">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbnailUrl}
          alt={`Thumbnail for ${originalFileName}`}
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
        {/* Hover overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="rounded-full border border-white/30 bg-black/50 px-3 py-1 text-xs font-medium text-white backdrop-blur-sm">
            View details
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col gap-2 p-3">
        {/* Filename */}
        <h3
          className="line-clamp-1 font-mono text-xs font-medium text-foreground"
          title={originalFileName}
        >
          {originalFileName}
        </h3>

        {/* Description */}
        {details.description && (
          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {details.description}
          </p>
        )}

        {/* Meta row */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {details.date && (
            <span className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              {formatDate(details.date)}
            </span>
          )}
          {driveFile.size && (
            <span className="flex items-center gap-1">
              <HardDrive className="h-3 w-3" />
              {formatBytes(Number(driveFile.size))}
            </span>
          )}
        </div>

        {/* Extra badges */}
        {details.extra && Object.keys(details.extra).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {Object.entries(details.extra)
              .slice(0, 3)
              .map(([k, v]) => (
                <Badge
                  key={k}
                  variant="secondary"
                  className="h-4 rounded-full px-1.5 text-xs font-normal"
                  title={`${k}: ${String(v)}`}
                >
                  {String(v)}
                </Badge>
              ))}
            {Object.keys(details.extra).length > 3 && (
              <Badge variant="secondary" className="h-4 rounded-full px-1.5 text-xs font-normal">
                +{Object.keys(details.extra).length - 3}
              </Badge>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
