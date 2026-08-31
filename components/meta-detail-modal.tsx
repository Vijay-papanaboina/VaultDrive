"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import type { DecryptedMeta, ProgressiveMetaFile } from "@/types";
import { useCrypto } from "@/hooks/use-crypto";
import { encryptMetaZip, IMAGE_EXTS } from "@/lib/crypto";
import { updateMetaFile } from "@/lib/drive-client";
import { useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  Check,
  FileText,
  HardDrive,
  ImagePlus,
  Loader2,
  Pencil,
  Save,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FileDownloadButton } from "@/components/file-download-button";
import { MediaPreviewButton } from "@/components/media-preview-button";
import { inferMimeType } from "@/lib/crypto";

interface MetaDetailModalProps {
  meta: DecryptedMeta | null;
  onClose: () => void;
  onSaved?: (meta: DecryptedMeta) => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return "—";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function updateMetadataCaches(queryClient: ReturnType<typeof useQueryClient>, next: DecryptedMeta) {
  const nextProgressive: ProgressiveMetaFile = {
    driveFile: next.driveFile,
    originalFileName: next.originalFileName,
    decrypted: true,
    status: "decrypted",
    details: next.details,
    thumbnailBytes: next.thumbnailBytes,
    thumbnailFilename: next.thumbnailFilename,
    thumbnailMimeType: next.thumbnailMimeType,
    thumbnailUrl: next.thumbnailUrl,
  };

  for (const query of queryClient.getQueryCache().getAll()) {
    const data = query.state.data;
    if (!Array.isArray(data)) continue;

    let changed = false;
    const updated = data.map((item) => {
      if (item?.driveFile?.id === next.driveFile.id) {
        changed = true;
        return { ...item, ...nextProgressive };
      }
      if (item?.id === next.driveFile.id) {
        changed = true;
        return { ...item, ...next.driveFile };
      }
      return item;
    });

    if (changed) queryClient.setQueryData(query.queryKey, updated);
  }
}

function makeThumbnailUrl(bytes: Uint8Array | null, mimeType: string | null) {
  if (!bytes) return null;
  return URL.createObjectURL(
    new Blob([bytes as unknown as BlobPart], { type: mimeType ?? "image/webp" })
  );
}

function MetaDetailContent({
  meta,
  onClose,
  onSaved,
}: {
  meta: DecryptedMeta;
  onClose: () => void;
  onSaved?: (meta: DecryptedMeta) => void;
}) {
  const { getPassphrase } = useCrypto();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [name, setName] = useState(meta.details.name);
  const [description, setDescription] = useState(meta.details.description ?? "");
  const [date, setDate] = useState(meta.details.date ?? "");
  const [extraJson, setExtraJson] = useState(
    JSON.stringify(meta.details.extra ?? {}, null, 2)
  );
  const [thumbnailBytes, setThumbnailBytes] = useState(meta.thumbnailBytes);
  const [thumbnailFilename, setThumbnailFilename] = useState(meta.thumbnailFilename);
  const [thumbnailMimeType, setThumbnailMimeType] = useState(meta.thumbnailMimeType);
  const [thumbnailDirty, setThumbnailDirty] = useState(false);
  const previewUrl = useMemo(
    () => thumbnailDirty
      ? makeThumbnailUrl(thumbnailBytes, thumbnailMimeType)
      : meta.thumbnailUrl,
    [meta.thumbnailUrl, thumbnailBytes, thumbnailDirty, thumbnailMimeType]
  );

  useEffect(() => {
    if (!thumbnailDirty || !previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl, thumbnailDirty]);

  async function handleThumbnailChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (!file.type.startsWith("image/") && !IMAGE_EXTS.test(file.name)) {
      setSaveError("Choose an image thumbnail file.");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setSaveError("Thumbnail images must be 25 MB or smaller.");
      return;
    }

    setThumbnailBytes(new Uint8Array(await file.arrayBuffer()));
    setThumbnailFilename(meta.thumbnailFilename ?? file.name);
    setThumbnailMimeType(file.type || "image/webp");
    setThumbnailDirty(true);
    setSaveError(null);
  }

  function startEditing() {
    setSavedMessage(null);
    setSaveError(null);
    setIsEditing(true);
  }

  function cancelEditing() {
    if (isSaving) return;
    setName(meta.details.name);
    setDescription(meta.details.description ?? "");
    setDate(meta.details.date ?? "");
    setExtraJson(JSON.stringify(meta.details.extra ?? {}, null, 2));
    setThumbnailBytes(meta.thumbnailBytes);
    setThumbnailFilename(meta.thumbnailFilename);
    setThumbnailMimeType(meta.thumbnailMimeType);
    setThumbnailDirty(false);
    setSaveError(null);
    setIsEditing(false);
  }

  async function saveChanges() {
    const identity = getPassphrase();
    if (!identity) {
      setSaveError("Unlock the vault before saving metadata.");
      return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      setSaveError("Name is required.");
      return;
    }

    let extra: Record<string, unknown> | undefined;
    try {
      const parsed = extraJson.trim() ? JSON.parse(extraJson) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Extra metadata must be a JSON object.");
      }
      extra = Object.keys(parsed).length > 0 ? parsed : undefined;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Extra metadata is not valid JSON.");
      return;
    }

    const details = {
      name: trimmedName,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(date.trim() ? { date: date.trim() } : {}),
      ...(extra ? { extra } : {}),
    };

    setIsSaving(true);
    setSaveError(null);
    setSavedMessage(null);

    try {
      const encrypted = await encryptMetaZip(identity, {
        details,
        thumbnailBytes,
        thumbnailFilename,
      });
      const updatedDriveFile = await updateMetaFile(
        meta.driveFile.id,
        encrypted,
        meta.driveFile.modifiedTime
      );
      const savedThumbnailUrl = thumbnailDirty
        ? makeThumbnailUrl(thumbnailBytes, thumbnailMimeType)
        : meta.thumbnailUrl;
      const nextMeta: DecryptedMeta = {
        ...meta,
        driveFile: { ...meta.driveFile, ...updatedDriveFile },
        details,
        thumbnailBytes,
        thumbnailFilename,
        thumbnailMimeType,
        thumbnailUrl: savedThumbnailUrl,
      };

      updateMetadataCaches(queryClient, nextMeta);
      onSaved?.(nextMeta);
      setThumbnailDirty(false);
      setSavedMessage("Metadata saved to Drive");
      setIsEditing(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save metadata.");
    } finally {
      setIsSaving(false);
    }
  }

  const { details, originalFileName, driveFile } = meta;
  const mediaMime = (details.extra?.mime_type as string | undefined) || inferMimeType(originalFileName);
  const isMedia = !!mediaMime?.startsWith("audio/") || !!mediaMime?.startsWith("video/");
  return (
    <div className="flex max-h-[95vh] w-full flex-col md:h-[75vh] md:flex-row">
      <div className="relative flex min-h-[260px] flex-1 items-center justify-center bg-black/95 p-4 md:min-h-0">
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={`Preview of ${originalFileName}`}
            className="max-h-[50vh] max-w-full object-contain md:max-h-full"
          />
        ) : (
          <div className="flex aspect-video w-full items-center justify-center">
            <FileText className="h-16 w-16 text-muted-foreground/20" />
          </div>
        )}
        <Button
          id="meta-modal-close"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 rounded-full border border-white/10 bg-black/60 text-white backdrop-blur-sm hover:bg-black/80"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t border-white/8 bg-background p-6 md:w-[420px] md:border-l md:border-t-0">
        <DialogHeader>
          <DialogTitle className="break-all font-mono text-base">
            {isEditing ? "Edit encrypted metadata" : originalFileName}
          </DialogTitle>
          {!isEditing && details.name !== originalFileName && (
            <DialogDescription className="break-all">{details.name}</DialogDescription>
          )}
          {isEditing && (
            <DialogDescription>
              Only the encrypted metadata archive will be changed.
            </DialogDescription>
          )}
        </DialogHeader>

