"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MetaCard } from "@/components/meta-card";
import { MetaDetailModal } from "@/components/meta-detail-modal";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useCrypto } from "@/hooks/use-crypto";
import type { ProgressiveMetaFile, DecryptedMeta } from "@/types";
import { FileX, KeyRound, RotateCcw } from "lucide-react";
import { useSelection } from "@/components/selection-provider";

interface MetaGridProps {
  files: ProgressiveMetaFile[];
  isLoading: boolean; // Stage 1 generic loading (isListLoading)
  error: string | null;
  relativePath: string;
  /** If provided, overrides relativePath on a per-file basis (used in recursive/search views) */
  getRelativePath?: (file: ProgressiveMetaFile) => string;
}

const INITIAL_VISIBLE_ROWS = 3;
const VISIBLE_ROW_STEP = 3;

function getColumnCount(viewportWidth: number) {
  if (viewportWidth >= 1280) return 4;
  if (viewportWidth >= 1024) return 3;
  if (viewportWidth >= 640) return 2;
  return 1;
}

/** Detect age decryption failure (wrong passphrase), not format errors */
function isPassphraseError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("no identities succeeded") ||
    lower.includes("no identity matched") ||
    lower.includes("recipients") ||
    lower.includes("scrypt") ||
    lower.includes("wrong passphrase")
  );
}

function SkeletonCard() {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-white/8 bg-white/3">
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
        <div className="flex gap-1.5">
          <Skeleton className="h-4 w-14 rounded-full" />
          <Skeleton className="h-4 w-10 rounded-full" />
        </div>
      </div>
    </div>
  );
}

export function MetaGrid({ files, isLoading, error, relativePath, getRelativePath }: MetaGridProps) {
  const [selected, setSelected] = useState<DecryptedMeta | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth
  );
  const { clearPassphrase } = useCrypto();
  const { isSelectionMode, isFileSelected, toggleFileSelection } = useSelection();
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handleResize() {
      setViewportWidth(window.innerWidth);
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const columnCount = getColumnCount(viewportWidth);
  const visibleSetKey = useMemo(() => {
    const head = files.slice(0, 8).map((file) => file.driveFile.id).join("|");
    const tail = files.slice(-2).map((file) => file.driveFile.id).join("|");
    return `${files.length}::${head}::${tail}::${columnCount}`;
  }, [files, columnCount]);
  const [visibleState, setVisibleState] = useState({
    key: "",
    count: 0,
  });
  const initialVisibleCount = Math.max(INITIAL_VISIBLE_ROWS * columnCount, columnCount);
  const visibleCount =
    visibleState.key === visibleSetKey ? visibleState.count : initialVisibleCount;
  const clampedVisibleCount = Math.min(files.length, visibleCount);
  const visibleFiles = files.slice(0, clampedVisibleCount);
  const hasMore = clampedVisibleCount < files.length;

  useEffect(() => {
    if (!hasMore || !loadMoreRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;

        setVisibleState((prev) => {
          const nextBaseCount =
            prev.key === visibleSetKey ? prev.count : initialVisibleCount;
          const nextCount = Math.min(
            files.length,
            nextBaseCount + VISIBLE_ROW_STEP * columnCount
          );

          if (nextCount === nextBaseCount) return prev;
          return { key: visibleSetKey, count: nextCount };
        });
      },
      {
        rootMargin: "1200px 0px",
      }
    );

    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [columnCount, files.length, hasMore, initialVisibleCount, visibleSetKey]);

  const handleCardClick = (file: ProgressiveMetaFile) => {
    const fileId = file.driveFile.name.replace(".meta", "");
    if (isSelectionMode) {
      const resolvedPath = getRelativePath ? getRelativePath(file) : relativePath;
      toggleFileSelection({
        id: fileId,
        name: file.originalFileName,
        relativePath: resolvedPath,
      });
    } else {
      if (file.decrypted && file.details && !file.decryptError) {
        setSelected({
          driveFile: file.driveFile,
          details: file.details,
          thumbnailBytes: file.thumbnailBytes ?? null,
          thumbnailMimeType: file.thumbnailMimeType ?? null,
          originalFileName: file.originalFileName,
        });
      }
    }
  };

  if (error) {
    const passphraseErr = isPassphraseError(error);

    return (
      <div
        className={`flex flex-col items-center gap-4 rounded-xl border py-16 text-center ${
          passphraseErr
            ? "border-amber-500/20 bg-amber-500/5"
            : "border-destructive/20 bg-destructive/5"
        }`}
      >
        {passphraseErr ? (
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/15">
            <KeyRound className="h-6 w-6 text-amber-400" />
          </div>
        ) : (
          <FileX className="h-10 w-10 text-destructive/60" />
        )}

        <div className="flex flex-col gap-1">
          <p className={`font-medium ${passphraseErr ? "text-amber-400" : "text-destructive"}`}>
            {passphraseErr ? "Wrong passphrase" : "Failed to load files"}
          </p>
          <p className="text-sm text-muted-foreground">
            {passphraseErr
              ? "Decryption failed. The passphrase you entered doesn\u0027t match these files."
              : error}
          </p>
        </div>

        {passphraseErr && (
          <Button
            id="retry-passphrase-btn"
            variant="outline"
            size="sm"
            className="gap-2 border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
            onClick={() => clearPassphrase()}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Re-enter passphrase
          </Button>
        )}
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
          <p className="font-medium text-muted-foreground">No .meta files here</p>
          <p className="mt-1 text-sm text-muted-foreground/60">
            This folder doesn&apos;t contain any encrypted metadata files.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {visibleFiles.map((meta) => {
          const fileId = meta.driveFile.name.replace(".meta", "");
          return (
            <MetaCard
              key={meta.driveFile.id}
              meta={meta}
              isSelectionMode={isSelectionMode}
              isSelected={isFileSelected(fileId)}
              onClick={() => handleCardClick(meta)}
            />
          );
        })}
      </div>

      {hasMore && (
        <div ref={loadMoreRef} className="flex justify-center py-6">
          <p className="text-xs text-muted-foreground/60">
            Showing {clampedVisibleCount} of {files.length} files
          </p>
        </div>
      )}

      <MetaDetailModal
        meta={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
