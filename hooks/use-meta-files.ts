"use client";

import { useState, useEffect, useCallback } from "react";
import { decryptMetaFile } from "@/lib/crypto";
import { useCrypto } from "@/hooks/use-crypto";
import type { DecryptedMeta, DriveMetaFile } from "@/types";

interface UseMetaFilesResult {
  files: DecryptedMeta[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

const BATCH_SIZE = 5; // decrypt N files in parallel

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
  const content = await decryptMetaFile(passphrase, bytes);
  const originalFileName = file.name.replace(/\.meta$/i, "");
  return { driveFile: file, content, originalFileName };
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

/**
 * Fetches and decrypts all .meta files in a folder.
 * Requires passphrase to be set in CryptoContext.
 * Returns empty array if no passphrase (caller should show password dialog).
 */
export function useMetaFiles(folderId: string): UseMetaFilesResult {
  const { hasPassphrase, getPassphrase } = useCrypto();
  const [files, setFiles] = useState<DecryptedMeta[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    // Early exit without setState — derived values handle the empty state
    if (!folderId || !hasPassphrase) return;

    const passphrase = getPassphrase();
    if (!passphrase) return;

    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(null);
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
          // Sort by date descending if available, otherwise by Drive modifiedTime
          setFiles(
            decrypted.sort((a, b) => {
              const dateA = a.content.date ?? a.driveFile.modifiedTime;
              const dateB = b.content.date ?? b.driveFile.modifiedTime;
              return dateB.localeCompare(dateA);
            })
          );
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          setError(msg);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [folderId, hasPassphrase, getPassphrase, tick]);

  // Derive empty state when no passphrase — avoids stale file display
  return {
    files: hasPassphrase ? files : [],
    isLoading: hasPassphrase ? isLoading : false,
    error,
    refetch,
  };
}
