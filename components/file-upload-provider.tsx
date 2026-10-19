"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { MetaDetails } from "@/types";
import { encryptMetaZip } from "@/lib/crypto";
import {
  createResumableEncryptedPayloadStream,
  createResumablePayloadContext,
  encryptedPayloadSize,
  sealUploadContext,
  unsealUploadContext,
  type PayloadDescriptor,
  type ResumablePayloadContext,
} from "@/lib/resumable-payload";
import { useCrypto } from "@/hooks/use-crypto";
import {
  directResumableUpload,
  DRIVE_UPLOAD_CHUNK_BYTES,
  validateDriveUploadSessionUrl,
} from "@/lib/direct-drive-upload";

const FINALIZATION_ATTEMPTS = 3;

export type UploadStage = "preparing" | "meta" | "encrypting" | "uploading" | "retrying" | "finalizing" | "paused" | "complete" | "failed";

export interface UploadItem {
  id: string;
  folderId: string;
  filename: string;
  stage: UploadStage;
  bytesUploaded: number;
  encryptedSize: number;
  error?: string;
  startedAt: number;
  metaFileId?: string;
  payloadFileId?: string;
  resumable?: boolean;
}

interface UploadSession {
  id: string;
  folderId: string;
  filename: string;
  descriptor: PayloadDescriptor;
  sessionUrl: string;
  metaFileId: string;
  payloadFileId: string;
  encryptedSize: number;
  bytesUploaded: number;
  context: string;
  // Absent means a session made by an older client, whose payload still needs
  // the server-side .uploading -> final-name transition.
  finalizationRequired?: boolean;
}

interface NewUpload {
  folderId: string;
  file: File;
  payloadName: string;
  opaqueId?: string;
  details: MetaDetails;
  thumbnailBytes: Uint8Array | null;
  thumbnailFilename: string | null;
}

interface FileUploadContextValue {
  uploadItems: Record<string, UploadItem>;
  startUpload(input: NewUpload, onStarted?: (id: string) => void): Promise<void>;
  resumeUpload(id: string, file: File): Promise<void>;
  cancelUpload(id: string): Promise<void>;
  clearUploadHistory(): void;
}

const FileUploadContext = createContext<FileUploadContextValue | null>(null);

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const next = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    next.set(part, offset);
    offset += part.byteLength;
  }
  return next;
}

function asUploadBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isSameSource(file: File, descriptor: PayloadDescriptor): boolean {
  return file.name === descriptor.filename && file.size === descriptor.size && file.lastModified === descriptor.lastModified;
}

class UploadProtocolError extends Error {}

function parseReceivedOffset(response: Response, allowMissing = false): number {
  const range = response.headers.get("Range");
  if (range === null && allowMissing) return 0;
  const match = range === null ? null : /^bytes=0-(\d+)$/.exec(range);
  const end = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(end) || end < 0) {
    throw new UploadProtocolError("Google Drive did not confirm the uploaded byte range.");
  }
  return end + 1;
}

function replacementSessionUrl(response: Response): string | undefined {
  const location = response.headers.get("Location");
  if (!location) return undefined;

  return validateDriveUploadSessionUrl(location);
}

async function responseMessage(response: Response): Promise<string> {
  return (await response.text()).trim() || `Upload failed: HTTP ${response.status}`;
}

function isNetworkFetchError(error: unknown): error is TypeError {
  return error instanceof TypeError && /failed to fetch|network(?:error| request failed)?|load failed/i.test(error.message);
}

function uploadErrorMessage(error: unknown, finalizing = false): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Upload paused.";
  if (isNetworkFetchError(error)) {
    if (finalizing) {
      return "VaultDrive could not reach the finalization service. Your encrypted payload is already in Drive; click Resume upload to retry finalization.";
    }
    return "Connection lost. Check your internet connection and retry the upload.";
  }
  return error instanceof Error ? error.message : "Upload failed.";
}

