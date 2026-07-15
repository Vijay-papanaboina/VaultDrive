"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCrypto } from "@/hooks/use-crypto";
import { fetchMetaList } from "@/lib/drive-client";
import {
  createPendingMetaFile,
  createResolvedMetaFile,
  decryptWithWorker,
  DOWNLOAD_CONCURRENCY,
  markUndecryptedFilesStopped,
  replaceMetaFile,
  sortDriveFilesNewestFirst,
} from "@/lib/meta-decryption";
import type { ProgressiveMetaFile, DriveMetaFile } from "@/types";

interface UseMetaFilesResult {
  files: ProgressiveMetaFile[];
  isListLoading: boolean;   // Stage 1: fetching list from Drive
  isDecrypting: boolean;    // Stage 2: decrypting files in batches
  error: string | null;     // top-level error (list fetch failed etc.)
  refetch: () => void;
  cancelDecryption: () => void;
}

export function useMetaFiles(
  folderId: string,
  initialFiles?: DriveMetaFile[]
): UseMetaFilesResult {
  const { hasPassphrase, getPassphrase } = useCrypto();
  const queryClient = useQueryClient();

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
  const cancelRequestedRef = useRef(false);
  const activeFetchesRef = useRef<Set<AbortController>>(new Set());

  const refetch = useCallback(() => {
    cancelRequestedRef.current = false;
    setDecryptError(null);
    queryClient.removeQueries({ queryKey: ["meta-list", folderId] });
    queryClient.removeQueries({ queryKey: ["decrypted-folder", folderId] });
    setRefreshKey((k) => k + 1);
  }, [queryClient, folderId]);

  const cancelDecryption = useCallback(() => {
    cancelRequestedRef.current = true;
    activeFetchesRef.current.forEach((controller) => controller.abort());
    activeFetchesRef.current.clear();
    setIsDecrypting(false);

    const decryptedQueryKey = ["decrypted-folder", folderId];

    setFiles((prev) => markUndecryptedFilesStopped(prev));

    queryClient.setQueryData<ProgressiveMetaFile[]>(decryptedQueryKey, (prev) =>
      prev ? markUndecryptedFilesStopped(prev) : prev
    );
  }, [folderId, queryClient]);

  useEffect(() => {
    if (!folderId || !hasPassphrase || !driveFiles) return;

    const passphrase = getPassphrase();
    if (!passphrase) return;

    let cancelled = false;
    cancelRequestedRef.current = false;
    const activeFetches = activeFetchesRef.current;
    const decryptedQueryKey = ["decrypted-folder", folderId];
    const filesToDecrypt = sortDriveFilesNewestFirst(driveFiles);

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

      while (
        nextJobIndex < filesToDecrypt.length &&
        !cancelled &&
        !cancelRequestedRef.current
      ) {
        const index = nextJobIndex++;
        if (index >= filesToDecrypt.length) break;

        const file = filesToDecrypt[index];
        const match = currentFiles.find((f) => f.driveFile.id === file.id);
        if (match && match.decrypted) continue;

        try {
          // Fetch bytes on main thread (highly non-blocking I/O)
          const controller = new AbortController();
          activeFetches.add(controller);
          let bytes: Uint8Array;
          try {
            const res = await fetch(`/api/drive/meta/${file.id}`, {
              signal: controller.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            bytes = new Uint8Array(await res.arrayBuffer());
          } finally {
            activeFetches.delete(controller);
          }

          if (cancelled || cancelRequestedRef.current) break;

          // Delegate CPU heavy decryption to worker and await result
          const worker = workers[index % workerCount];
          const decrypted = await decryptWithWorker(
            worker,
            file.id,
            passphrase!,
            bytes
          );

          if (!cancelled && !cancelRequestedRef.current) {
            const nextFile = createResolvedMetaFile(file, decrypted);
            // Update React state purely
            setFiles((prev) => replaceMetaFile(prev, file.id, nextFile));

            // Update React Query Cache independently outside of React state updaters
            queryClient.setQueryData<ProgressiveMetaFile[]>(decryptedQueryKey, (prev) => {
              if (!prev) return prev;
              return replaceMetaFile(prev, file.id, nextFile);
            });
          }
        } catch (err) {
          if (!cancelled && !cancelRequestedRef.current) {
            const msg = err instanceof Error ? err.message : "Decryption failed";
            const nextFile: ProgressiveMetaFile = {
              ...createPendingMetaFile(file),
              decrypted: true,
              decryptError: msg,
            };

            // Update React state purely
            setFiles((prev) => replaceMetaFile(prev, file.id, nextFile));

            // Update React Query Cache independently outside of React state updaters
            queryClient.setQueryData<ProgressiveMetaFile[]>(decryptedQueryKey, (prev) => {
              if (!prev) return prev;
              return replaceMetaFile(prev, file.id, nextFile);
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
      const currentFiles = filesToDecrypt.map(createPendingMetaFile).map(
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

      if (!cancelled && !cancelRequestedRef.current) setIsDecrypting(false);
    }

    processDecryption();

    return () => {
      cancelled = true;
      activeFetches.forEach((controller) => controller.abort());
      activeFetches.clear();
      workers.forEach((w) => w.terminate());
    };
  }, [
    folderId,
    hasPassphrase,
    driveFiles,
    getPassphrase,
    queryClient,
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
    cancelDecryption,
  };
}
