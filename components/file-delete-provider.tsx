"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, Trash2 } from "lucide-react";
import { useCrypto } from "@/hooks/use-crypto";
import { useFileUpload } from "@/components/file-upload-provider";
import { useMediaPreview } from "@/components/media-preview-provider";
import { useSelection } from "@/components/selection-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trashMetaFile } from "@/lib/drive-client";
import type { DriveMetaFile } from "@/types";

export interface FileDeleteTarget {
  driveFile: DriveMetaFile;
  displayName: string;
}

interface FileDeleteContextValue {
  deletedMetaFileIds: ReadonlySet<string>;
  confirmationTarget: FileDeleteTarget | null;
  confirmationError: string | null;
  requestDelete: (target: FileDeleteTarget) => void;
  confirmDelete: () => Promise<void>;
  dismissDelete: () => void;
  isDeleting: (metaFileId: string) => boolean;
  isDeleted: (metaFileId: string) => boolean;
  isUploadActive: (metaFileId: string) => boolean;
}

const FileDeleteContext = createContext<FileDeleteContextValue | null>(null);
const ACTIVE_UPLOAD_STAGES = new Set(["preparing", "meta", "encrypting", "uploading", "retrying", "finalizing"]);
const CACHE_KEYS = [["meta-list"], ["decrypted-folder"], ["recursive-meta-list"]] as const;

function cacheItemMetaId(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const value = item as { id?: unknown; driveFile?: { id?: unknown } };
  if (typeof value.driveFile?.id === "string") return value.driveFile.id;
  return typeof value.id === "string" ? value.id : undefined;
}

function cacheItemThumbnailUrl(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const value = item as { thumbnailUrl?: unknown };
  return typeof value.thumbnailUrl === "string" ? value.thumbnailUrl : undefined;
}

