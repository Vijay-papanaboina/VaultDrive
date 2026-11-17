"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, Trash2 } from "lucide-react";
import { useCrypto } from "@/hooks/use-crypto";
import { useFileUpload } from "@/components/file-upload-provider";
import { useLocalDownloadActions } from "@/components/local-download-provider";
import { useMediaPreview } from "@/components/media-preview-provider";
import { useSelection } from "@/components/selection-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  requestDeleteMany: (targets: readonly FileDeleteTarget[]) => void;
  confirmDelete: () => Promise<void>;
  dismissDelete: () => void;
  isDeleting: (metaFileId: string) => boolean;
  isDeleted: (metaFileId: string) => boolean;
  isUploadActive: (metaFileId: string) => boolean;
}

interface TargetFailure {
  target: FileDeleteTarget;
  message: string;
}

interface DeleteProgress {
  current: number;
  total: number;
}

const FileDeleteContext = createContext<FileDeleteContextValue | null>(null);
const ACTIVE_UPLOAD_STAGES = new Set(["preparing", "meta", "encrypting", "uploading", "retrying", "finalizing"]);
const CACHE_KEYS = [["meta-list"], ["decrypted-folder"], ["recursive-meta-list"]] as const;

function snapshotTargets(targets: readonly FileDeleteTarget[], deletedIds: ReadonlySet<string>): FileDeleteTarget[] {
  const seen = new Set<string>();
  return targets.flatMap((target) => {
    const file = target?.driveFile;
    if (!file || typeof file.id !== "string" || !file.id.trim() || file.id !== file.id.trim() ||
      typeof file.name !== "string" || !file.name.trim() || typeof file.modifiedTime !== "string" ||
      !file.modifiedTime.trim() || seen.has(file.id) || deletedIds.has(file.id)) return [];
    seen.add(file.id);
    return [{
      driveFile: { ...file },
      displayName: typeof target.displayName === "string" && target.displayName.trim() ? target.displayName : file.name,
    }];
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function cacheItemMetaId(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const value = item as { id?: unknown; driveFile?: { id?: unknown } };
  return typeof value.driveFile?.id === "string" ? value.driveFile.id : typeof value.id === "string" ? value.id : undefined;
}

function cacheItemThumbnailUrl(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const value = item as { thumbnailUrl?: unknown };
  return typeof value.thumbnailUrl === "string" ? value.thumbnailUrl : undefined;
}

export function FileDeleteProvider({ children }: { children: React.ReactNode }) {
  const { registerSensitiveCleanup } = useCrypto();
  const { uploadItems } = useFileUpload();
  const { markRemoteDeleted } = useLocalDownloadActions();
  const { preview, closePreview } = useMediaPreview();
  const { removeFileSelection } = useSelection();
  const queryClient = useQueryClient();
  const [targets, setTargetsState] = useState<FileDeleteTarget[]>([]);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const [failures, setFailures] = useState<TargetFailure[]>([]);
  const [isBulkRequest, setIsBulkRequest] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<DeleteProgress | null>(null);
  const [deletingMetaFileId, setDeletingMetaFileId] = useState<string | null>(null);
  const [deletedMetaFileIds, setDeletedMetaFileIds] = useState<ReadonlySet<string>>(() => new Set());
  const deletedIdsRef = useRef(new Set<string>());
  const targetsRef = useRef<FileDeleteTarget[]>([]);
  const uploadItemsRef = useRef(uploadItems);
  const requestRef = useRef<{ controller: AbortController } | null>(null);
  const generationRef = useRef(0);
  const previewMetaFileId = preview?.target.metaFileId;
  const previewMetaFileIdRef = useRef(previewMetaFileId);
  const confirmationTarget = targets[0] ?? null;

  useLayoutEffect(() => { previewMetaFileIdRef.current = previewMetaFileId; }, [previewMetaFileId]);
  useLayoutEffect(() => { uploadItemsRef.current = uploadItems; }, [uploadItems]);

  const setTargetList = useCallback((next: readonly FileDeleteTarget[]) => {
    const copy = [...next];
    targetsRef.current = copy;
    setTargetsState(copy);
  }, []);

  const isUploadActive = useCallback((metaFileId: string) => Object.values(uploadItemsRef.current).some((item) =>
    item.metaFileId === metaFileId && ACTIVE_UPLOAD_STAGES.has(item.stage)
  ), []);
  const isDeleting = useCallback((metaFileId: string) => deletingMetaFileId === metaFileId, [deletingMetaFileId]);
  const isDeleted = useCallback((metaFileId: string) => deletedMetaFileIds.has(metaFileId), [deletedMetaFileIds]);

  const openRequest = useCallback((input: readonly FileDeleteTarget[]) => {
    if (requestRef.current) return [];
    const snapshots = snapshotTargets(input, deletedIdsRef.current);
    if (!snapshots.length) return [];
    setTargetList(snapshots);
    setIsBulkRequest(snapshots.length > 1);
    setFailures([]);
    setConfirmationError(null);
    setProgress(null);
    return snapshots;
  }, [setTargetList]);

  const requestDelete = useCallback((target: FileDeleteTarget) => {
    const [snapshot] = openRequest([target]);
    if (snapshot && isUploadActive(snapshot.driveFile.id)) {
      setConfirmationError("Finish or cancel the active upload before moving this file to Trash.");
    }
  }, [isUploadActive, openRequest]);

  const requestDeleteMany = useCallback((input: readonly FileDeleteTarget[]) => {
    openRequest(input);
  }, [openRequest]);

  const dismissDelete = useCallback(() => {
    if (requestRef.current) return;
    setTargetList([]);
    setIsBulkRequest(false);
    setFailures([]);
    setConfirmationError(null);
    setProgress(null);
  }, [setTargetList]);

  const clearSensitiveState = useCallback(() => {
    generationRef.current += 1;
    requestRef.current?.controller.abort();
    requestRef.current = null;
    deletedIdsRef.current.clear();
    setDeletedMetaFileIds(new Set());
    setTargetList([]);
    setIsBulkRequest(false);
    setFailures([]);
    setConfirmationError(null);
    setProgress(null);
    setDeletingMetaFileId(null);
    setIsProcessing(false);
  }, [setTargetList]);

  useEffect(() => registerSensitiveCleanup(clearSensitiveState), [clearSensitiveState, registerSensitiveCleanup]);
  useEffect(() => () => clearSensitiveState(), [clearSensitiveState]);

  const purgeCachedFile = useCallback(async (metaFileId: string, generation: number) => {
    const affected = queryClient.getQueryCache().getAll().filter((query) =>
      CACHE_KEYS.some(([prefix]) => query.queryKey[0] === prefix) &&
      Array.isArray(query.state.data) && query.state.data.some((item: unknown) => cacheItemMetaId(item) === metaFileId)
    );
    await Promise.all(affected.map((query) =>
      queryClient.cancelQueries({ queryKey: query.queryKey, exact: true }).catch(() => undefined)
    ));
    if (generation !== generationRef.current) return;

    const revokedUrls = new Set<string>();
    for (const query of queryClient.getQueryCache().getAll()) {
      if (!CACHE_KEYS.some(([prefix]) => query.queryKey[0] === prefix) || !Array.isArray(query.state.data)) continue;
      let changed = false;
      const filtered = query.state.data.filter((item: unknown) => {
        if (cacheItemMetaId(item) !== metaFileId) return true;
        changed = true;
        const url = cacheItemThumbnailUrl(item);
        if (url && !revokedUrls.has(url)) { revokedUrls.add(url); URL.revokeObjectURL(url); }
        return false;
      });
      if (changed) queryClient.setQueryData(query.queryKey, filtered);
    }
  }, [queryClient]);

  const confirmDelete = useCallback(async () => {
    if (requestRef.current) return;
    const batch = targetsRef.current.filter((target) => !deletedIdsRef.current.has(target.driveFile.id));
    if (!batch.length) { dismissDelete(); return; }

    const generation = generationRef.current;
    const controller = new AbortController();
    const request = { controller };
    requestRef.current = request;
    setIsProcessing(true);
    setProgress({ current: 0, total: batch.length });
    setFailures([]);
    setConfirmationError(null);
    const failuresForBatch: TargetFailure[] = [];
    const successIds: string[] = [];

    try {
      for (let index = 0; index < batch.length; index += 1) {
        const target = batch[index];
        const metaFileId = target.driveFile.id;
        if (generation !== generationRef.current || controller.signal.aborted) break;
        if (deletedIdsRef.current.has(metaFileId)) continue;
        setProgress({ current: index + 1, total: batch.length });
        setDeletingMetaFileId(null);
        if (isUploadActive(metaFileId)) {
          failuresForBatch.push({ target, message: "Finish or cancel the active upload before moving this file to Trash." });
          continue;
        }

        setDeletingMetaFileId(metaFileId);
        try {
          await trashMetaFile(metaFileId, target.driveFile.name, target.driveFile.modifiedTime, controller.signal);
        } catch (error) {
          if (generation !== generationRef.current || controller.signal.aborted) break;
          failuresForBatch.push({ target, message: errorMessage(error, "Could not move this file pair to Trash.") });
          setDeletingMetaFileId(null);
          continue;
        }
        if (generation !== generationRef.current || controller.signal.aborted) break;

        successIds.push(metaFileId);
        const nextDeletedIds = new Set(deletedIdsRef.current);
        nextDeletedIds.add(metaFileId);
        deletedIdsRef.current = nextDeletedIds;
        setDeletedMetaFileIds(nextDeletedIds);
        try { removeFileSelection(metaFileId); } catch { /* Drive Trash already succeeded. */ }
        try { await purgeCachedFile(metaFileId, generation); } catch { /* Drive Trash already succeeded. */ }
        if (generation !== generationRef.current) break;
        if (previewMetaFileIdRef.current === metaFileId) {
          try { await closePreview(); } catch { /* Drive Trash already succeeded. */ }
        }
        if (generation !== generationRef.current) break;
        setDeletingMetaFileId(null);
      }

      if (successIds.length) markRemoteDeleted(successIds);
      if (generation !== generationRef.current || controller.signal.aborted) return;
      setFailures(failuresForBatch);
      if (failuresForBatch.length) {
        const failedTargets = failuresForBatch.map(({ target }) => target);
        setTargetList(failedTargets);
        if (!isBulkRequest && batch.length === 1) setConfirmationError(failuresForBatch[0].message);
        else {
          const moved = successIds.length === 1 ? "1 file pair was moved" : `${successIds.length} file pairs were moved`;
          const left = failuresForBatch.length === 1 ? "1 file pair remains" : `${failuresForBatch.length} file pairs remain`;
          setConfirmationError(`${moved} to Trash. ${left} and can be retried.`);
        }
      } else {
        setTargetList([]);
        setConfirmationError(null);
        setIsBulkRequest(false);
      }
    } finally {
      if (requestRef.current === request) {
        requestRef.current = null;
        setDeletingMetaFileId(null);
        setProgress(null);
        setIsProcessing(false);
      }
    }
  }, [closePreview, dismissDelete, isBulkRequest, isUploadActive, markRemoteDeleted, purgeCachedFile, removeFileSelection, setTargetList]);

  const contextValue: FileDeleteContextValue = {
    deletedMetaFileIds,
    confirmationTarget,
    confirmationError,
    requestDelete,
    requestDeleteMany,
    confirmDelete,
    dismissDelete,
    isDeleting,
    isDeleted,
    isUploadActive,
  };
  const failureById = new Map(failures.map(({ target, message }) => [target.driveFile.id, message]));
  const bulk = isBulkRequest;

  return (
    <FileDeleteContext.Provider value={contextValue}>
      {children}
      <Dialog open={targets.length > 0} onOpenChange={(open) => { if (!open && !requestRef.current) dismissDelete(); }}>
        <DialogContent id="file-delete-confirmation" showCloseButton={!isProcessing} className="sm:max-w-lg border-white/10 bg-background/95 backdrop-blur-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <Trash2 className="h-5 w-5 text-destructive" />
              {bulk ? `Move ${targets.length} ${targets.length === 1 ? "remaining file pair" : "remaining file pairs"} to Trash?` : "Move file pair to Trash?"}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs leading-normal">
              {bulk ? "For each pair, both the encrypted .meta file and its paired payload will move to Google Drive Trash, where they can be restored." : "Both the encrypted metadata and its paired original will move to Google Drive Trash, where they can be restored."}
            </DialogDescription>
          </DialogHeader>

          {confirmationTarget && !bulk && <div className="rounded-lg border border-white/8 bg-white/3 p-3"><p className="break-all font-mono text-sm text-foreground">{confirmationTarget.displayName}</p><p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{confirmationTarget.driveFile.name}</p></div>}
          {bulk && <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-white/8 bg-white/3 p-3">{targets.map((target) => <div key={target.driveFile.id} className="min-w-0 border-b border-white/8 pb-2 last:border-0 last:pb-0"><p className="break-all font-mono text-sm text-foreground">{target.displayName}</p><p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{target.driveFile.name}</p>{failureById.has(target.driveFile.id) && <p className="mt-1 text-xs leading-relaxed text-destructive">{failureById.get(target.driveFile.id)}</p>}</div>)}</div>}
          {confirmationError && <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{confirmationError}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={dismissDelete} disabled={isProcessing}>Cancel</Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={isProcessing || !confirmationTarget}>
              {isProcessing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {isProcessing ? progress && progress.total > 1 ? `Moving ${progress.current} of ${progress.total} to Trash` : "Moving to Trash" : failures.length && bulk ? `Retry ${targets.length} remaining ${targets.length === 1 ? "pair" : "pairs"}` : bulk ? `Move ${targets.length} ${targets.length === 1 ? "pair" : "pairs"} to Trash` : "Move both to Trash"}
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
