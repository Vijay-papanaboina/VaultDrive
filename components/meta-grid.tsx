"use client";

import { MetaCard } from "@/components/meta-card";
import { Skeleton } from "@/components/ui/skeleton";
import type { DecryptedMeta } from "@/types";
import { FileX } from "lucide-react";

interface MetaGridProps {
  files: DecryptedMeta[];
  isLoading: boolean;
  error: string | null;
}

function SkeletonCard() {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-white/8 bg-white/3">
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-12 rounded-full" />
        </div>
      </div>
    </div>
  );
}

export function MetaGrid({ files, isLoading, error }: MetaGridProps) {
  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/5 py-16 text-center">
        <FileX className="h-10 w-10 text-destructive/60" />
        <div>
          <p className="font-medium text-destructive">Failed to load files</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-white/8 bg-white/3 py-16 text-center">
        <FileX className="h-10 w-10 text-muted-foreground/40" />
        <div>
          <p className="font-medium text-muted-foreground">
            No .meta files here
          </p>
          <p className="mt-1 text-sm text-muted-foreground/60">
            This folder doesn&apos;t contain any encrypted metadata files.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {files.map((meta) => (
        <MetaCard key={meta.driveFile.id} meta={meta} />
      ))}
    </div>
  );
}
