"use client";

import { HardDriveDownload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocalDownloadActions } from "@/components/local-download-provider";
import type { EncryptedDownloadTarget } from "@/lib/encrypted-download";

interface EncryptedDownloadButtonProps {
  target: EncryptedDownloadTarget;
  showLabel?: boolean;
}

export function EncryptedDownloadButton({ target, showLabel = false }: EncryptedDownloadButtonProps) {
  const { enqueue } = useLocalDownloadActions();
  const label = `Download encrypted: ${target.name}`;

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    enqueue([target]);
  };

  return (
    <Button
      type="button"
      variant="outline"
      size={showLabel ? "sm" : "icon-sm"}
      title={label}
      aria-label={label}
      className="gap-1.5 border-cyan-500/25 text-cyan-200 hover:border-cyan-400/60 hover:bg-cyan-600/20"
      onClick={handleClick}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <HardDriveDownload className="h-3.5 w-3.5" />
      {showLabel && <span>Download encrypted</span>}
    </Button>
  );
}