        {!isEditing ? (
          <>
            <div className="flex gap-2">
              {isMedia && <MediaPreviewButton target={{ metaFileId: driveFile.id, displayName: details.name || originalFileName, originalFileName, mimeType: mediaMime, expectedSize: details.extra?.size_bytes !== undefined ? Number(details.extra.size_bytes) : Number(driveFile.size) }} showLabel className="flex-1 justify-center" />}
              <FileDownloadButton
                target={{
                  metaFileId: driveFile.id,
                  fallbackName: details.name || originalFileName,
                  expectedSize:
                    details.extra?.size_bytes !== undefined
                      ? Number(details.extra.size_bytes)
                      : Number(driveFile.size),
                }}
                showLabel
                className="flex-1 justify-center border-emerald-500/25 bg-emerald-600/15 text-emerald-200 hover:border-emerald-400/60 hover:bg-emerald-600/30"
              />
              <Button
                id="meta-modal-edit"
                variant="outline"
                className="gap-2 border-violet-500/30 text-violet-200 hover:bg-violet-500/10"
                onClick={startEditing}
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
            </div>

            {savedMessage && (
              <p className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                <Check className="h-3.5 w-3.5" /> {savedMessage}
              </p>
            )}

            {details.description && (
              <p className="text-sm leading-relaxed text-muted-foreground">{details.description}</p>
            )}

            <Separator className="bg-white/8" />

            <div className="flex flex-col gap-3 text-sm">
              {details.date && (
                <div className="flex items-center justify-between gap-4 border-b border-white/4 py-1.5">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Calendar className="h-3.5 w-3.5" /> Date
                  </span>
                  <span className="text-right text-foreground">{formatDate(details.date)}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-4 border-b border-white/4 py-1.5">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <HardDrive className="h-3.5 w-3.5" /> Size
                </span>
                <span className="font-mono text-foreground">
                  {formatBytes(
                    details.extra?.size_bytes !== undefined
                      ? Number(details.extra.size_bytes)
                      : Number(driveFile.size)
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 py-1.5">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <FileText className="h-3.5 w-3.5" /> Modified
                </span>
                <span className="text-right text-foreground">{formatDate(driveFile.modifiedTime)}</span>
              </div>
            </div>

            {details.extra && Object.keys(details.extra).filter((key) => key !== "size_bytes" && key !== "mime_type").length > 0 && (
              <>
                <Separator />
                <div className="flex flex-col gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Tag className="h-3 w-3" /> Extra metadata
                  </span>
                  <div className="rounded-lg border border-white/8 bg-white/3">
                    {Object.entries(details.extra)
                      .filter(([key]) => key !== "size_bytes" && key !== "mime_type")
                      .map(([key, value], index, entries) => (
                        <div
                          key={key}
                          className={`flex items-start justify-between gap-4 px-3 py-2 text-sm ${index < entries.length - 1 ? "border-b border-white/6" : ""}`}
                        >
                          <span className="text-muted-foreground">{key}</span>
                          <span className="text-right font-mono text-xs text-foreground">
                            {Array.isArray(value) ? (
                              <span className="flex flex-wrap justify-end gap-1">
                                {value.map((item, itemIndex) => (
                                  <Badge key={itemIndex} variant="secondary" className="h-5 rounded-full px-2 text-xs font-normal">
                                    {String(item)}
                                  </Badge>
                                ))}
                              </span>
                            ) : String(value)}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              Name
              <Input value={name} onChange={(event) => setName(event.target.value)} disabled={isSaving} />
            </label>

            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              Description
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={isSaving}
                rows={3}
                className="w-full resize-y rounded-lg border border-input bg-input/30 px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                placeholder="Optional description"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              Date
              <Input
                value={date}
                onChange={(event) => setDate(event.target.value)}
                disabled={isSaving}
                placeholder="2026-08-23T12:00:00.000Z"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              Extra metadata (JSON object)
              <textarea
                value={extraJson}
                onChange={(event) => setExtraJson(event.target.value)}
                disabled={isSaving}
                rows={7}
                spellCheck={false}
                className="w-full resize-y rounded-lg border border-input bg-black/20 px-2.5 py-2 font-mono text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                placeholder={'{\n  "key": "value"\n}'}
              />
            </label>

            <div className="flex flex-col gap-2 rounded-xl border border-white/8 bg-white/3 p-3">
              <span className="text-xs font-medium text-muted-foreground">Thumbnail</span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isSaving}
                >
                  <ImagePlus className="h-3.5 w-3.5" />
                  Replace image
                </Button>
                {thumbnailBytes && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-2 text-destructive hover:text-destructive"
                    onClick={() => {
                      setThumbnailBytes(null);
                      setThumbnailFilename(null);
                      setThumbnailMimeType(null);
                      setThumbnailDirty(true);
                    }}
                    disabled={isSaving}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </Button>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleThumbnailChange}
              />
              <span className="truncate font-mono text-[10px] text-muted-foreground/70">
                {thumbnailBytes ? thumbnailFilename ?? "thumbnail" : "No thumbnail will be stored"}
              </span>
            </div>

            {saveError && (
              <p className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
                {saveError}
              </p>
            )}

            <div className="flex justify-end gap-2 border-t border-white/8 pt-4">
              <Button variant="ghost" onClick={cancelEditing} disabled={isSaving}>
                Cancel
              </Button>
              <Button
                className="gap-2 bg-violet-600 text-white hover:bg-violet-500"
                onClick={saveChanges}
                disabled={isSaving}
              >
                {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {isSaving ? "Encrypting & saving…" : "Save metadata"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function MetaDetailModal({ meta, onClose, onSaved }: MetaDetailModalProps) {
  return (
    <Dialog open={!!meta} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        id="meta-detail-modal"
        showCloseButton={false}
        className="max-h-[95vh] w-full max-w-sm overflow-hidden border-white/10 p-0 sm:max-w-lg md:max-w-4xl lg:max-w-5xl"
      >
        {meta && <MetaDetailContent key={meta.driveFile.id} meta={meta} onClose={onClose} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  );
}
