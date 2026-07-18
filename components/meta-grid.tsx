"use client";

import { useMemo, useRef, useState } from "react";
import { MetaCard } from "@/components/meta-card";
import { MetaDetailModal } from "@/components/meta-detail-modal";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useCrypto } from "@/hooks/use-crypto";
import type { ProgressiveMetaFile, DecryptedMeta } from "@/types";
import { ChevronLeft, ChevronRight, FileX, KeyRound, RotateCcw } from "lucide-react";
import { useSelection } from "@/components/selection-provider";

interface MetaGridProps {
  files: ProgressiveMetaFile[];
  isLoading: boolean; // Stage 1 generic loading (isListLoading)
  error: string | null;
  relativePath: string;
  /** If provided, overrides relativePath on a per-file basis (used in recursive/search views) */
  getRelativePath?: (file: ProgressiveMetaFile) => string;
}

const PAGE_SIZE = 32;

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

interface PaginationControlsProps {
  page: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  totalFiles: number;
  onChange: (p: number) => void;
}

function PaginationControls({ page, totalPages, startIndex, endIndex, totalFiles, onChange }: PaginationControlsProps) {
  if (totalPages <= 1) return null;

  const pageNumbers: (number | "…")[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pageNumbers.push(i);
  } else if (page <= 4) {
    pageNumbers.push(1, 2, 3, 4, 5, "…", totalPages);
  } else if (page >= totalPages - 3) {
    pageNumbers.push(1, "…", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
  } else {
    pageNumbers.push(1, "…", page - 1, page, page + 1, "…", totalPages);
  }

  const btnBase = "flex h-7 min-w-7 items-center justify-center rounded-lg px-2 text-xs font-medium transition-colors";

  return (
    <div className="flex items-center justify-between border-t border-white/8 pt-4">
      <p className="text-xs text-muted-foreground">
        {startIndex + 1}–{endIndex} of {totalFiles}
      </p>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onChange(page - 1)}
          disabled={page === 1}
          className={`${btnBase} border border-white/10 bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-30`}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>

        {pageNumbers.map((p, i) =>
          p === "…" ? (
            <span key={`ellipsis-${i}`} className="flex h-7 w-6 items-center justify-center text-xs text-muted-foreground/50">
              …
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onChange(p as number)}
              className={`${btnBase} ${
                page === p
                  ? "bg-violet-600 text-white shadow-lg shadow-violet-600/20"
                  : "border border-white/10 bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
              }`}
            >
              {p}
            </button>
          )
        )}

        <button
          onClick={() => onChange(page + 1)}
          disabled={page === totalPages}
          className={`${btnBase} border border-white/10 bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-30`}
          aria-label="Next page"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function MetaGrid({ files, isLoading, error, relativePath, getRelativePath }: MetaGridProps) {
  const [selected, setSelected] = useState<DecryptedMeta | null>(null);
  const [page, setPage] = useState(1);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const { clearPassphrase } = useCrypto();
  const { isSelectionMode, isFileSelected, toggleFileSelection } = useSelection();

  // Detect when the file set identity changes (sort/filter/search changes the head IDs or count).
  // replaceMetaFile keeps IDs/order/length stable during decryption, so this only fires on real set changes.
  const filesKey = useMemo(() => {
    const head = files.slice(0, 4).map((f) => f.driveFile.id).join("|");
    return `${files.length}::${head}`;
  }, [files]);

  // Reset page during render when the file set changes (React's recommended pattern for
  // adjusting state on prop change — avoids the extra render cycle of useEffect).
  // See: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevFilesKey, setPrevFilesKey] = useState(filesKey);
  if (prevFilesKey !== filesKey) {
    setPrevFilesKey(filesKey);
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(files.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const startIndex = (safePage - 1) * PAGE_SIZE;
  const endIndex = Math.min(startIndex + PAGE_SIZE, files.length);
  const pagedFiles = files.slice(startIndex, endIndex);

  function handlePageChange(nextPage: number) {
    setPage(nextPage);
    gridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

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
              ? "Decryption failed. The passphrase you entered doesn't match these files."
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
      <div ref={gridRef} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {pagedFiles.map((meta) => {
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

      <PaginationControls
        page={safePage}
        totalPages={totalPages}
        startIndex={startIndex}
        endIndex={endIndex}
        totalFiles={files.length}
        onChange={handlePageChange}
      />

      <MetaDetailModal
        meta={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
