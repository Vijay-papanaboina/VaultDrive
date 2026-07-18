"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCrypto } from "@/hooks/use-crypto";
import { fetchMetaList, fetchSubfolders } from "@/lib/drive-client";
import {
  createPendingMetaFile,
  createResolvedMetaFile,
  decryptWithWorker,
  DOWNLOAD_CONCURRENCY,
  markUndecryptedFilesStopped,
  replaceMetaFile,
  sortDriveFilesNewestFirst,
  upsertMetaFile,
} from "@/lib/meta-decryption";
import type { ProgressiveMetaFile, DriveMetaFile, DecryptionStatus } from "@/types";

interface UseRecursiveMetaFilesResult {
  files: ProgressiveMetaFile[];
  isCrawling: boolean;      // BFS tree walk phase
  isListLoading: boolean;   // Stage 1: fetching lists from Drive
  isDecrypting: boolean;    // Stage 2: decrypting files in batches
  error: string | null;
  refetch: () => void;
  cancelDecryption: () => void;
  /** Maps folderId -> full relative path (e.g. "DB-Backup/folder1/sub") */
  folderIdToPath: Record<string, string>;
}

export function useRecursiveMetaFiles(
  rootFolderId: string,
  rootFolderName?: string,
): UseRecursiveMetaFilesResult {
  const { hasPassphrase, getPassphrase } = useCrypto();
  const queryClient = useQueryClient();

  const [isCrawling, setIsCrawling] = useState(true);
  const [discoveredFolderIds, setDiscoveredFolderIds] = useState<string[]>([]);
  const [folderIdToPath, setFolderIdToPath] = useState<Record<string, string>>({});
  const [crawlerError, setCrawlerError] = useState<string | null>(null);

  const [files, setFiles] = useState<ProgressiveMetaFile[]>([]);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const cancelRequestedRef = useRef(false);
  const activeFetchesRef = useRef<Set<AbortController>>(new Set());
  const latestFilesRef = useRef<ProgressiveMetaFile[]>([]);

  useEffect(() => {
    latestFilesRef.current = files;
  }, [files]);

  // 1. BFS Recursive Tree Walk — also builds folderId→fullPath map during traversal
  useEffect(() => {
    if (!rootFolderId) return;

    let active = true;

    async function crawl() {
      setIsCrawling(true);
      setCrawlerError(null);

      const foundIds: string[] = [rootFolderId];
      const queue: string[] = [rootFolderId];
      const pathMap: Record<string, string> = {
        [rootFolderId]: rootFolderName || rootFolderId,
      };

      try {
        while (queue.length > 0) {
          if (!active) return;
          const currentId = queue.shift()!;
          const currentPath = pathMap[currentId];
          const subfolders = await fetchSubfolders(currentId);
          for (const sub of subfolders) {
            if (!foundIds.includes(sub.id)) {
              foundIds.push(sub.id);
              queue.push(sub.id);
              pathMap[sub.id] = `${currentPath}/${sub.name}`;
            }
          }
        }

        if (active) {
          setDiscoveredFolderIds(foundIds);
          setFolderIdToPath(pathMap);
          setIsCrawling(false);
        }
      } catch (err) {
        if (active) {
          setCrawlerError(err instanceof Error ? err.message : String(err));
          setIsCrawling(false);
        }
      }
    }

    crawl();
    return () => { active = false; };
  }, [rootFolderId, rootFolderName, refreshKey]);

  // 2. Fetch all meta file lists for all discovered folders in parallel
  const { data: driveFiles, error: listError, isLoading: isListLoading } = useQuery<
    (DriveMetaFile & { folderId: string })[]
  >({
    queryKey: ["recursive-meta-list", rootFolderId, discoveredFolderIds, refreshKey],
    queryFn: async () => {
      const promises = discoveredFolderIds.map(async (folderId) => {
        const fileList = await fetchMetaList(folderId);
        // Seed per-folder list cache so global search modal picks them up
        queryClient.setQueryData(["meta-list", folderId], fileList);
        return fileList.map((f) => ({ ...f, folderId }));
      });
      const results = await Promise.all(promises);
      return results.flat();
    },
    enabled: discoveredFolderIds.length > 0 && !isCrawling && hasPassphrase,
    staleTime: Infinity,
  });

  const refetch = useCallback(() => {
    cancelRequestedRef.current = false;
    setDecryptError(null);
    setCrawlerError(null);
    queryClient.removeQueries({ queryKey: ["recursive-meta-list", rootFolderId] });
    setDiscoveredFolderIds([]);
    setFolderIdToPath({});
    setRefreshKey((k) => k + 1);
  }, [queryClient, rootFolderId]);

  const cancelDecryption = useCallback(() => {
    cancelRequestedRef.current = true;
    activeFetchesRef.current.forEach((controller) => controller.abort());
    activeFetchesRef.current.clear();
    setIsDecrypting(false);

    const updated = markUndecryptedFilesStopped(latestFilesRef.current);
    latestFilesRef.current = updated;
    setFiles(updated);

    const byFolder = new Map<string, ProgressiveMetaFile[]>();
    for (const file of updated) {
      const folderId = (file.driveFile as DriveMetaFile & { folderId?: string }).folderId;
      if (!folderId) continue;
      const list = byFolder.get(folderId) ?? [];
      list.push(file);
      byFolder.set(folderId, list);
    }

    byFolder.forEach((folderFiles, folderId) => {
      queryClient.setQueryData<ProgressiveMetaFile[]>(["decrypted-folder", folderId], (prev) => {
        const merged = prev ? [...prev] : [];
        for (const file of folderFiles) {
          const pos = merged.findIndex((cached) => cached.driveFile.id === file.driveFile.id);
          if (pos !== -1) {
            merged[pos] = file;
          } else {
            merged.push(file);
          }
        }
        return merged;
      });
    });
  }, [queryClient]);

  // 3. Decryption — mirrors use-meta-files.ts exactly, adapted for multi-folder aggregated list
  useEffect(() => {
    if (!rootFolderId || !hasPassphrase || !driveFiles) return;

    const passphrase = getPassphrase();
    if (!passphrase) return;

    let cancelled = false;
    cancelRequestedRef.current = false;
    const activeFetches = activeFetchesRef.current;

    const filesToDecrypt = sortDriveFilesNewestFirst(driveFiles);

    const updateFileStatus = (fileId: string, folderId: string, status: DecryptionStatus) => {
      if (cancelled || cancelRequestedRef.current) return;
      setFiles((prev) => {
        const match = prev.find((f) => f.driveFile.id === fileId);
        if (!match) return prev;
        return replaceMetaFile(prev, fileId, { ...match, status });
      });
      queryClient.setQueryData<ProgressiveMetaFile[]>(["decrypted-folder", folderId], (prev) => {
        if (!prev) return prev;
        const match = prev.find((f) => f.driveFile.id === fileId);
        if (!match) return prev;
        return replaceMetaFile(prev, fileId, { ...match, status });
      });
    };

    // Worker pool: same sizing logic as use-meta-files.ts
    const workerCount = Math.min(navigator.hardwareConcurrency || 2, 10);
    const workers: Worker[] = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(new Worker(new URL("../lib/decrypt.worker.ts", import.meta.url)));
    }

    let nextJobIndex = 0;

    async function downloader() {
      while (
        nextJobIndex < filesToDecrypt.length &&
        !cancelled &&
        !cancelRequestedRef.current
      ) {
        const index = nextJobIndex++;
        if (index >= filesToDecrypt.length) break;

        const file = filesToDecrypt[index];
        const folderId = file.folderId;
        const decryptedQueryKey = ["decrypted-folder", folderId];

        // Check per-folder RQ cache — if already fully decrypted, just surface it
        const folderCached = queryClient.getQueryData<ProgressiveMetaFile[]>(decryptedQueryKey) || [];
        const match = folderCached.find((f) => f.driveFile.id === file.id);
        if (match && match.decrypted) {
          if (cancelled || cancelRequestedRef.current) break;
          setFiles((prev) => {
            const updated = [...prev];
            const pos = updated.findIndex((f) => f.driveFile.id === file.id);
            if (pos !== -1) {
              updated[pos] = { ...updated[pos], ...match };
            }
            return updated;
          });
          continue;
        }

        try {
          updateFileStatus(file.id, folderId, "downloading");

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

          updateFileStatus(file.id, folderId, "decrypting");

          const worker = workers[index % workerCount];
          const decrypted = await decryptWithWorker(
            worker,
            file.id,
            passphrase!,
            bytes
          );

          if (!cancelled && !cancelRequestedRef.current) {
            const nextFile = createResolvedMetaFile(file, decrypted);
            // Update React state for progressive card reveal — identical to original hook
            setFiles((prev) => replaceMetaFile(prev, file.id, nextFile));

            // Also write into per-folder RQ cache so normal folder view benefits
            queryClient.setQueryData<ProgressiveMetaFile[]>(decryptedQueryKey, (prev) => {
              return upsertMetaFile(prev ? prev : [], file.id, nextFile);
            });
          }
        } catch (err) {
          if (!cancelled && !cancelRequestedRef.current) {
            const msg = err instanceof Error ? err.message : "Decryption failed";
            const nextFile = createResolvedMetaFile(file, { success: false, error: msg });
            setFiles((prev) => replaceMetaFile(prev, file.id, nextFile));
            queryClient.setQueryData<ProgressiveMetaFile[]>(["decrypted-folder", folderId], (prev) => {
              return upsertMetaFile(prev ? prev : [], file.id, nextFile);
            });
          }
        }
      }
    }

    async function processDecryption() {
      // Check if all files already fully decrypted across all folders
      const allCachedDecrypted = filesToDecrypt.every((f) => {
        const cached = queryClient.getQueryData<ProgressiveMetaFile[]>(["decrypted-folder", f.folderId]) || [];
        const match = cached.find((c) => c.driveFile.id === f.id);
        return match?.decrypted;
      });

      // Seed initial state: use per-folder cache hits where available, skeleton otherwise
      const initialList: ProgressiveMetaFile[] = filesToDecrypt.map((f) => {
        const cached = queryClient.getQueryData<ProgressiveMetaFile[]>(["decrypted-folder", f.folderId]) || [];
        const match = cached.find((c) => c.driveFile.id === f.id);
        return match ?? createPendingMetaFile(f);
      });

      latestFilesRef.current = initialList;
      setFiles(initialList);

      if (allCachedDecrypted) {
        setIsDecrypting(false);
        return;
      }

      setIsDecrypting(true);
      setDecryptError(null);

      // Start 20 concurrent download+decrypt goroutines — same as original hook
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
  }, [driveFiles, hasPassphrase, getPassphrase, queryClient, refreshKey, rootFolderId]);

  const queryError = crawlerError || listError || decryptError;
  const errorMsg = queryError
    ? queryError instanceof Error ? queryError.message : String(queryError)
    : null;

  return {
    files: hasPassphrase ? files : [],
    isCrawling,
    isListLoading: hasPassphrase ? isListLoading : false,
    isDecrypting: hasPassphrase ? isDecrypting : false,
    error: errorMsg,
    refetch,
    cancelDecryption,
    folderIdToPath,
  };
}
