"use client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { DecryptedMeta } from "@/types";
import { Calendar, FileText, HardDrive, Tag } from "lucide-react";

interface MetaCardProps {
  meta: DecryptedMeta;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
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

export function MetaCard({ meta }: MetaCardProps) {
  const { content, originalFileName, driveFile } = meta;

  return (
    <Card
      id={`meta-card-${driveFile.id}`}
      className="group flex flex-col overflow-hidden border-white/8 bg-white/3 backdrop-blur-sm transition-all duration-200 hover:border-violet-500/30 hover:bg-white/5 hover:shadow-lg hover:shadow-violet-500/5"
    >
      {/* Thumbnail */}
      <div className="relative aspect-video w-full overflow-hidden bg-white/5">
        {content.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={content.thumbnail}
            alt={`Thumbnail for ${originalFileName}`}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <FileText className="h-10 w-10 text-muted-foreground/30" />
          </div>
        )}
        {/* Gradient overlay on hover */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col gap-3 p-4">
        {/* Filename */}
        <div>
          <h3
            className="line-clamp-1 font-mono text-sm font-medium text-foreground"
            title={originalFileName}
          >
            {originalFileName}
          </h3>
          {content.name !== originalFileName && (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              {content.name}
            </p>
          )}
        </div>

        {/* Description */}
        {content.description && (
          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {content.description}
          </p>
        )}

        {/* Meta row */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {content.date && (
            <span className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              {formatDate(content.date)}
            </span>
          )}
          {driveFile.size && (
            <span className="flex items-center gap-1">
              <HardDrive className="h-3 w-3" />
              {formatBytes(Number(driveFile.size))}
            </span>
          )}
        </div>

        {/* Extra fields */}
        {content.extra && Object.keys(content.extra).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <Tag className="h-3 w-3 shrink-0 self-center text-muted-foreground" />
            {Object.entries(content.extra).map(([k, v]) => (
              <Badge
                key={k}
                variant="secondary"
                className="h-5 rounded-full px-2 text-xs font-normal"
                title={`${k}: ${String(v)}`}
              >
                {String(v)}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
