"use client";

import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { useCrypto } from "@/hooks/use-crypto";
import { decryptPayloadStream } from "@/lib/crypto";

export interface FileDownloadTarget {
  metaFileId: string;
  fallbackName?: string;
  expectedSize?: number;
}

export interface BatchDownloadFailure {
  target: FileDownloadTarget;
  filename: string;
  error: string;
}

export interface BatchDownloadResult {
  total: number;
  succeeded: number;
  failed: BatchDownloadFailure[];
}

export type DownloadStage =
  | "resolving"
  | "downloading"
  | "streaming"
  | "complete"
  | "failed";

export interface DownloadItem {
  metaFileId: string;
  filename: string;
  stage: DownloadStage;
  bytesWritten: number;
  expectedSize?: number;
  error?: string;
  startedAt: number;
}

export interface BatchDownloadState {
  active: boolean;
  completed: number;
  total: number;
  currentFilename?: string;
}

interface WritableFileLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

interface FileHandleLike {
  createWritable(): Promise<WritableFileLike>;
}

interface DirectoryHandleLike {
  getFileHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<FileHandleLike>;
}

interface FileSystemAccessWindow extends Window {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
  }) => Promise<FileHandleLike>;
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
  }) => Promise<DirectoryHandleLike>;
}

interface FileDestination {
  open(filename: string): Promise<WritableFileLike>;
}

interface FileDownloadContextValue {
  downloadItems: Record<string, DownloadItem>;
  batch: BatchDownloadState | null;
  downloadFile: (target: FileDownloadTarget) => Promise<void>;
  downloadSelected: (targets: FileDownloadTarget[]) => Promise<BatchDownloadResult>;
  clearDownloadHistory: () => void;
}

const FileDownloadContext = createContext<FileDownloadContextValue | null>(null);

function safeFilename(filename: string): string {
  const safe = filename
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim();
  return safe && safe !== "." && safe !== ".." ? safe : "download";
}