export function FileDeleteProvider({ children }: { children: React.ReactNode }) {
  const { registerSensitiveCleanup } = useCrypto();
  const { uploadItems } = useFileUpload();
  const { preview, closePreview } = useMediaPreview();
  const { removeFileSelection } = useSelection();
  const queryClient = useQueryClient();
  const [confirmationTarget, setConfirmationTarget] = useState<FileDeleteTarget | null>(null);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const [deletingMetaFileId, setDeletingMetaFileId] = useState<string | null>(null);
  const [deletedMetaFileIds, setDeletedMetaFileIds] = useState<ReadonlySet<string>>(() => new Set());
  const deletedIdsRef = useRef(new Set<string>());
  const confirmationTargetRef = useRef<FileDeleteTarget | null>(null);
  const requestRef = useRef<{ metaFileId: string; controller: AbortController } | null>(null);
  const generationRef = useRef(0);
  const previewMetaFileId = preview?.target.metaFileId;
  const previewMetaFileIdRef = useRef(previewMetaFileId);

  useLayoutEffect(() => {
    previewMetaFileIdRef.current = previewMetaFileId;
  }, [previewMetaFileId]);

  const setTarget = useCallback((target: FileDeleteTarget | null) => {
    confirmationTargetRef.current = target;
    setConfirmationTarget(target);
  }, []);

  const isUploadActive = useCallback((metaFileId: string) => {
    return Object.values(uploadItems).some((item) =>
      item.metaFileId === metaFileId && ACTIVE_UPLOAD_STAGES.has(item.stage)
    );
  }, [uploadItems]);

  const isDeleting = useCallback((metaFileId: string) => deletingMetaFileId === metaFileId, [deletingMetaFileId]);
  const isDeleted = useCallback((metaFileId: string) => deletedMetaFileIds.has(metaFileId), [deletedMetaFileIds]);
  const requestDelete = useCallback((target: FileDeleteTarget) => {
    if (requestRef.current || deletedIdsRef.current.has(target.driveFile.id)) return;
    setTarget(target);
    setConfirmationError(
      isUploadActive(target.driveFile.id)
        ? "Finish or cancel the active upload before moving this file to Trash."
        : null
    );
  }, [isUploadActive, setTarget]);

  const dismissDelete = useCallback(() => {
    if (requestRef.current) return;
    setTarget(null);
    setConfirmationError(null);
  }, [setTarget]);

  const clearSensitiveState = useCallback(() => {
    generationRef.current += 1;
    requestRef.current?.controller.abort();
    requestRef.current = null;
    deletedIdsRef.current.clear();
    setDeletedMetaFileIds(new Set());
    setTarget(null);
    setDeletingMetaFileId(null);
    setConfirmationError(null);
  }, [setTarget]);

  useEffect(() => registerSensitiveCleanup(clearSensitiveState), [clearSensitiveState, registerSensitiveCleanup]);
  useEffect(() => () => clearSensitiveState(), [clearSensitiveState]);

  const purgeCachedFile = useCallback(async (metaFileId: string, generation: number) => {
    const affectedQueries = queryClient.getQueryCache().getAll().filter((query) =>
      CACHE_KEYS.some(([prefix]) => query.queryKey[0] === prefix)
      && Array.isArray(query.state.data)
      && query.state.data.some((item: unknown) => cacheItemMetaId(item) === metaFileId)
    );
    await Promise.all(affectedQueries.map((query) =>
      queryClient.cancelQueries({ queryKey: query.queryKey, exact: true }).catch(() => undefined)
    ));
    if (generation !== generationRef.current) return;

    const revokedUrls = new Set<string>();
    for (const query of queryClient.getQueryCache().getAll()) {
      if (!CACHE_KEYS.some(([prefix]) => query.queryKey[0] === prefix)) continue;
      if (!Array.isArray(query.state.data)) continue;

      let changed = false;
      const filtered = query.state.data.filter((item: unknown) => {
        if (cacheItemMetaId(item) !== metaFileId) return true;
        changed = true;
        const thumbnailUrl = cacheItemThumbnailUrl(item);
        if (thumbnailUrl && !revokedUrls.has(thumbnailUrl)) {
          revokedUrls.add(thumbnailUrl);
          URL.revokeObjectURL(thumbnailUrl);
        }
        return false;
      });
      if (changed) queryClient.setQueryData(query.queryKey, filtered);
    }
  }, [queryClient]);

  const confirmDelete = useCallback(async () => {
    const target = confirmationTargetRef.current;
    if (!target || requestRef.current || deletedIdsRef.current.has(target.driveFile.id)) return;
    if (isUploadActive(target.driveFile.id)) {
      setConfirmationError("Finish or cancel the active upload before moving this file to Trash.");
      return;
    }

    const metaFileId = target.driveFile.id;
    const generation = generationRef.current;
    const controller = new AbortController();
    const request = { metaFileId, controller };
    requestRef.current = request;
    setDeletingMetaFileId(metaFileId);
    setConfirmationError(null);

    try {
      await trashMetaFile(
        metaFileId,
        target.driveFile.name,
        target.driveFile.modifiedTime,
        controller.signal
      );
      if (generation !== generationRef.current || controller.signal.aborted) return;

      const nextDeletedIds = new Set(deletedIdsRef.current);
      nextDeletedIds.add(metaFileId);
      deletedIdsRef.current = nextDeletedIds;
      setDeletedMetaFileIds(nextDeletedIds);
      removeFileSelection(metaFileId);
      await purgeCachedFile(metaFileId, generation);
      if (generation !== generationRef.current) return;
      if (previewMetaFileIdRef.current === metaFileId) {
        await closePreview().catch(() => undefined);
      }
      if (generation !== generationRef.current) return;
      setTarget(null);
      setConfirmationError(null);
    } catch (error) {
      if (generation === generationRef.current && !controller.signal.aborted) {
        setConfirmationError(error instanceof Error ? error.message : "Could not move this file pair to Trash.");
      }
    } finally {
      if (requestRef.current === request) {
        requestRef.current = null;
        setDeletingMetaFileId(null);
      }
    }
  }, [closePreview, isUploadActive, purgeCachedFile, removeFileSelection, setTarget]);

  const contextValue: FileDeleteContextValue = {
    deletedMetaFileIds,
    confirmationTarget,
    confirmationError,
    requestDelete,
    confirmDelete,
    dismissDelete,
    isDeleting,
    isDeleted,
    isUploadActive,
  };

  const deleting = confirmationTarget !== null && deletingMetaFileId === confirmationTarget.driveFile.id;

  return (
    <FileDeleteContext.Provider value={contextValue}>
      {children}
      <Dialog
        open={confirmationTarget !== null}
        onOpenChange={(open) => { if (!open && !requestRef.current) dismissDelete(); }}
      >
        <DialogContent
          id="file-delete-confirmation"
          showCloseButton={!deleting}
          className="sm:max-w-lg border-white/10 bg-background/95 backdrop-blur-xl"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <Trash2 className="h-5 w-5 text-destructive" />
              Move file pair to Trash?
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs leading-normal">
              Both the encrypted metadata and its paired original will move to Google Drive Trash, where they can be restored.
            </DialogDescription>
          </DialogHeader>

          {confirmationTarget && (
            <div className="rounded-lg border border-white/8 bg-white/3 p-3">
              <p className="break-all font-mono text-sm text-foreground">{confirmationTarget.displayName}</p>
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{confirmationTarget.driveFile.name}</p>
            </div>
          )}
          {confirmationError && (
            <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {confirmationError}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={dismissDelete} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting || !confirmationTarget}>
              {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {deleting ? "Moving to Trash" : "Move both to Trash"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </FileDeleteContext.Provider>
  );
}

export function useFileDelete() {
  const context = useContext(FileDeleteContext);
  if (!context) throw new Error("useFileDelete must be used within FileDeleteProvider");
  return context;
}
