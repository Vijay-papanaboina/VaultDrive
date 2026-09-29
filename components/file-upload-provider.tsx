"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { MetaDetails } from "@/types";
import { encryptMetaZip } from "@/lib/crypto";
import {
  createResumableEncryptedPayloadStream,
  createResumablePayloadContext,
  encryptedPayloadSize,
  sealUploadContext,
  sealUploadState,
  unsealUploadContext,
  unsealUploadState,
  type PayloadDescriptor,
  type ResumablePayloadContext,
} from "@/lib/resumable-payload";
import { useCrypto } from "@/hooks/use-crypto";

const DRIVE_CHUNK_SIZE = 8 * 1024 * 1024;
const STORAGE_KEY = "vaultdrive.uploads.v1";
const FINALIZATION_ATTEMPTS = 3;
const UPLOAD_SESSION_HEADER = "x-vault-upload-session";

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

interface PersistedUpload {
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

function parseReceivedOffset(response: Response): number {
  const range = response.headers.get("Range");
  const match = range?.match(/bytes=0-(\d+)/i);
  return match ? Number(match[1]) + 1 : 0;
}

function replacementSessionUrl(response: Response): string | undefined {
  const location = response.headers.get("Location");
  if (!location) return undefined;

  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new Error("Drive returned an invalid resumable upload URL.");
  }

  const isDriveUploadPath = /^\/upload\/drive\/v3\/files(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname);
  const uploadTypes = url.searchParams.getAll("uploadType");
  const uploadIds = url.searchParams.getAll("upload_id");
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.googleapis.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !isDriveUploadPath ||
    uploadTypes.length !== 1 ||
    uploadTypes[0] !== "resumable" ||
    uploadIds.length !== 1 ||
    !/^[A-Za-z0-9_-]+$/.test(uploadIds[0])
  ) {
    throw new Error("Drive returned an invalid resumable upload URL.");
  }

  return url.toString();
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

function proxyResumableUpload(
  sessionUrl: string,
  contentRange: string,
  body: ArrayBuffer | undefined,
  signal: AbortSignal
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Range": contentRange,
    [UPLOAD_SESSION_HEADER]: sessionUrl,
  };
  if (body) headers["Content-Type"] = "application/octet-stream";
  return fetch("/api/drive/upload/chunk", {
    method: "POST",
    headers,
    ...(body ? { body } : {}),
    signal,
  });
}

