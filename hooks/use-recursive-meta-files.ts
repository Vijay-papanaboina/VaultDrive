"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCrypto } from "@/hooks/use-crypto";
import type { ProgressiveMetaFile, DriveMetaFile, DriveFolder, MetaDetails } from "@/types";

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

const DOWNLOAD_CONCURRENCY = 20;
const DECRYPTION_STOPPED_ERROR = "Decryption stopped";

async function fetchSubfolders(parentId: string): Promise<DriveFolder[]> {
  const params = new URLSearchParams({ parentId });
  const res = await fetch(`/api/drive/folders?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch folders");
  const data = await res.json();
  return data.folders as DriveFolder[];
}

async function fetchMetaList(folderId: string): Promise<DriveMetaFile[]> {
  const res = await fetch(`/api/drive/meta?folderId=${folderId}`);
  if (!res.ok) throw new Error(`Failed to list meta files: HTTP ${res.status}`);
  const data = await res.json();
  return data.files as DriveMetaFile[];
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

    const updated = latestFilesRef.current.map((file) =>
      file.decrypted
        ? file
        : {
            ...file,
            decrypted: true,
            decryptError: DECRYPTION_STOPPED_ERROR,
          }
    );
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

    // Sort newest first, same as the original hook
    const filesToDecrypt = [...driveFiles].sort((a, b) => {
      const dateA = a.createdTime
        ? new Date(a.createdTime).getTime()
        : (a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0);
      const dateB = b.createdTime
        ? new Date(b.createdTime).getTime()
        : (b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0);
      return dateB - dateA;
    });

    // Worker pool: same sizing logic as use-meta-files.ts
    const workerCount = Math.min(navigator.hardwareConcurrency || 2, 10);
    const workers: Worker[] = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(new Worker(new URL("../lib/decrypt.worker.ts", import.meta.url)));
    }

    let nextJobIndex = 0;

    // One downloader goroutine — 20 run in parallel via the pool below
    // Exactly mirrors the original use-meta-files.ts downloader() logic
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

          const worker = workers[index % workerCount];
          const decrypted = await new Promise<{
            success: boolean;
            result?: {
              details: MetaDetails;
              thumbnailBytes?: Uint8Array | null;
              thumbnailMimeType?: string | null;
            };
            error?: string;
          }>((resolve) => {
            let resolved = false;

            const cleanup = () => {
              worker.removeEventListener("message", handleMessage);
              worker.removeEventListener("error", handleError);
              clearTimeout(timeoutId);
            };

            const handleMessage = (e: MessageEvent) => {
              if (e.data.fileId === file.id) {
                cleanup();
                if (!resolved) { resolved = true; resolve(e.data); }
              }
            };

            const handleError = (e: ErrorEvent) => {
              cleanup();
              if (!resolved) {
                resolved = true;
                resolve({ success: false, error: e.message || "Worker error" });
              }
            };

            const timeoutId = setTimeout(() => {
              cleanup();
              if (!resolved) {
                resolved = true;
                resolve({ success: false, error: "Decryption timeout" });
              }
            }, 30000);

            worker.addEventListener("message", handleMessage);
            worker.addEventListener("error", handleError);
            worker.postMessage(
              { fileId: file.id, identity: passphrase!, encryptedData: bytes },
              [bytes.buffer] // zero-copy transfer
            );
          });

          if (!cancelled && !cancelRequestedRef.current) {
            // Update React state for progressive card reveal — identical to original hook
            setFiles((prev) => {
              const updated = [...prev];
              const pos = updated.findIndex((f) => f.driveFile.id === file.id);
              if (pos !== -1) {
                if (decrypted.success && decrypted.result) {
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

            // Also write into per-folder RQ cache so normal folder view benefits
            queryClient.setQueryData<ProgressiveMetaFile[]>(decryptedQueryKey, (prev) => {
              const list = prev ? [...prev] : [];
              const pos = list.findIndex((f) => f.driveFile.id === file.id);
              const entry: ProgressiveMetaFile = decrypted.success && decrypted.result
                ? {
                    driveFile: file,
                    originalFileName: file.name.replace(/\.meta$/i, ""),
                    decrypted: true,
                    details: decrypted.result.details,
                    thumbnailBytes: decrypted.result.thumbnailBytes ?? null,
                    thumbnailMimeType: decrypted.result.thumbnailMimeType ?? null,
                  }
                : {
                    driveFile: file,
                    originalFileName: file.name.replace(/\.meta$/i, ""),
                    decrypted: true,
                    decryptError: decrypted.error || "Decryption failed",
                  };
              if (pos !== -1) { list[pos] = entry; } else { list.push(entry); }
              return list;
            });
          }
        } catch (err) {
          if (!cancelled && !cancelRequestedRef.current) {
            const msg = err instanceof Error ? err.message : "Decryption failed";
            setFiles((prev) => {
              const updated = [...prev];
              const pos = updated.findIndex((f) => f.driveFile.id === file.id);
              if (pos !== -1) {
                updated[pos] = { ...updated[pos], decrypted: true, decryptError: msg };
              }
              return updated;
            });
            queryClient.setQueryData<ProgressiveMetaFile[]>(["decrypted-folder", folderId], (prev) => {
              const list = prev ? [...prev] : [];
              const pos = list.findIndex((f) => f.driveFile.id === file.id);
              const entry: ProgressiveMetaFile = {
                driveFile: file,
                originalFileName: file.name.replace(/\.meta$/i, ""),
                decrypted: true,
                decryptError: msg,
              };
              if (pos !== -1) { list[pos] = entry; } else { list.push(entry); }
              return list;
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
        return match ?? {
          driveFile: f,
          originalFileName: f.name.replace(/\.meta$/i, ""),
          decrypted: false,
        };
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
