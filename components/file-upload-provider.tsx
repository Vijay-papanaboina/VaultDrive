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

export type UploadStage = "preparing" | "meta" | "encrypting" | "uploading" | "retrying" | "paused" | "complete" | "failed";

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
}

interface NewUpload {
  folderId: string;
  file: File;
  payloadName: string;
  details: MetaDetails;
  thumbnailBytes: Uint8Array | null;
  thumbnailFilename: string | null;
}

interface FileUploadContextValue {
  uploadItems: Record<string, UploadItem>;
  startUpload(input: NewUpload): Promise<void>;
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

async function responseMessage(response: Response): Promise<string> {
  return (await response.text()).trim() || `Upload failed: HTTP ${response.status}`;
}

export function FileUploadProvider({ children }: { children: React.ReactNode }) {
  const { getPassphrase, hasPassphrase } = useCrypto();
  const [uploadItems, setUploadItems] = useState<Record<string, UploadItem>>({});
  const persistedRef = useRef<Record<string, PersistedUpload>>({});
  const controllersRef = useRef(new Map<string, AbortController>());

  const updateItem = useCallback((id: string, update: Partial<UploadItem>) => {
    setUploadItems((previous) => previous[id] ? { ...previous, [id]: { ...previous[id], ...update } } : previous);
  }, []);

  const savePersisted = useCallback(async (identity: string) => {
    const sealed = await Promise.all(Object.values(persistedRef.current).map(async (item) => ({ id: item.id, data: await sealUploadState(identity, item) })));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sealed));
  }, []);

  useEffect(() => {
    const identity = getPassphrase();
    if (!hasPassphrase || !identity) return;
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
        if (!cancelled) {
          persistedRef.current = restored;
          setUploadItems((previous) => ({ ...previous, ...items }));
        }
      } catch {
        // State belongs to another passphrase or was damaged. Keep it unreadable.
      }
    })();
    return () => { cancelled = true; };
  }, [getPassphrase, hasPassphrase]);

  const uploadPayload = useCallback(async (
    id: string,
    identity: string,
    file: File,
    payloadName: string,
    context: ResumablePayloadContext,
    state: PersistedUpload,
  ) => {
    const controller = new AbortController();
    controllersRef.current.set(id, controller);
    try {
      const encrypted = createResumableEncryptedPayloadStream(file, payloadName, context, state.bytesUploaded);
      const reader = encrypted.getReader();
      let carried: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
      let offset = state.bytesUploaded;

      const readChunk = async (): Promise<Uint8Array | null> => {
        const parts: Uint8Array[] = [];
        let size = 0;
        if (carried.byteLength) {
          parts.push(carried);
          size = carried.byteLength;
          carried = new Uint8Array(0);
        }
        while (size < DRIVE_CHUNK_SIZE) {
          const { done, value } = await reader.read();
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

      const queryStatus = async () => {
        const response = await fetch(state.sessionUrl, {
          method: "PUT", headers: { "Content-Range": `bytes */${state.encryptedSize}` }, signal: controller.signal,
        });
        if (response.ok) return { complete: true, offset: state.encryptedSize };
        if (response.status !== 308) throw new Error(await responseMessage(response));
        return { complete: false, offset: parseReceivedOffset(response) };
      };

      while (true) {
        const chunk = await readChunk();
        if (!chunk) break;
        const chunkStart = offset;
        let sentFrom = 0;
        let attempts = 0;
        while (sentFrom < chunk.byteLength) {
          updateItem(id, { stage: attempts ? "retrying" : "uploading", bytesUploaded: chunkStart + sentFrom });
          const body = chunk.subarray(sentFrom);
          try {
            const response = await fetch(state.sessionUrl, {
              method: "PUT",
              headers: { "Content-Range": `bytes ${chunkStart + sentFrom}-${chunkStart + chunk.byteLength - 1}/${state.encryptedSize}` },
              body: asUploadBody(body), signal: controller.signal,
            });
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
            const status = await queryStatus();
            if (status.complete) { offset = state.encryptedSize; sentFrom = chunk.byteLength; break; }
            if (status.offset < chunkStart || status.offset > chunkStart + chunk.byteLength) throw new Error("Drive resumed outside the current encrypted chunk.");
            sentFrom = status.offset - chunkStart;
            offset = status.offset;
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
          }
        }
        state.bytesUploaded = offset;
        persistedRef.current[id] = state;
        await savePersisted(identity);
        updateItem(id, { bytesUploaded: offset, stage: "encrypting" });
      }
      reader.releaseLock();
      if (offset !== state.encryptedSize) throw new Error("Encrypted stream ended before Drive received all bytes.");
      const finished = await fetch("/api/drive/upload/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metaFileId: state.metaFileId, payloadFileId: state.payloadFileId }),
      });
      if (!finished.ok) throw new Error(await responseMessage(finished));
      delete persistedRef.current[id];
      await savePersisted(identity);
      updateItem(id, { stage: "complete", bytesUploaded: offset, resumable: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      updateItem(id, { stage: controller.signal.aborted ? "paused" : "failed", error: controller.signal.aborted ? "Upload paused" : message, resumable: true });
      throw error;
    } finally {
      controllersRef.current.delete(id);
    }
  }, [savePersisted, updateItem]);

  const startUpload = useCallback(async (input: NewUpload) => {
    const identity = getPassphrase();
    if (!identity) throw new Error("Unlock the vault before uploading.");
    const id = crypto.randomUUID();
    const descriptor: PayloadDescriptor = { filename: input.file.name, size: input.file.size, lastModified: input.file.lastModified };
    updateItem(id, { id, folderId: input.folderId, filename: input.payloadName, stage: "preparing", bytesUploaded: 0, encryptedSize: 0, startedAt: Date.now() });
    try {
      const context = await createResumablePayloadContext(identity);
      const encryptedSize = encryptedPayloadSize(input.file, input.payloadName, context);
      updateItem(id, { stage: "meta", encryptedSize });
      const encryptedMeta = await encryptMetaZip(identity, { details: input.details, thumbnailBytes: input.thumbnailBytes, thumbnailFilename: input.thumbnailFilename });
      const metaResponse = await fetch("/api/drive/upload/meta", { method: "POST", headers: { "Content-Type": "application/octet-stream", "x-vault-folder-id": input.folderId }, body: asUploadBody(encryptedMeta) });
      if (!metaResponse.ok) throw new Error(await responseMessage(metaResponse));
      const meta = await metaResponse.json() as { metaFile: { id: string }; opaqueId: string };
      const sessionResponse = await fetch("/api/drive/upload/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ metaFileId: meta.metaFile.id, encryptedSize }) });
      if (!sessionResponse.ok) throw new Error(await responseMessage(sessionResponse));
      const session = await sessionResponse.json() as { payloadFileId: string; sessionUrl: string };
      const state: PersistedUpload = {
        id, folderId: input.folderId, filename: input.payloadName, descriptor, sessionUrl: session.sessionUrl,
        metaFileId: meta.metaFile.id, payloadFileId: session.payloadFileId, encryptedSize, bytesUploaded: 0,
        context: await sealUploadContext(identity, context),
      };
      persistedRef.current[id] = state;
      await savePersisted(identity);
      updateItem(id, { stage: "encrypting", metaFileId: state.metaFileId, payloadFileId: state.payloadFileId, resumable: true });
      await uploadPayload(id, identity, input.file, input.payloadName, context, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      updateItem(id, { stage: "failed", error: message });
      throw error;
    }
  }, [getPassphrase, savePersisted, updateItem, uploadPayload]);

  const resumeUpload = useCallback(async (id: string, file: File) => {
    const identity = getPassphrase();
    const state = persistedRef.current[id];
    if (!identity || !state) throw new Error("This upload can no longer be resumed.");
    if (!isSameSource(file, state.descriptor)) throw new Error("Choose the same original file to resume this upload.");
    const context = await unsealUploadContext(identity, state.context);
    updateItem(id, { stage: "encrypting", error: undefined });
    await uploadPayload(id, identity, file, state.filename, context, state);
  }, [getPassphrase, updateItem, uploadPayload]);

  const cancelUpload = useCallback(async (id: string) => {
    controllersRef.current.get(id)?.abort();
    const state = persistedRef.current[id];
    if (state) {
      await fetch("/api/drive/upload/cleanup", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ metaFileId: state.metaFileId, payloadFileId: state.payloadFileId }) });
      delete persistedRef.current[id];
      const identity = getPassphrase();
      if (identity) await savePersisted(identity);
    }
    setUploadItems((previous) => { const next = { ...previous }; delete next[id]; return next; });
  }, [getPassphrase, savePersisted]);

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
