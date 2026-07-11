"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { decryptMetaZip } from "@/lib/crypto";
import { useCrypto } from "@/hooks/use-crypto";
import type { DecryptedMeta, DriveMetaFile } from "@/types";

interface UseMetaFilesResult {
  files: DecryptedMeta[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

const BATCH_SIZE = 5;

async function fetchMetaList(folderId: string): Promise<DriveMetaFile[]> {
  const res = await fetch(`/api/drive/meta?folderId=${folderId}`);
  if (!res.ok) throw new Error(`Failed to list meta files: HTTP ${res.status}`);
  const data = await res.json();
  return data.files as DriveMetaFile[];
}

async function fetchAndDecrypt(
  file: DriveMetaFile,
  passphrase: string
): Promise<DecryptedMeta> {
  const res = await fetch(`/api/drive/meta/${file.id}`);
  if (!res.ok) throw new Error(`Failed to fetch ${file.name}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const { details, thumbnailUrl } = await decryptMetaZip(passphrase, bytes);
  const originalFileName = file.name.replace(/\.meta$/i, "");
  return { driveFile: file, details, thumbnailUrl, originalFileName };
}

async function batchProcess<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  batchSize: number
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

export function useMetaFiles(folderId: string): UseMetaFilesResult {
  const { hasPassphrase, getPassphrase } = useCrypto();
  const [files, setFiles] = useState<DecryptedMeta[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // Track blob URLs so we can revoke them when component unmounts or re-fetches
  const blobUrlsRef = useRef<string[]>([]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!folderId || !hasPassphrase) return;

    const passphrase = getPassphrase();
    if (!passphrase) return;

    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(null);

      // Revoke previous blob URLs before loading new ones
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current = [];
      setFiles([]);

      try {
        const metaList = await fetchMetaList(folderId);
        if (cancelled) return;

        if (metaList.length === 0) {
          setFiles([]);
          return;
        }

        const decrypted = await batchProcess(
          metaList,
          (file) => fetchAndDecrypt(file, passphrase!),
          BATCH_SIZE
        );

        if (!cancelled) {
          // Track blob URLs for cleanup
          blobUrlsRef.current = decrypted.map((d) => d.thumbnailUrl);

          setFiles(
            decrypted.sort((a, b) => {
              const dateA = a.details.date ?? a.driveFile.modifiedTime;
              const dateB = b.details.date ?? b.driveFile.modifiedTime;
              return dateB.localeCompare(dateA);
            })
          );
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unknown error");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
      // Revoke all blob URLs on unmount / dependency change
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current = [];
    };
  }, [folderId, hasPassphrase, getPassphrase, tick]);

  return {
    files: hasPassphrase ? files : [],
    isLoading: hasPassphrase ? isLoading : false,
    error,
    refetch,
  };
}
