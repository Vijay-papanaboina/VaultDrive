"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Calendar, FileUp, ImagePlus, Loader2, RotateCcw, Upload, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { IMAGE_EXTS, inferMimeType } from "@/lib/crypto";
import { type UploadItem, useFileUpload } from "@/components/file-upload-provider";
import { useCrypto } from "@/hooks/use-crypto";

interface UploadModalProps {
  folderId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onUploaded(): void;
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = -1;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

function uploadPhase(item: UploadItem): string {
  switch (item.stage) {
    case "preparing": return "Preparing encrypted upload";
    case "meta": return "Encrypting file details";
    case "encrypting":
    case "uploading": return "Encrypting and uploading";
    case "retrying": return "Reconnecting to Drive";
    case "finalizing": return "Finalizing encrypted upload";
    case "paused": return "Upload paused";
    case "complete": return "Upload complete";
    case "failed": return "Upload failed";
  }
}

function uploadPercent(item: UploadItem): number {
  if (item.stage === "complete" || item.stage === "finalizing" || (item.encryptedSize > 0 && item.bytesUploaded >= item.encryptedSize)) return 100;
  if (item.encryptedSize > 0) return Math.min(99, Math.round((item.bytesUploaded / item.encryptedSize) * 100));
  return item.stage === "meta" ? 8 : item.stage === "preparing" ? 3 : 0;
}

export function UploadModal({ folderId, open, onOpenChange, onUploaded }: UploadModalProps) {
  const { startUpload, resumeUpload, uploadItems } = useFileUpload();
  const { registerSensitiveCleanup } = useCrypto();
  const originalRef = useRef<HTMLInputElement>(null);
  const thumbnailRef = useRef<HTMLInputElement>(null);
  const [original, setOriginal] = useState<File | null>(null);
  const [thumbnail, setThumbnail] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [fileId, setFileId] = useState("");
  const [thumbnailName, setThumbnailName] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState("");
  const [extraJson, setExtraJson] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const currentUpload = uploadId ? uploadItems[uploadId] : undefined;
  const isUploadActive = Boolean(
    submitting || (currentUpload && !["paused", "complete", "failed"].includes(currentUpload.stage))
  );
  const canResumeCurrentUpload = Boolean(
    original && currentUpload?.resumable && (currentUpload.stage === "failed" || currentUpload.stage === "paused")
  );

  const clearNativeFileInputs = useCallback(() => {
    if (originalRef.current) originalRef.current.value = "";
    if (thumbnailRef.current) thumbnailRef.current.value = "";
  }, []);

  const clearSensitiveState = useCallback(() => {
    setOriginal(null);
    setThumbnail(null);
    setName("");
    setFileId("");
    setThumbnailName("");
    setDescription("");
    setDate("");
    setExtraJson("{}");
    setError(null);
    setSubmitting(false);
    setUploadId(null);
    setShowSuccess(false);
    clearNativeFileInputs();
    onOpenChange(false);
  }, [clearNativeFileInputs, onOpenChange]);

  useEffect(() => registerSensitiveCleanup(clearSensitiveState), [clearSensitiveState, registerSensitiveCleanup]);

  function clearFormAfterSuccess() {
    setOriginal(null);
    setThumbnail(null);
    setName("");
    setFileId("");
    setThumbnailName("");
    setDescription("");
    setDate("");
    setExtraJson("{}");
    setError(null);
    clearNativeFileInputs();
    setShowSuccess(true);
  }

  function closeModal() {
    if (isUploadActive) return;
    setUploadId(null);
    setShowSuccess(false);
    onOpenChange(false);
  }

  function pickOriginal(file: File | undefined) {
    if (!file || isUploadActive) return;
    setOriginal(file);
    setName((value) => value || file.name);
    setDate((value) => value || new Date().toISOString());
    setError(null);
    setShowSuccess(false);
  }

  function pickThumbnail(file: File | undefined) {
    if (!file || isUploadActive) return;
    if (!file.type.startsWith("image/") && !IMAGE_EXTS.test(file.name)) {
      setError("Preview must be an image file.");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setError("Preview must be 25 MB or smaller.");
      return;
    }
    setThumbnail(file);
    setThumbnailName(file.name);
    setError(null);
  }

  async function submit() {
    if (isUploadActive) return;
    if (canResumeCurrentUpload) {
      await resumeCurrentUpload();
      return;
    }
    if (!original) { setError("Choose the original file first."); return; }
    const chosenName = name.trim();
    const chosenFileId = fileId.trim();
    if (!chosenName) { setError("Enter a name for this file."); return; }
    if (chosenFileId && !/^\d{1,32}$/.test(chosenFileId)) { setError("File ID must contain only 1 to 32 digits."); return; }
    let extra: Record<string, unknown> | undefined;
    try {
      const parsed = extraJson.trim() ? JSON.parse(extraJson) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Extra metadata must be a JSON object.");
      extra = { ...parsed, size_bytes: original.size, mime_type: original.type || inferMimeType(original.name) };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Extra metadata is not valid JSON.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setShowSuccess(false);
    setUploadId(null);
    try {
      const thumbnailBytes = thumbnail ? new Uint8Array(await thumbnail.arrayBuffer()) : null;
      await startUpload({
        folderId, file: original, payloadName: chosenName, opaqueId: chosenFileId || undefined,
        details: {
          name: chosenName,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(date.trim() ? { date: date.trim() } : {}),
          extra,
        },
        thumbnailBytes,
        thumbnailFilename: thumbnailBytes ? (thumbnailName.trim() || thumbnail?.name || "thumbnail.webp") : null,
      }, setUploadId);
      onUploaded();
      clearFormAfterSuccess();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload could not start.");
    } finally {
      setSubmitting(false);
    }
  }

  async function resumeCurrentUpload() {
    if (isUploadActive) return;
    if (!original || !currentUpload) {
      setError("Choose the same original file to resume this upload.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setShowSuccess(false);
    try {
      await resumeUpload(currentUpload.id, original);
      onUploaded();
      clearFormAfterSuccess();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload could not resume.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!next) {
        closeModal();
        return;
      }
      onOpenChange(true);
    }}>
      <DialogContent className="max-h-[94vh] w-[98vw] max-w-[98vw] overflow-y-auto border-white/10 bg-[#0f0f13]/95 text-foreground backdrop-blur-2xl sm:max-w-[min(98vw,90rem)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Upload className="h-5 w-5 text-emerald-400" />Add encrypted file</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">Meta uploads first. Original bytes encrypt and upload in chunks; real names stay inside ciphertext.</DialogDescription>
        </DialogHeader>

        <div className="mt-3 space-y-4">
          <input ref={originalRef} type="file" disabled={isUploadActive} className="hidden" onChange={(event) => pickOriginal(event.target.files?.[0])} />
          <button type="button" disabled={isUploadActive} onClick={() => originalRef.current?.click()} className="flex w-full items-center gap-3 rounded-xl border border-dashed border-emerald-500/35 bg-emerald-500/5 p-4 text-left hover:border-emerald-400/60 hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-60">
            <span className="rounded-lg bg-emerald-400/10 p-2"><FileUp className="h-5 w-5 text-emerald-400" /></span>
            <span className="min-w-0"><span className="block text-sm font-medium">{original ? original.name : "Choose original file"}</span><span className="block text-xs text-muted-foreground">{original ? `${fileSize(original.size)} · streamed from disk` : "No whole-file memory copy"}</span></span>
          </button>

          <label className="space-y-1.5 text-xs text-muted-foreground"><span>Name</span><Input value={name} readOnly={isUploadActive} onChange={(event) => setName(event.target.value)} placeholder="Shown in VaultDrive and used on download" /><span className="block">This one name is stored in both encrypted file details and the download header.</span></label>
          <label className="space-y-1.5 text-xs text-muted-foreground"><span>File ID (optional)</span><Input value={fileId} readOnly={isUploadActive} onChange={(event) => setFileId(event.target.value)} inputMode="numeric" pattern="[0-9]*" placeholder="Leave blank to generate one" /><span className="block">Used for the encrypted Drive pair. Leave it empty to generate a random ID.</span></label>
          <label className="space-y-1.5 text-xs text-muted-foreground"><span>Description</span><textarea value={description} readOnly={isUploadActive} onChange={(event) => setDescription(event.target.value)} className="min-h-18 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-foreground outline-none focus:border-emerald-400/60" /></label>
          <label className="space-y-1.5 text-xs text-muted-foreground"><span className="flex items-center gap-1"><Calendar className="h-3 w-3" />Date</span><Input value={date} readOnly={isUploadActive} onChange={(event) => setDate(event.target.value)} placeholder="Auto-filled when original file is selected" /></label>
          <label className="space-y-1.5 text-xs text-muted-foreground"><span>Extra JSON — size_bytes is set automatically</span><textarea value={extraJson} readOnly={isUploadActive} onChange={(event) => setExtraJson(event.target.value)} className="min-h-20 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-emerald-400/60" /></label>

          <input ref={thumbnailRef} type="file" accept="image/*" disabled={isUploadActive} className="hidden" onChange={(event) => pickThumbnail(event.target.files?.[0])} />
          <div className="rounded-xl border border-white/10 bg-white/3 p-3">
            <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-medium">Preview thumbnail</p><p className="text-xs text-muted-foreground">Optional; stored only inside encrypted meta ZIP.</p></div><button type="button" disabled={isUploadActive} onClick={() => thumbnailRef.current?.click()} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"><ImagePlus className="mr-1 inline h-3.5 w-3.5" />{thumbnail ? "Replace" : "Choose"}</button></div>
            {thumbnail && <div className="mt-3 flex gap-2"><Input value={thumbnailName} readOnly={isUploadActive} onChange={(event) => setThumbnailName(event.target.value)} /><button type="button" disabled={isUploadActive} onClick={() => { setThumbnail(null); setThumbnailName(""); if (thumbnailRef.current) thumbnailRef.current.value = ""; }} className="rounded-lg border border-white/10 px-2 text-muted-foreground hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-60"><X className="h-4 w-4" /></button></div>}
          </div>
          {currentUpload && <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-3" role="status" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-xs"><span className="font-medium text-foreground">{uploadPhase(currentUpload)}</span><span className="tabular-nums text-muted-foreground">{uploadPercent(currentUpload)}%</span></div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10"><div className={`h-full rounded-full transition-[width] duration-300 ${currentUpload.stage === "failed" ? "bg-amber-400" : "bg-emerald-400"}`} style={{ width: `${uploadPercent(currentUpload)}%` }} /></div>
            <p className="mt-2 text-xs text-muted-foreground">{currentUpload.encryptedSize ? `${fileSize(currentUpload.bytesUploaded)} / ${fileSize(currentUpload.encryptedSize)} encrypted` : "Calculating encrypted upload size…"}</p>
            {currentUpload.error && <p className="mt-2 text-xs text-amber-200">{currentUpload.error}</p>}
            {canResumeCurrentUpload && <p className="mt-2 text-xs text-muted-foreground">Resume continues the existing encrypted Drive upload; the selected source is re-encrypted only from Drive’s confirmed byte offset.</p>}
          </div>}
          {showSuccess && <p className="rounded-lg border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200" role="status">Encrypted upload complete. You can add another file or close this window.</p>}
          {error && <p className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">{error}</p>}
          <div className="flex justify-end gap-2"><button type="button" disabled={isUploadActive} onClick={closeModal} className="rounded-lg px-3 py-2 text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50">Close</button>{canResumeCurrentUpload ? <button type="button" disabled={isUploadActive} onClick={() => void resumeCurrentUpload()} className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{submitting ? <><Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />Resuming upload</> : <><RotateCcw className="mr-1 inline h-3.5 w-3.5" />Resume upload</>}</button> : <button type="button" disabled={!original || isUploadActive} onClick={submit} className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{submitting ? <><Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />{currentUpload ? uploadPhase(currentUpload) : "Preparing upload"}</> : "Encrypt & upload"}</button>}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
