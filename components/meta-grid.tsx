"use client";

import { useState } from "react";
import { MetaCard } from "@/components/meta-card";
import { MetaDetailModal } from "@/components/meta-detail-modal";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useCrypto } from "@/hooks/use-crypto";
import type { ProgressiveMetaFile, DecryptedMeta } from "@/types";
import { FileX, KeyRound, RotateCcw } from "lucide-react";

interface MetaGridProps {
  files: ProgressiveMetaFile[];
  isLoading: boolean; // Stage 1 generic loading (isListLoading)
  error: string | null;
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

export function MetaGrid({ files, isLoading, error }: MetaGridProps) {
  const [selected, setSelected] = useState<DecryptedMeta | null>(null);
  const { clearPassphrase } = useCrypto();

  const handleCardClick = (file: ProgressiveMetaFile) => {
    if (file.decrypted && file.details && !file.decryptError) {
      setSelected({
        driveFile: file.driveFile,
        details: file.details,
        thumbnailBytes: file.thumbnailBytes ?? null,
        thumbnailMimeType: file.thumbnailMimeType ?? null,
        originalFileName: file.originalFileName,
      });
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
        {files.map((meta) => (
          <MetaCard
            key={meta.driveFile.id}
            meta={meta}
            onClick={() => handleCardClick(meta)}
          />
        ))}
      </div>

      <MetaDetailModal
        meta={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
