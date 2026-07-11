"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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

  // Helper to map raw GDrive file list to progressive loading card structure
  const mapInitialFiles = useCallback((rawFiles: DriveMetaFile[]): ProgressiveMetaFile[] => {
    return rawFiles.map((f) => ({
      driveFile: f,
      originalFileName: f.name.replace(/\.meta$/i, ""),
      decrypted: false,
    }));
  }, []);

  // Initialize state immediately with server-fetched list if available to avoid duplicate generic skeletons
  const [files, setFiles] = useState<ProgressiveMetaFile[]>(() => {
    if (initialFiles) {
      return mapInitialFiles(initialFiles);
    }
    return [];
  });

  const [isListLoading, setIsListLoading] = useState(!initialFiles);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const blobUrlsRef = useRef<string[]>([]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!folderId || !hasPassphrase) return;

    const passphrase = getPassphrase();
    if (!passphrase) return;

    let cancelled = false;

    // Cleanup previous blob URLs
    blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    blobUrlsRef.current = [];

    async function load() {
      let metaList = initialFiles;

      // Fetch list on tick refetch or if we didn't have one initially
      if (!metaList || tick > 0) {
        setIsListLoading(true);
        setIsDecrypting(false);
        setError(null);
        setFiles([]);

        try {
          metaList = await fetchMetaList(folderId);
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : "Failed to list files");
            setIsListLoading(false);
          }
          return;
        }
        if (cancelled) return;

        if (metaList.length === 0) {
          setFiles([]);
          setIsListLoading(false);
          return;
        }

        if (!cancelled) {
          setFiles(mapInitialFiles(metaList));
          setIsListLoading(false);
        }
      }

      if (cancelled) return;
      setIsDecrypting(true);

      // ── decrypt in batches, update state per batch ──────────
      for (let i = 0; i < metaList.length; i += BATCH_SIZE) {
        if (cancelled) break;
        const batch = metaList.slice(i, i + BATCH_SIZE);

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
              const { details, thumbnailUrl } = result.value;
              if (thumbnailUrl) blobUrlsRef.current.push(thumbnailUrl);
              updated[pos] = { ...updated[pos], decrypted: true, details, thumbnailUrl };
            } else {
              const msg = result.reason instanceof Error
                ? result.reason.message
                : "Decryption failed";
              updated[pos] = { ...updated[pos], decrypted: true, decryptError: msg };
            }
          });
          return updated;
        });
      }

      if (!cancelled) setIsDecrypting(false);
    }

    load();

    return () => {
      cancelled = true;
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current = [];
    };
  }, [folderId, hasPassphrase, getPassphrase, tick, initialFiles, mapInitialFiles]);

  return {
    files: hasPassphrase ? files : [],
    isListLoading: hasPassphrase ? isListLoading : false,
    isDecrypting: hasPassphrase ? isDecrypting : false,
    error,
    refetch,
  };
}