export function FileUploadProvider({ children }: { children: React.ReactNode }) {
  const { getPassphrase, hasPassphrase, keyVersion, registerSensitiveCleanup } = useCrypto();
  const [uploadItems, setUploadItems] = useState<Record<string, UploadItem>>({});
  const persistedRef = useRef<Record<string, PersistedUpload>>({});
  const controllersRef = useRef(new Map<string, AbortController>());
  const setupControllersRef = useRef(new Map<string, AbortController>());
  const readersRef = useRef(new Set<ReadableStreamDefaultReader<Uint8Array>>());
  const sensitiveGenerationRef = useRef(0);

  const clearSensitiveState = useCallback(() => {
    sensitiveGenerationRef.current += 1;
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    setupControllersRef.current.forEach((controller) => controller.abort());
    setupControllersRef.current.clear();
    readersRef.current.forEach((reader) => void reader.cancel().catch(() => undefined));
    readersRef.current.clear();
    // The localStorage records remain sealed for a later, explicit resume.
    persistedRef.current = {};
    setUploadItems({});
  }, []);

  useEffect(() => registerSensitiveCleanup(clearSensitiveState), [clearSensitiveState, registerSensitiveCleanup]);

  const updateItem = useCallback((id: string, update: Partial<UploadItem>) => {
    setUploadItems((previous) => previous[id] ? { ...previous, [id]: { ...previous[id], ...update } } : previous);
  }, []);

  const savePersisted = useCallback(async (identity: string, generation: number) => {
    const states = Object.values(persistedRef.current);
    const sealed = await Promise.all(states.map(async (item) => ({ id: item.id, data: await sealUploadState(identity, item) })));
    if (generation !== sensitiveGenerationRef.current) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sealed));
  }, []);

  useEffect(() => {
    const identity = getPassphrase();
    if (!hasPassphrase || !identity) return;
    const generation = sensitiveGenerationRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const entries = JSON.parse(raw) as Array<{ id: string; data: string }>;
        const restored: Record<string, PersistedUpload> = {};
        const items: Record<string, UploadItem> = {};
        for (const entry of entries) {
          const state = await unsealUploadState<PersistedUpload>(identity, entry.data);
          restored[state.id] = state;
          items[state.id] = {
            id: state.id, folderId: state.folderId, filename: state.filename, stage: "paused",
            bytesUploaded: state.bytesUploaded, encryptedSize: state.encryptedSize, startedAt: Date.now(),
            metaFileId: state.metaFileId, payloadFileId: state.payloadFileId, resumable: true,
          };
        }
        if (!cancelled && generation === sensitiveGenerationRef.current) {
          persistedRef.current = restored;
          setUploadItems((previous) => ({ ...previous, ...items }));
        }
      } catch {
        // State belongs to another passphrase or was damaged. Keep it unreadable.
      }
    })();
    return () => { cancelled = true; };
  }, [getPassphrase, hasPassphrase, keyVersion]);

  const uploadPayload = useCallback(async (
    id: string,
    identity: string,
    file: File,
    payloadName: string,
    context: ResumablePayloadContext,
    state: PersistedUpload,
    generation: number,
  ) => {
    const ensureCurrent = () => {
      if (generation !== sensitiveGenerationRef.current) {
        throw new DOMException("Upload paused", "AbortError");
      }
    };
    ensureCurrent();
    const controller = new AbortController();
    controllersRef.current.set(id, controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const acceptReplacementSessionUrl = async (response: Response) => {
        const replacement = replacementSessionUrl(response);
        if (!replacement || replacement === state.sessionUrl) return;
        state.sessionUrl = replacement;
        persistedRef.current[id] = state;
        await savePersisted(identity, generation);
        ensureCurrent();
      };

      const queryStatus = async () => {
        const response = await proxyResumableUpload(
          state.sessionUrl,
          `bytes */${state.encryptedSize}`,
          undefined,
          controller.signal,
        );
        await acceptReplacementSessionUrl(response);
        ensureCurrent();
        if (response.ok) return { complete: true, offset: state.encryptedSize };
        if (response.status !== 308) throw new Error(await responseMessage(response));
        const offset = parseReceivedOffset(response);
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
        persistedRef.current[id] = state;
        await savePersisted(identity, generation);
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
            while (size < DRIVE_CHUNK_SIZE) {
              const { done, value } = await encryptedReader.read();
              ensureCurrent();
              if (done) break;
              if (!value?.byteLength) continue;
              const needed = DRIVE_CHUNK_SIZE - size;
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
                const response = await proxyResumableUpload(
                  state.sessionUrl,
                  `bytes ${chunkStart + sentFrom}-${chunkStart + chunk.byteLength - 1}/${state.encryptedSize}`,
                  asUploadBody(body),
                  controller.signal,
                );
                await acceptReplacementSessionUrl(response);
                ensureCurrent();
                if (response.ok) {
                  offset = state.encryptedSize;
                  sentFrom = chunk.byteLength;
                  break;
                }
                if (response.status !== 308) throw new Error(await responseMessage(response));
                const received = parseReceivedOffset(response);
                if (received < chunkStart || received > chunkStart + chunk.byteLength) throw new Error("Drive returned an unexpected upload offset.");
                sentFrom = received - chunkStart;
                offset = received;
              } catch (error) {
                if (controller.signal.aborted) throw error;
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
            persistedRef.current[id] = state;
            await savePersisted(identity, generation);
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
      delete persistedRef.current[id];
      await savePersisted(identity, generation);
      ensureCurrent();
      updateItem(id, { stage: "complete", bytesUploaded: offset, resumable: false });
    } catch (error) {
      const message = uploadErrorMessage(error, state.bytesUploaded >= state.encryptedSize);
      if (generation === sensitiveGenerationRef.current) {
        updateItem(id, { stage: controller.signal.aborted ? "paused" : "failed", error: controller.signal.aborted ? "Upload paused." : message, resumable: true });
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
  }, [savePersisted, updateItem]);

  const startUpload = useCallback(async (input: NewUpload, onStarted?: (id: string) => void) => {
    const generation = sensitiveGenerationRef.current;
    const ensureCurrent = () => {
      if (generation !== sensitiveGenerationRef.current) {
        throw new DOMException("Upload paused", "AbortError");
      }
    };
    const identity = getPassphrase();
    if (!identity) throw new Error("Unlock the vault before uploading.");
    const id = crypto.randomUUID();
    onStarted?.(id);
    const setupController = new AbortController();
    setupControllersRef.current.set(id, setupController);
    const descriptor: PayloadDescriptor = { filename: input.file.name, size: input.file.size, lastModified: input.file.lastModified };
    updateItem(id, { id, folderId: input.folderId, filename: input.payloadName, stage: "preparing", bytesUploaded: 0, encryptedSize: 0, startedAt: Date.now() });
    try {
      const context = await createResumablePayloadContext(identity);
      ensureCurrent();
      const encryptedSize = encryptedPayloadSize(input.file, input.payloadName, context);
      updateItem(id, { stage: "meta", encryptedSize });
      const encryptedMeta = await encryptMetaZip(identity, { details: input.details, thumbnailBytes: input.thumbnailBytes, thumbnailFilename: input.thumbnailFilename });
      ensureCurrent();
      const metaHeaders: Record<string, string> = {
        "Content-Type": "application/octet-stream",
        "x-vault-folder-id": input.folderId,
      };
      if (input.opaqueId) metaHeaders["x-vault-opaque-id"] = input.opaqueId;
      const metaResponse = await fetch("/api/drive/upload/meta", { method: "POST", headers: metaHeaders, body: asUploadBody(encryptedMeta), signal: setupController.signal });
      ensureCurrent();
      if (!metaResponse.ok) throw new Error(await responseMessage(metaResponse));
      const meta = await metaResponse.json() as { metaFile: { id: string }; opaqueId: string };
      const sessionResponse = await fetch("/api/drive/upload/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ metaFileId: meta.metaFile.id, encryptedSize }), signal: setupController.signal });
      ensureCurrent();
      if (!sessionResponse.ok) throw new Error(await responseMessage(sessionResponse));
      const session = await sessionResponse.json() as { payloadFileId: string; sessionUrl: string; finalizationRequired?: boolean };
      const state: PersistedUpload = {
        id, folderId: input.folderId, filename: input.payloadName, descriptor, sessionUrl: session.sessionUrl,
        metaFileId: meta.metaFile.id, payloadFileId: session.payloadFileId, encryptedSize, bytesUploaded: 0,
        context: await sealUploadContext(identity, context), finalizationRequired: session.finalizationRequired,
      };
      ensureCurrent();
      persistedRef.current[id] = state;
      await savePersisted(identity, generation);
      ensureCurrent();
      updateItem(id, { stage: "encrypting", metaFileId: state.metaFileId, payloadFileId: state.payloadFileId, resumable: true });
      await uploadPayload(id, identity, input.file, input.payloadName, context, state, generation);
    } catch (error) {
      const message = uploadErrorMessage(error);
      if (generation === sensitiveGenerationRef.current) updateItem(id, { stage: "failed", error: message });
      throw new Error(message);
    } finally {
      if (setupControllersRef.current.get(id) === setupController) {
        setupControllersRef.current.delete(id);
      }
    }
  }, [getPassphrase, savePersisted, updateItem, uploadPayload]);

  const resumeUpload = useCallback(async (id: string, file: File) => {
    const generation = sensitiveGenerationRef.current;
    const identity = getPassphrase();
    const state = persistedRef.current[id];
    if (!identity || !state) throw new Error("This upload can no longer be resumed.");
    if (!isSameSource(file, state.descriptor)) throw new Error("Choose the same original file to resume this upload.");
    const context = await unsealUploadContext(identity, state.context);
    if (generation !== sensitiveGenerationRef.current) throw new DOMException("Upload paused", "AbortError");
    updateItem(id, { stage: "encrypting", error: undefined });
    await uploadPayload(id, identity, file, state.filename, context, state, generation);
  }, [getPassphrase, updateItem, uploadPayload]);

  const cancelUpload = useCallback(async (id: string) => {
    controllersRef.current.get(id)?.abort();
    const state = persistedRef.current[id];
    if (state) {
      let cleanupError: Error | undefined;
      try {
        const response = await fetch("/api/drive/upload/cleanup", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ metaFileId: state.metaFileId, payloadFileId: state.payloadFileId }),
        });
        if (!response.ok) cleanupError = new Error(await responseMessage(response));
      } catch (error) {
        cleanupError = new Error(uploadErrorMessage(error));
      }

      if (cleanupError) {
        updateItem(id, {
          stage: "failed",
          error: `Remote cleanup failed; retry cancellation later: ${cleanupError.message}`,
          resumable: true,
        });
        const identity = getPassphrase();
        if (identity) await savePersisted(identity, sensitiveGenerationRef.current);
        return;
      }
      delete persistedRef.current[id];
      const identity = getPassphrase();
      if (identity) await savePersisted(identity, sensitiveGenerationRef.current);
    }
    setUploadItems((previous) => { const next = { ...previous }; delete next[id]; return next; });
  }, [getPassphrase, savePersisted, updateItem]);

  const clearUploadHistory = useCallback(() => {
    setUploadItems((previous) => Object.fromEntries(Object.entries(previous).filter(([, item]) => item.stage !== "complete")));
  }, []);

  return <FileUploadContext.Provider value={{ uploadItems, startUpload, resumeUpload, cancelUpload, clearUploadHistory }}>{children}</FileUploadContext.Provider>;
}

export function useFileUpload() {
  const context = useContext(FileUploadContext);
  if (!context) throw new Error("useFileUpload must be used within FileUploadProvider");
  return context;
}
