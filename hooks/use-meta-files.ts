"use client";

import { useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { decryptMetaZip } from "@/lib/crypto";
import { useCrypto } from "@/hooks/use-crypto";
import type { ProgressiveMetaFile, DriveMetaFile } from "@/types";

interface UseMetaFilesResult {
  files: ProgressiveMetaFile[];
  isListLoading: boolean;   // Stage 1: fetching list from Drive
  isDecrypting: boolean;    // Stage 2: decrypting files in batches
  error: string | null;     // top-level error (list fetch failed etc.)
  refetch: () => void;
}

const BATCH_SIZE = 5;

async function fetchMetaList(folderId: string): Promise<DriveMetaFile[]> {
  const res = await fetch(`/api/drive/meta?folderId=${folderId}`);
  if (!res.ok) throw new Error(`Failed to list meta files: HTTP ${res.status}`);
  const data = await res.json();
  return data.files as DriveMetaFile[];
}

export function useMetaFiles(
  folderId: string,
  initialFiles?: DriveMetaFile[]
): UseMetaFilesResult {
  const { hasPassphrase, getPassphrase } = useCrypto();
  const queryClient = useQueryClient();

  // Helper to map raw GDrive file list to progressive loading card structure
  const mapInitialFiles = useCallback((rawFiles: DriveMetaFile[]): ProgressiveMetaFile[] => {
    return rawFiles.map((f) => ({
      driveFile: f,
      originalFileName: f.name.replace(/\.meta$/i, ""),
      decrypted: false,
    }));
  }, []);

  // Query 1: Fetch list of DriveMetaFile
  const { data: driveFiles, error: listError, isLoading: isListLoading } = useQuery<DriveMetaFile[]>({
    queryKey: ["meta-list", folderId],
    queryFn: () => fetchMetaList(folderId),
    enabled: !!folderId && hasPassphrase,
    initialData: initialFiles,
  });

  const [files, setFiles] = useState<ProgressiveMetaFile[]>([]);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refetch = useCallback(() => {
    setDecryptError(null);
    queryClient.removeQueries({ queryKey: ["meta-list", folderId] });
    queryClient.removeQueries({ queryKey: ["decrypted-folder", folderId] });
    setRefreshKey((k) => k + 1);
  }, [queryClient, folderId]);

  useEffect(() => {
    if (!folderId || !hasPassphrase || !driveFiles) return;

    const passphrase = getPassphrase();
    if (!passphrase) return;

    let cancelled = false;
    const decryptedQueryKey = ["decrypted-folder", folderId];
    const filesToDecrypt = driveFiles;

    async function processDecryption() {
      // Check if we already have decrypted files in cache for this folder
      const cached = queryClient.getQueryData<ProgressiveMetaFile[]>(decryptedQueryKey);
      if (cached && cached.length === filesToDecrypt.length && cached.every((f) => f.decrypted)) {
        setFiles(cached);
        setIsDecrypting(false);
        return;
      }

      // Initialize list (use cached if partially decrypted, otherwise map initial)
      const currentFiles = cached && cached.length === filesToDecrypt.length
        ? cached
        : mapInitialFiles(filesToDecrypt);

      setFiles(currentFiles);

      const firstUndecryptedIdx = currentFiles.findIndex((f) => !f.decrypted);
      if (firstUndecryptedIdx === -1) {
        setIsDecrypting(false);
        return;
      }

      setIsDecrypting(true);
      setDecryptError(null);

      // Decrypt in batches, starting from first undecrypted
      for (let i = 0; i < filesToDecrypt.length; i += BATCH_SIZE) {
        if (cancelled) break;

        const batch = filesToDecrypt.slice(i, i + BATCH_SIZE);
        const isBatchDecrypted = batch.every((file) => {
          const match = currentFiles.find((f) => f.driveFile.id === file.id);
          return match && match.decrypted;
        });
        if (isBatchDecrypted) continue;

        const results = await Promise.allSettled(
          batch.map(async (file) => {
            const res = await fetch(`/api/drive/meta/${file.id}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            return decryptMetaZip(passphrase!, bytes);
          })
        );

        if (cancelled) break;

        setFiles((prev) => {
          const updated = [...prev];
          results.forEach((result, idx) => {
            const fileId = batch[idx].id;
            const pos = updated.findIndex((f) => f.driveFile.id === fileId);
            if (pos === -1) return;

            if (result.status === "fulfilled") {
              const { details, thumbnailBytes, thumbnailMimeType } = result.value;
              updated[pos] = {
                ...updated[pos],
                decrypted: true,
                details,
                thumbnailBytes,
                thumbnailMimeType,
              };
            } else {
              const msg = result.reason instanceof Error
                ? result.reason.message
                : "Decryption failed";
              updated[pos] = {
                ...updated[pos],
                decrypted: true,
                decryptError: msg,
              };
            }
          });

          // Save progressive state to React Query Cache
          queryClient.setQueryData(decryptedQueryKey, updated);
          return updated;
        });
      }

      if (!cancelled) setIsDecrypting(false);
    }

    processDecryption();

    return () => {
      cancelled = true;
    };
  }, [
    folderId,
    hasPassphrase,
    driveFiles,
    getPassphrase,
    queryClient,
    mapInitialFiles,
    refreshKey,
  ]);

  const queryError = listError || decryptError;
  const errorMsg = queryError
    ? queryError instanceof Error ? queryError.message : String(queryError)
    : null;

  return {
    files: hasPassphrase ? files : [],
    isListLoading: hasPassphrase ? isListLoading : false,
    isDecrypting: hasPassphrase ? isDecrypting : false,
    error: errorMsg,
    refetch,
  };
}
