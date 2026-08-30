"use client";

import { useRef, useState } from "react";
import { Calendar, FileUp, ImagePlus, Loader2, Upload, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { IMAGE_EXTS } from "@/lib/crypto";
import { useFileUpload } from "@/components/file-upload-provider";

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

export function UploadModal({ folderId, open, onOpenChange, onUploaded }: UploadModalProps) {
  const { startUpload } = useFileUpload();
  const originalRef = useRef<HTMLInputElement>(null);
  const thumbnailRef = useRef<HTMLInputElement>(null);
  const [original, setOriginal] = useState<File | null>(null);
  const [thumbnail, setThumbnail] = useState<File | null>(null);
  const [metaName, setMetaName] = useState("");
  const [payloadName, setPayloadName] = useState("");
  const [thumbnailName, setThumbnailName] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState("");
  const [extraJson, setExtraJson] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function pickOriginal(file: File | undefined) {
    if (!file) return;
    setOriginal(file);
    setMetaName((value) => value || file.name);
    setPayloadName((value) => value || file.name);
    setDate((value) => value || new Date().toISOString());
    setError(null);
  }

  function pickThumbnail(file: File | undefined) {
    if (!file) return;
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
    if (!original) { setError("Choose the original file first."); return; }
    if (!metaName.trim() || !payloadName.trim()) { setError("Card name and original name are required."); return; }
    let extra: Record<string, unknown> | undefined;
    try {
      const parsed = extraJson.trim() ? JSON.parse(extraJson) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Extra metadata must be a JSON object.");
      extra = { ...parsed, size_bytes: original.size };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Extra metadata is not valid JSON.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const thumbnailBytes = thumbnail ? new Uint8Array(await thumbnail.arrayBuffer()) : null;
      await startUpload({
        folderId, file: original, payloadName: payloadName.trim(),
        details: {
          name: metaName.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(date.trim() ? { date: date.trim() } : {}),
          extra,
        },
        thumbnailBytes,
        thumbnailFilename: thumbnailBytes ? (thumbnailName.trim() || thumbnail?.name || "thumbnail.webp") : null,
      });
      onUploaded();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload could not start.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto border-white/10 bg-[#0f0f13]/95 text-foreground backdrop-blur-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Upload className="h-5 w-5 text-emerald-400" />Add encrypted file</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">Meta uploads first. Original bytes encrypt and upload in chunks; real names stay inside ciphertext.</DialogDescription>
        </DialogHeader>

        <div className="mt-3 space-y-4">
          <input ref={originalRef} type="file" className="hidden" onChange={(event) => pickOriginal(event.target.files?.[0])} />
          <button type="button" onClick={() => originalRef.current?.click()} className="flex w-full items-center gap-3 rounded-xl border border-dashed border-emerald-500/35 bg-emerald-500/5 p-4 text-left hover:border-emerald-400/60 hover:bg-emerald-500/10">
            <span className="rounded-lg bg-emerald-400/10 p-2"><FileUp className="h-5 w-5 text-emerald-400" /></span>
            <span className="min-w-0"><span className="block text-sm font-medium">{original ? original.name : "Choose original file"}</span><span className="block text-xs text-muted-foreground">{original ? `${fileSize(original.size)} · streamed from disk` : "No whole-file memory copy"}</span></span>
          </button>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs text-muted-foreground"><span>Card name — encrypted details.json</span><Input value={metaName} onChange={(event) => setMetaName(event.target.value)} placeholder="Visible in VaultDrive after unlock" /></label>
            <label className="space-y-1.5 text-xs text-muted-foreground"><span>Original name — encrypted payload header</span><Input value={payloadName} onChange={(event) => setPayloadName(event.target.value)} placeholder="Name used on download" /></label>
          </div>
          <label className="space-y-1.5 text-xs text-muted-foreground"><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} className="min-h-18 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-foreground outline-none focus:border-emerald-400/60" /></label>
          <label className="space-y-1.5 text-xs text-muted-foreground"><span className="flex items-center gap-1"><Calendar className="h-3 w-3" />Date</span><Input value={date} onChange={(event) => setDate(event.target.value)} placeholder="Auto-filled when original file is selected" /></label>
          <label className="space-y-1.5 text-xs text-muted-foreground"><span>Extra JSON — size_bytes is set automatically</span><textarea value={extraJson} onChange={(event) => setExtraJson(event.target.value)} className="min-h-20 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-emerald-400/60" /></label>

          <input ref={thumbnailRef} type="file" accept="image/*" className="hidden" onChange={(event) => pickThumbnail(event.target.files?.[0])} />
          <div className="rounded-xl border border-white/10 bg-white/3 p-3">
            <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-medium">Preview thumbnail</p><p className="text-xs text-muted-foreground">Optional; stored only inside encrypted meta ZIP.</p></div><button type="button" onClick={() => thumbnailRef.current?.click()} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"><ImagePlus className="mr-1 inline h-3.5 w-3.5" />{thumbnail ? "Replace" : "Choose"}</button></div>
            {thumbnail && <div className="mt-3 flex gap-2"><Input value={thumbnailName} onChange={(event) => setThumbnailName(event.target.value)} /><button type="button" onClick={() => { setThumbnail(null); setThumbnailName(""); }} className="rounded-lg border border-white/10 px-2 text-muted-foreground hover:text-red-300"><X className="h-4 w-4" /></button></div>}
          </div>
          {error && <p className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">{error}</p>}
          <div className="flex justify-end gap-2"><button type="button" disabled={submitting} onClick={() => onOpenChange(false)} className="rounded-lg px-3 py-2 text-xs text-muted-foreground hover:text-foreground">Cancel</button><button type="button" disabled={!original || submitting} onClick={submit} className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{submitting ? <><Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />Uploading</> : "Encrypt & upload"}</button></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
