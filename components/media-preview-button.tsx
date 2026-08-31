"use client";

import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMediaPreview, type MediaPreviewTarget } from "@/components/media-preview-provider";

export function MediaPreviewButton({ target, showLabel = false, className = "" }: { target: MediaPreviewTarget; showLabel?: boolean; className?: string }) {
  const { openPreview } = useMediaPreview();
  return <Button type="button" variant="outline" size={showLabel ? "sm" : "icon-sm"} title="Preview media" aria-label="Preview media" className={`gap-1.5 ${className}`} onClick={(event) => { event.stopPropagation(); void openPreview(target); }}><Play className="h-3.5 w-3.5" />{showLabel && "Preview"}</Button>;
}
