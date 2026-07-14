"use client";

import { useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCrypto } from "@/hooks/use-crypto";
import type { ProgressiveMetaFile, DriveMetaFile } from "@/types";

interface UseMetaFilesResult {
  files: ProgressiveMetaFile[];
  isListLoading: boolean;   // Stage 1: fetching list from Drive
  isDecrypting: boolean;    // Stage 2: decrypting files in batches
  error: string | null;     // top-level error (list fetch failed etc.)
  refetch: () => void;
}

const DOWNLOAD_CONCURRENCY = 20;

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
    // Sort files to decrypt by createdTime descending (newest first)
    const filesToDecrypt = [...driveFiles].sort((a, b) => {
      const dateA = a.createdTime 
        ? new Date(a.createdTime).getTime() 
        : (a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0);
      const dateB = b.createdTime 
        ? new Date(b.createdTime).getTime() 
        : (b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0);
      return dateB - dateA;
    });

    // Worker pool setup: dynamically capped at number of logical CPU cores (between 2 and 10)
    const workerCount = Math.min(navigator.hardwareConcurrency || 2, 10);
    const workers: Worker[] = [];
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(new URL("../lib/decrypt.worker.ts", import.meta.url));
      workers.push(worker);
    }

    let nextJobIndex = 0;

    async function downloader() {
      // Map initial files to decrypt
      const currentFiles = queryClient.getQueryData<ProgressiveMetaFile[]>(decryptedQueryKey) || [];

      while (nextJobIndex < filesToDecrypt.length && !cancelled) {
        const index = nextJobIndex++;
        if (index >= filesToDecrypt.length) break;

        const file = filesToDecrypt[index];
        const match = currentFiles.find((f) => f.driveFile.id === file.id);
        if (match && match.decrypted) continue;

        try {
          // Fetch bytes on main thread (highly non-blocking I/O)
          const res = await fetch(`/api/drive/meta/${file.id}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bytes = new Uint8Array(await res.arrayBuffer());

          if (cancelled) break;

          // Delegate CPU heavy decryption to worker and await result
          const worker = workers[index % workerCount];
          const decrypted = await new Promise<{ success: boolean; result?: any; error?: string }>((resolve) => {
            let resolved = false;

            const cleanup = () => {
              worker.removeEventListener("message", handleMessage);
              worker.removeEventListener("error", handleError);
              clearTimeout(timeoutId);
            };

            const handleMessage = (e: MessageEvent) => {
              if (e.data.fileId === file.id) {
                cleanup();
                if (!resolved) {
                  resolved = true;
                  resolve(e.data);
                }
              }
            };

            const handleError = (e: ErrorEvent) => {
              cleanup();
              if (!resolved) {
                resolved = true;
                resolve({ success: false, error: e.message || "Worker error occurred" });
              }
            };

            const timeoutId = setTimeout(() => {
              cleanup();
              if (!resolved) {
                resolved = true;
                resolve({ success: false, error: "Decryption timeout" });
              }
            }, 30000); // 30s bounding timeout

            worker.addEventListener("message", handleMessage);
            worker.addEventListener("error", handleError);
            worker.postMessage({
              fileId: file.id,
              identity: passphrase!,
              encryptedData: bytes,
            }, [bytes.buffer]); // Transfer buffer (zero-copy transfer)
          });

          if (!cancelled) {
            // Update React state purely
            setFiles((prev) => {
              const updated = [...prev];
              const pos = updated.findIndex((f) => f.driveFile.id === file.id);
              if (pos !== -1) {
                if (decrypted.success) {
                  updated[pos] = {
                    ...updated[pos],
                    decrypted: true,
                    details: decrypted.result.details,
                    thumbnailBytes: decrypted.result.thumbnailBytes,
                    thumbnailMimeType: decrypted.result.thumbnailMimeType,
                  };
                } else {
                  updated[pos] = {
                    ...updated[pos],
                    decrypted: true,
                    decryptError: decrypted.error || "Decryption failed",
                  };
                }
              }
              return updated;
            });

            // Update React Query Cache independently outside of React state updaters
            queryClient.setQueryData<ProgressiveMetaFile[]>(decryptedQueryKey, (prev) => {
              if (!prev) return prev;
              const updated = [...prev];
              const pos = updated.findIndex((f) => f.driveFile.id === file.id);
              if (pos !== -1) {
                if (decrypted.success) {
                  updated[pos] = {
                    ...updated[pos],
                    decrypted: true,
                    details: decrypted.result.details,
                    thumbnailBytes: decrypted.result.thumbnailBytes,
                    thumbnailMimeType: decrypted.result.thumbnailMimeType,
                  };
                } else {
                  updated[pos] = {
                    ...updated[pos],
                    decrypted: true,
                    decryptError: decrypted.error || "Decryption failed",
                  };
                }
              }
              return updated;
            });
          }
        } catch (err) {
          if (!cancelled) {
            const msg = err instanceof Error ? err.message : "Decryption failed";

            // Update React state purely
            setFiles((prev) => {
              const updated = [...prev];
              const pos = updated.findIndex((f) => f.driveFile.id === file.id);
              if (pos !== -1) {
                updated[pos] = {
                  ...updated[pos],
                  decrypted: true,
                  decryptError: msg,
                };
              }
              return updated;
            });

            // Update React Query Cache independently outside of React state updaters
            queryClient.setQueryData<ProgressiveMetaFile[]>(decryptedQueryKey, (prev) => {
              if (!prev) return prev;
              const updated = [...prev];
              const pos = updated.findIndex((f) => f.driveFile.id === file.id);
              if (pos !== -1) {
                updated[pos] = {
                  ...updated[pos],
                  decrypted: true,
                  decryptError: msg,
                };
              }
              return updated;
            });
          }
        }
      }
    }

    async function processDecryption() {
      // Check if we already have decrypted files in cache for this folder
      const cached = queryClient.getQueryData<ProgressiveMetaFile[]>(decryptedQueryKey);
      if (cached && cached.length === filesToDecrypt.length && cached.every((f) => f.decrypted)) {
        setFiles(cached);
        setIsDecrypting(false);
        return;
      }

      // Reconcile cached files by ID before seeding
      const cachedById = new Map(cached?.map((file) => [file.driveFile.id, file]));
      const currentFiles = mapInitialFiles(filesToDecrypt).map(
        (file) => cachedById.get(file.driveFile.id) ?? file
      );

      setFiles(currentFiles);
      queryClient.setQueryData(decryptedQueryKey, currentFiles);

      const firstUndecryptedIdx = currentFiles.findIndex((f) => !f.decrypted);
      if (firstUndecryptedIdx === -1) {
        setIsDecrypting(false);
        return;
      }

      setIsDecrypting(true);
      setDecryptError(null);

      // Start DOWNLOAD_CONCURRENCY concurrent download routines
      const pool = Array.from({ length: DOWNLOAD_CONCURRENCY }).map(() => downloader());
      await Promise.all(pool);

      if (!cancelled) setIsDecrypting(false);
    }

    processDecryption();

    return () => {
      cancelled = true;
      workers.forEach((w) => w.terminate());
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