function triggerDownload(chunks: Uint8Array[], filename: string) {
  const blob = new Blob(chunks as unknown as BlobPart[], {
    type: "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function chooseSingleDestination(
  suggestedName: string
): Promise<FileDestination | undefined> {
  const fileSystemWindow = window as FileSystemAccessWindow;
  if (!fileSystemWindow.showSaveFilePicker) return undefined;

  const handle = await fileSystemWindow.showSaveFilePicker({
    suggestedName: safeFilename(suggestedName),
  });
  return {
    open: () => handle.createWritable(),
  };
}

async function chooseDirectoryDestination(): Promise<FileDestination | undefined> {
  const fileSystemWindow = window as FileSystemAccessWindow;
  if (!fileSystemWindow.showDirectoryPicker) return undefined;

  const directory = await fileSystemWindow.showDirectoryPicker({ mode: "readwrite" });
  return {
    open: async (filename) => {
      const handle = await directory.getFileHandle(safeFilename(filename), {
        create: true,
      });
      return handle.createWritable();
    },
  };
}

export function FileDownloadProvider({ children }: { children: React.ReactNode }) {
  const { getPassphrase } = useCrypto();
  const [downloadItems, setDownloadItems] = useState<Record<string, DownloadItem>>({});
  const [batch, setBatch] = useState<BatchDownloadState | null>(null);
  const activeIdsRef = useRef(new Set<string>());
  const batchActiveRef = useRef(false);

  const beginItem = useCallback((target: FileDownloadTarget) => {
    setDownloadItems((previous) => ({
      ...previous,
      [target.metaFileId]: {
        metaFileId: target.metaFileId,
        filename: target.fallbackName || target.metaFileId,
        stage: "resolving",
        bytesWritten: 0,
        expectedSize: target.expectedSize,
        startedAt: Date.now(),
      },
    }));
  }, []);

  const updateItem = useCallback(
    (metaFileId: string, update: Partial<DownloadItem>) => {
      setDownloadItems((previous) => {
        const current = previous[metaFileId];
        if (!current) return previous;
        return {
          ...previous,
          [metaFileId]: { ...current, ...update },
        };
      });
    },
    []
  );

  const downloadFileInternal = useCallback(
    async (
      target: FileDownloadTarget,
      identity: string,
      destination?: FileDestination
    ) => {
      if (activeIdsRef.current.has(target.metaFileId)) {
        throw new Error("This file is already downloading");
      }

      activeIdsRef.current.add(target.metaFileId);
      beginItem(target);
      let writer: WritableFileLike | undefined;

      try {
        const response = await fetch(
          `/api/drive/payload/${encodeURIComponent(target.metaFileId)}`,
          { cache: "no-store" }
        );
        if (!response.ok) {
          const message = await response.text();
          throw new Error(message || `Failed to fetch payload (HTTP ${response.status})`);
        }

        updateItem(target.metaFileId, { stage: "downloading" });
        if (!response.body) throw new Error("The payload response has no readable body");

        // age-encryption consumes the network stream and exposes a decrypted
        // stream. Only the small custom filename header is buffered here.
        const decrypted = await decryptPayloadStream(identity, response.body);
        const filename = safeFilename(decrypted.filename || target.fallbackName || "download");
        updateItem(target.metaFileId, {
          stage: "streaming",
          filename,
          expectedSize: target.expectedSize,
        });

        if (destination) {
          writer = await destination.open(filename);
        }

        const reader = decrypted.content.getReader();
        const chunks: Uint8Array[] = [];
        let bytesWritten = 0;
        let lastProgressUpdate = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;

            if (writer) {
              await writer.write(value);
            } else {
              // Compatibility fallback: stream-decrypt still works, but a
              // Blob must be assembled when direct disk writing is unavailable.
              chunks.push(value.slice());
            }

            bytesWritten += value.byteLength;
            const now = Date.now();
            if (now - lastProgressUpdate >= 100) {
              updateItem(target.metaFileId, { bytesWritten });
              lastProgressUpdate = now;
            }
          }
        } finally {
          reader.releaseLock();
        }

        if (writer) {
          await writer.close();
        } else {
          triggerDownload(chunks, filename);
        }

        updateItem(target.metaFileId, {
          stage: "complete",
          bytesWritten,
          filename,
        });
      } catch (error) {
        if (writer?.abort) await writer.abort(error).catch(() => undefined);
        const message = error instanceof Error ? error.message : "Download failed";
        updateItem(target.metaFileId, {
          stage: "failed",
          error: isAbortError(error) ? "Download cancelled" : message,
        });
        throw error instanceof Error ? error : new Error(message);
      } finally {
        activeIdsRef.current.delete(target.metaFileId);
      }
    },
    [beginItem, updateItem]
  );

  const downloadFile = useCallback(
    async (target: FileDownloadTarget) => {
      if (activeIdsRef.current.has(target.metaFileId)) return;

      const identity = getPassphrase();
      if (!identity) throw new Error("Enter your decryption passphrase first");

      const destination = await chooseSingleDestination(
        target.fallbackName || target.metaFileId
      );
      await downloadFileInternal(target, identity, destination);
    },
    [downloadFileInternal, getPassphrase]
  );

  const downloadSelected = useCallback(
    async (inputTargets: FileDownloadTarget[]) => {
      if (batchActiveRef.current) {
        throw new Error("A download is already in progress");
      }

      const identity = getPassphrase();
      if (!identity) throw new Error("Enter your decryption passphrase first");

      const targets = Array.from(
        new Map(inputTargets.map((target) => [target.metaFileId, target])).values()
      );
      const destination = await chooseDirectoryDestination();
      const failed: BatchDownloadFailure[] = [];
      let succeeded = 0;
      batchActiveRef.current = true;
      setBatch({ active: true, completed: 0, total: targets.length });

      try {
        for (let index = 0; index < targets.length; index++) {
          const target = targets[index];
          setBatch({
            active: true,
            completed: index,
            total: targets.length,
            currentFilename: target.fallbackName,
          });

          try {
            await downloadFileInternal(target, identity, destination);
            succeeded++;
          } catch (error) {
            failed.push({
              target,
              filename: target.fallbackName || target.metaFileId,
              error: error instanceof Error ? error.message : "Download failed",
            });
          }
        }
      } finally {
        batchActiveRef.current = false;
        setBatch({ active: false, completed: targets.length, total: targets.length });
      }

      return { total: targets.length, succeeded, failed };
    },
    [downloadFileInternal, getPassphrase]
  );

  const clearDownloadHistory = useCallback(() => {
    if (!batchActiveRef.current) setDownloadItems({});
  }, []);

  return (
    <FileDownloadContext.Provider
      value={{
        downloadItems,
        batch,
        downloadFile,
        downloadSelected,
        clearDownloadHistory,
      }}
    >
      {children}
    </FileDownloadContext.Provider>
  );
}

export function useFileDownload() {
  const context = useContext(FileDownloadContext);
  if (!context) {
    throw new Error("useFileDownload must be used within a FileDownloadProvider");
  }
  return context;
}