async function finalizeLegacyPayload(metaFileId: string, payloadFileId: string): Promise<void> {
  const body = JSON.stringify({ metaFileId, payloadFileId });
  for (let attempt = 0; attempt < FINALIZATION_ATTEMPTS; attempt++) {
    try {
      const response = await fetch("/api/drive/upload/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        // This is a tiny, idempotent request; do not bind it to the streaming
        // upload controller so a completed legacy upload can still finalize.
        keepalive: true,
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      return;
    } catch (error) {
      if (!isNetworkFetchError(error) || attempt === FINALIZATION_ATTEMPTS - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

async function uploadEncryptedMeta(sessionUrl: string, encryptedMeta: Uint8Array, signal: AbortSignal): Promise<void> {
  let offset = 0;
  while (offset < encryptedMeta.byteLength) {
    const endExclusive = Math.min(offset + DRIVE_UPLOAD_CHUNK_BYTES, encryptedMeta.byteLength);
    const finalChunk = endExclusive === encryptedMeta.byteLength;
    const response = await directResumableUpload(
      sessionUrl,
      `bytes ${offset}-${endExclusive - 1}/${encryptedMeta.byteLength}`,
      asUploadBody(encryptedMeta.subarray(offset, endExclusive)),
      signal
    );
    if (finalChunk) {
      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Google Drive rejected encrypted metadata (HTTP ${response.status}).`);
      }
      return;
    }
    if (response.status !== 308) {
      throw new Error(`Google Drive did not accept the encrypted metadata chunk (HTTP ${response.status}).`);
    }
    const received = parseReceivedOffset(response);
    if (received !== endExclusive) {
      throw new UploadProtocolError("Google Drive confirmed an unexpected encrypted metadata range.");
    }
    offset = received;
  }
}

export function FileUploadProvider({ children }: { children: React.ReactNode }) {
  const { getPassphrase, registerSensitiveCleanup } = useCrypto();
  const [uploadItems, setUploadItemsState] = useState<Record<string, UploadItem>>({});
  const uploadItemsRef = useRef<Record<string, UploadItem>>({});
  const setUploadItems = useCallback((update: Record<string, UploadItem> | ((previous: Record<string, UploadItem>) => Record<string, UploadItem>)) => {
    const next = typeof update === "function" ? update(uploadItemsRef.current) : update;
    uploadItemsRef.current = next;
    setUploadItemsState(next);
  }, []);
  const sessionsRef = useRef<Record<string, UploadSession>>({});
  const controllersRef = useRef(new Map<string, AbortController>());
  const setupControllersRef = useRef(new Map<string, AbortController>());
  const cleanupControllersRef = useRef(new Map<string, AbortController>());
  const remoteTargetsRef = useRef(new Map<string, { metaFileId: string; payloadFileId?: string }>());
  const cleanupPromisesRef = useRef(new Map<string, Promise<void>>());
  const cancelRequestedRef = useRef(new Set<string>());
  const readersRef = useRef(new Set<ReadableStreamDefaultReader<Uint8Array>>());
  const sensitiveGenerationRef = useRef(0);
  const getPassphraseRef = useRef(getPassphrase);

  useEffect(() => {
    getPassphraseRef.current = getPassphrase;
  }, [getPassphrase]);

  const clearSensitiveState = useCallback(() => {
    sensitiveGenerationRef.current += 1;
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    setupControllersRef.current.forEach((controller) => controller.abort());
    setupControllersRef.current.clear();
    cleanupControllersRef.current.forEach((controller) => controller.abort());
    cleanupControllersRef.current.clear();
    cleanupPromisesRef.current.clear();
    remoteTargetsRef.current.clear();
    cancelRequestedRef.current.clear();
    readersRef.current.forEach((reader) => void reader.cancel().catch(() => undefined));
    readersRef.current.clear();
    sessionsRef.current = {};
    setUploadItems({});
  }, [setUploadItems]);

  useEffect(() => registerSensitiveCleanup(clearSensitiveState), [clearSensitiveState, registerSensitiveCleanup]);
  useEffect(() => () => clearSensitiveState(), [clearSensitiveState]);
  useEffect(() => {
    try {
      window.localStorage.removeItem("vaultdrive.uploads.v1");
    } catch {
      // Storage may be unavailable. Upload sessions remain memory-only.
    }
  }, []);

  const updateItem = useCallback((id: string, update: Partial<UploadItem>) => {
    setUploadItems((previous) => previous[id] ? { ...previous, [id]: { ...previous[id], ...update } } : previous);
  }, [setUploadItems]);

  const cleanupRemoteTarget = useCallback((
    id: string,
    target: { metaFileId: string; payloadFileId?: string },
    generation: number
  ): Promise<void> => {
    if (generation !== sensitiveGenerationRef.current) {
      return Promise.reject(new DOMException("Upload paused", "AbortError"));
    }
    const pending = cleanupPromisesRef.current.get(id);
    if (pending) return pending;
    const controller = new AbortController();
    cleanupControllersRef.current.set(id, controller);

    const cleanup = (async () => {
      const response = await fetch("/api/drive/upload/cleanup", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Remote cleanup failed. Retry cancellation later.");
      const current = remoteTargetsRef.current.get(id);
      if (current?.metaFileId === target.metaFileId && current.payloadFileId === target.payloadFileId) {
        remoteTargetsRef.current.delete(id);
      }
    })();
    cleanupPromisesRef.current.set(id, cleanup);
    void cleanup.finally(() => {
      if (cleanupPromisesRef.current.get(id) === cleanup) cleanupPromisesRef.current.delete(id);
      if (cleanupControllersRef.current.get(id) === controller) cleanupControllersRef.current.delete(id);
    }).catch(() => undefined);
    return cleanup;
  }, []);

  const uploadPayload = useCallback(async (
    id: string,
    file: File,
    payloadName: string,
    context: ResumablePayloadContext,
    state: UploadSession,
    generation: number,
    parentSignal?: AbortSignal,
  ) => {
    const controller = new AbortController();
    const requestSignal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    const ensureCurrent = () => {
      if (generation !== sensitiveGenerationRef.current || controller.signal.aborted || parentSignal?.aborted) {
        throw new DOMException("Upload paused", "AbortError");
      }
    };
    if (controllersRef.current.has(id)) throw new Error("This upload is already active.");
    controllersRef.current.set(id, controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      ensureCurrent();
      const acceptReplacementSessionUrl = async (response: Response) => {
        const replacement = replacementSessionUrl(response);
        if (!replacement || replacement === state.sessionUrl) return;
        state.sessionUrl = replacement;
        sessionsRef.current[id] = state;
      };

      const queryStatus = async () => {
        const response = await directResumableUpload(
          state.sessionUrl,
          `bytes */${state.encryptedSize}`,
          undefined,
          requestSignal,
        );
        acceptReplacementSessionUrl(response);
        ensureCurrent();
        if (response.ok) return { complete: true, offset: state.encryptedSize };
        if (response.status !== 308) throw new Error(`Google Drive rejected the upload status check (HTTP ${response.status}).`);
        const offset = parseReceivedOffset(response, true);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > state.encryptedSize) {
          throw new Error("Drive returned an invalid upload offset.");
        }
        return { complete: false, offset };
      };

      let offset = state.bytesUploaded;
      if (offset < state.encryptedSize) {
        if (offset > 0) updateItem(id, { stage: "retrying", error: undefined });
        const status = await queryStatus();
        ensureCurrent();
        offset = status.offset;
        state.bytesUploaded = offset;
        sessionsRef.current[id] = state;
        ensureCurrent();
        updateItem(id, { stage: "encrypting", bytesUploaded: offset, error: undefined });

        if (!status.complete) {
          const encrypted = createResumableEncryptedPayloadStream(file, payloadName, context, offset);
          const encryptedReader = encrypted.getReader();
          reader = encryptedReader;
          readersRef.current.add(encryptedReader);
          let carried: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
          const readChunk = async (): Promise<Uint8Array | null> => {
            const parts: Uint8Array[] = [];
            let size = 0;
            if (carried.byteLength) {
              parts.push(carried);
              size = carried.byteLength;
              carried = new Uint8Array(0);
            }
            while (size < DRIVE_UPLOAD_CHUNK_BYTES) {
              const { done, value } = await encryptedReader.read();
              ensureCurrent();
              if (done) break;
              if (!value?.byteLength) continue;
              const needed = DRIVE_UPLOAD_CHUNK_BYTES - size;
              if (value.byteLength > needed) {
                parts.push(value.subarray(0, needed));
                carried = value.subarray(needed);
                size += needed;
                break;
              }
              parts.push(value);
              size += value.byteLength;
            }
            return size ? concat(parts) : null;
          };

          while (true) {
            const chunk = await readChunk();
            ensureCurrent();
            if (!chunk) break;
            const chunkStart = offset;
            let sentFrom = 0;
            let attempts = 0;
            while (sentFrom < chunk.byteLength) {
              updateItem(id, { stage: attempts ? "retrying" : "uploading", bytesUploaded: chunkStart + sentFrom });
              const body = chunk.subarray(sentFrom);
              try {
                const response = await directResumableUpload(
                  state.sessionUrl,
                  `bytes ${chunkStart + sentFrom}-${chunkStart + chunk.byteLength - 1}/${state.encryptedSize}`,
                  asUploadBody(body),
                  requestSignal,
                );
                acceptReplacementSessionUrl(response);
                ensureCurrent();
                if (response.status === 200 || response.status === 201) {
                  if (chunkStart + chunk.byteLength !== state.encryptedSize) {
                    throw new UploadProtocolError("Google Drive completed a non-final encrypted payload chunk.");
                  }
                  offset = state.encryptedSize;
                  sentFrom = chunk.byteLength;
                  break;
                }
                if (response.status !== 308) throw new Error(`Google Drive rejected the encrypted payload chunk (HTTP ${response.status}).`);
                const received = parseReceivedOffset(response);
                if (received < chunkStart || received > chunkStart + chunk.byteLength) {
                  throw new UploadProtocolError("Google Drive confirmed an unexpected upload offset.");
                }
                if (received <= chunkStart + sentFrom) {
                  throw new UploadProtocolError("Google Drive did not advance the confirmed upload offset.");
                }
                sentFrom = received - chunkStart;
                offset = received;
              } catch (error) {
                if (controller.signal.aborted || parentSignal?.aborted) throw error;
                if (error instanceof UploadProtocolError) throw error;
                if (attempts++ >= 3) throw error;
                const retryStatus = await queryStatus();
                ensureCurrent();
                if (retryStatus.complete) { offset = state.encryptedSize; sentFrom = chunk.byteLength; break; }
                if (retryStatus.offset < chunkStart || retryStatus.offset > chunkStart + chunk.byteLength) throw new Error("Drive resumed outside the current encrypted chunk.");
                sentFrom = retryStatus.offset - chunkStart;
                offset = retryStatus.offset;
                await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
                ensureCurrent();
              }
            }
            state.bytesUploaded = offset;
            sessionsRef.current[id] = state;
            ensureCurrent();
            updateItem(id, { bytesUploaded: offset, stage: "encrypting" });
          }
        }
      }
      if (reader) {
        readersRef.current.delete(reader);
        reader.releaseLock();
        reader = undefined;
      }
      if (offset !== state.encryptedSize) throw new Error("Encrypted stream ended before Drive received all bytes.");
      if (state.finalizationRequired !== false) {
        updateItem(id, { stage: "finalizing", bytesUploaded: offset, error: undefined });
        await finalizeLegacyPayload(state.metaFileId, state.payloadFileId);
        ensureCurrent();
      }
      delete sessionsRef.current[id];
      ensureCurrent();
      remoteTargetsRef.current.delete(id);
      updateItem(id, { stage: "complete", bytesUploaded: offset, resumable: false });
    } catch (error) {
      const message = uploadErrorMessage(error, state.bytesUploaded >= state.encryptedSize);
      const aborted = controller.signal.aborted || parentSignal?.aborted === true;
      if (generation === sensitiveGenerationRef.current) {
        updateItem(id, { stage: aborted ? "paused" : "failed", error: aborted ? "Upload paused." : message, resumable: true });
      }
      throw new Error(message);
    } finally {
      if (reader) {
        readersRef.current.delete(reader);
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (controllersRef.current.get(id) === controller) {
        controllersRef.current.delete(id);
      }
    }
  }, [updateItem]);

  const startUpload = useCallback(async (input: NewUpload, onStarted?: (id: string) => void) => {
    const generation = sensitiveGenerationRef.current;
    const id = crypto.randomUUID();
    const setupController = new AbortController();
    const ensureCurrent = () => {
      if (generation !== sensitiveGenerationRef.current || setupController.signal.aborted) {
        throw new DOMException("Upload paused", "AbortError");
      }
    };
    setupControllersRef.current.set(id, setupController);
    const descriptor: PayloadDescriptor = { filename: input.file.name, size: input.file.size, lastModified: input.file.lastModified };
    let createdMetaFileId: string | undefined;
    let createdPayloadFileId: string | undefined;
    let sessionReady = false;
    setUploadItems((previous) => ({
      ...previous,
      [id]: {
        id,
        folderId: input.folderId,
        filename: input.payloadName,
        stage: "preparing",
        bytesUploaded: 0,
        encryptedSize: 0,
        startedAt: Date.now(),
      },
    }));
    try {
      ensureCurrent();
      const identity = getPassphraseRef.current();
      if (!identity) throw new Error("Unlock the vault before uploading.");
      onStarted?.(id);
      ensureCurrent();
      const context = await createResumablePayloadContext(identity);
      ensureCurrent();
      const encryptedSize = encryptedPayloadSize(input.file, input.payloadName, context);
      updateItem(id, { stage: "meta", encryptedSize });
      const encryptedMeta = await encryptMetaZip(identity, { details: input.details, thumbnailBytes: input.thumbnailBytes, thumbnailFilename: input.thumbnailFilename });
      ensureCurrent();
      const metaResponse = await fetch("/api/drive/upload/meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId: input.folderId, encryptedMetaSize: encryptedMeta.byteLength, opaqueId: input.opaqueId }),
        signal: setupController.signal,
      });
      ensureCurrent();
      if (!metaResponse.ok) throw new Error(await responseMessage(metaResponse));
      const meta = await metaResponse.json() as { metaFile?: { id?: unknown }; sessionUrl?: unknown };
      if (typeof meta.metaFile?.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(meta.metaFile.id)) {
        throw new Error("Drive returned an invalid metadata upload session.");
      }
      createdMetaFileId = meta.metaFile.id;
      const remoteTarget = { metaFileId: createdMetaFileId };
      remoteTargetsRef.current.set(id, remoteTarget);
      updateItem(id, { stage: "meta", metaFileId: createdMetaFileId });
      if (typeof meta.sessionUrl !== "string") throw new Error("Drive returned an invalid metadata upload session.");
      const metaSessionUrl = validateDriveUploadSessionUrl(meta.sessionUrl);
      await uploadEncryptedMeta(metaSessionUrl, encryptedMeta, setupController.signal);
      ensureCurrent();

      const metaCompleteResponse = await fetch("/api/drive/upload/meta-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metaFileId: createdMetaFileId }),
        signal: setupController.signal,
      });
      ensureCurrent();
      if (!metaCompleteResponse.ok) throw new Error(await responseMessage(metaCompleteResponse));

      const sessionResponse = await fetch("/api/drive/upload/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ metaFileId: createdMetaFileId, encryptedSize }), signal: setupController.signal });
      ensureCurrent();
      if (!sessionResponse.ok) throw new Error(await responseMessage(sessionResponse));
      const session = await sessionResponse.json() as { payloadFileId: string; sessionUrl: string; finalizationRequired?: boolean };
      if (typeof session.payloadFileId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(session.payloadFileId)) {
        throw new Error("Drive returned an invalid payload upload session.");
      }
      createdPayloadFileId = session.payloadFileId;
      remoteTargetsRef.current.set(id, { metaFileId: createdMetaFileId, payloadFileId: createdPayloadFileId });
      updateItem(id, { metaFileId: createdMetaFileId, payloadFileId: createdPayloadFileId });
      const sessionUrl = validateDriveUploadSessionUrl(session.sessionUrl);
      const state: UploadSession = {
        id, folderId: input.folderId, filename: input.payloadName, descriptor, sessionUrl,
        metaFileId: createdMetaFileId, payloadFileId: createdPayloadFileId, encryptedSize, bytesUploaded: 0,
        context: await sealUploadContext(identity, context), finalizationRequired: session.finalizationRequired,
      };
      ensureCurrent();
      sessionsRef.current[id] = state;
      sessionReady = true;
      updateItem(id, { stage: "encrypting", metaFileId: state.metaFileId, payloadFileId: state.payloadFileId, resumable: true });
      await uploadPayload(id, input.file, input.payloadName, context, state, generation, setupController.signal);
    } catch (error) {
      const message = uploadErrorMessage(error);
      if (generation === sensitiveGenerationRef.current) {
        let cleanupFailed = false;
        const remoteTarget = remoteTargetsRef.current.get(id);
        const target = remoteTarget ?? (createdMetaFileId
          ? { metaFileId: createdMetaFileId, ...(createdPayloadFileId ? { payloadFileId: createdPayloadFileId } : {}) }
          : undefined);
        if (!sessionReady) {
          const alreadyCleanedByCancellation = cancelRequestedRef.current.has(id) && !remoteTarget;
          if (target && !alreadyCleanedByCancellation) {
            delete sessionsRef.current[id];
            try {
              await cleanupRemoteTarget(id, target, generation);
            } catch {
              cleanupFailed = true;
            }
          }
          if (generation === sensitiveGenerationRef.current) {
            if (cancelRequestedRef.current.has(id) && !cleanupFailed) {
              delete sessionsRef.current[id];
              remoteTargetsRef.current.delete(id);
              setUploadItems((previous) => { const next = { ...previous }; delete next[id]; return next; });
            } else if (cleanupFailed) {
              updateItem(id, {
                stage: "failed",
                error: `${message} Remote cleanup failed; retry cancellation later.`,
                metaFileId: target?.metaFileId,
                payloadFileId: target?.payloadFileId,
                resumable: true,
              });
            } else {
              updateItem(id, {
                stage: "failed",
                error: message,
                metaFileId: undefined,
                payloadFileId: undefined,
                resumable: false,
              });
            }
          }
        }
      }
      throw new Error(message);
    } finally {
      if (setupControllersRef.current.get(id) === setupController) {
        setupControllersRef.current.delete(id);
      }
      if (setupController.signal.aborted) cancelRequestedRef.current.delete(id);
    }
  }, [cleanupRemoteTarget, setUploadItems, updateItem, uploadPayload]);

  const resumeUpload = useCallback(async (id: string, file: File) => {
    if (setupControllersRef.current.has(id) || controllersRef.current.has(id)) {
      throw new Error("This upload is already active.");
    }
    const generation = sensitiveGenerationRef.current;
    const setupController = new AbortController();
    setupControllersRef.current.set(id, setupController);
    try {
      if (generation !== sensitiveGenerationRef.current || setupController.signal.aborted) {
        throw new DOMException("Upload paused", "AbortError");
      }
      const identity = getPassphraseRef.current();
      const state = sessionsRef.current[id];
      if (!identity || !state) throw new Error("This upload can no longer be resumed.");
      if (!isSameSource(file, state.descriptor)) throw new Error("Choose the same original file to resume this upload.");
      const context = await unsealUploadContext(identity, state.context);
      if (generation !== sensitiveGenerationRef.current || setupController.signal.aborted) {
        throw new DOMException("Upload paused", "AbortError");
      }
      updateItem(id, { stage: "encrypting", error: undefined });
      await uploadPayload(id, file, state.filename, context, state, generation, setupController.signal);
    } finally {
      if (setupControllersRef.current.get(id) === setupController) {
        setupControllersRef.current.delete(id);
      }
      if (setupController.signal.aborted) cancelRequestedRef.current.delete(id);
    }
  }, [updateItem, uploadPayload]);

  const cancelUpload = useCallback(async (id: string) => {
    const generation = sensitiveGenerationRef.current;
    cancelRequestedRef.current.add(id);
    setupControllersRef.current.get(id)?.abort();
    controllersRef.current.get(id)?.abort();
    const state = sessionsRef.current[id];
    const item = uploadItems[id];
    const target = remoteTargetsRef.current.get(id) ?? (state
      ? { metaFileId: state.metaFileId, payloadFileId: state.payloadFileId }
      : item?.metaFileId
        ? { metaFileId: item.metaFileId, ...(item.payloadFileId ? { payloadFileId: item.payloadFileId } : {}) }
        : undefined);
    const hasRunner = () => setupControllersRef.current.has(id) || controllersRef.current.has(id);
    if (target && generation === sensitiveGenerationRef.current) {
      try {
        await cleanupRemoteTarget(id, target, generation);
      } catch {
        if (generation !== sensitiveGenerationRef.current) return;
        updateItem(id, {
          stage: "failed",
          error: "Remote cleanup failed; retry cancellation later.",
          metaFileId: target.metaFileId,
          payloadFileId: target.payloadFileId,
          resumable: true,
        });
        if (!hasRunner()) cancelRequestedRef.current.delete(id);
        return;
      }
    }
    if (generation !== sensitiveGenerationRef.current) return;
    if (state) {
      delete sessionsRef.current[id];
      remoteTargetsRef.current.delete(id);
    }
    setUploadItems((previous) => { const next = { ...previous }; delete next[id]; return next; });
    if (!hasRunner()) cancelRequestedRef.current.delete(id);
  }, [setUploadItems, updateItem, uploadItems, cleanupRemoteTarget]);

  const clearUploadHistory = useCallback(() => {
    const runningIds = new Set([
      ...setupControllersRef.current.keys(),
      ...controllersRef.current.keys(),
      ...cleanupControllersRef.current.keys(),
    ]);
    const clearableIds = Object.values(uploadItemsRef.current)
      .filter((item) => (item.stage === "complete" || item.stage === "failed") && !runningIds.has(item.id))
      .map((item) => item.id);
    if (clearableIds.length === 0) return;

    for (const id of clearableIds) {
      delete sessionsRef.current[id];
      remoteTargetsRef.current.delete(id);
    }
    const ids = new Set(clearableIds);
    setUploadItems((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => !ids.has(id))));
  }, [setUploadItems]);

  return <FileUploadContext.Provider value={{ uploadItems, startUpload, resumeUpload, cancelUpload, clearUploadHistory }}>{children}</FileUploadContext.Provider>;
}

export function useFileUpload() {
  const context = useContext(FileUploadContext);
  if (!context) throw new Error("useFileUpload must be used within FileUploadProvider");
  return context;
}
