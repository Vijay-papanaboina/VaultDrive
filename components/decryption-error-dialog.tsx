"use client";

import { KeyRound, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface DecryptionErrorDialogProps {
  open: boolean;
  description: string;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onStop: () => void;
  onReenter: () => void;
}

export function DecryptionErrorDialog({
  open,
  description,
  onOpenChange,
  onCancel,
  onStop,
  onReenter,
}: DecryptionErrorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        id="decryption-error-prompt-dialog"
        className="sm:max-w-sm"
        showCloseButton={false}
      >
        <DialogHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/15">
            <KeyRound className="h-5 w-5 text-amber-400" />
          </div>
          <DialogTitle>Decryption failed for some files</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <Button
            variant="outline"
            className="h-9 w-full px-4"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="h-9 w-full px-4 whitespace-normal text-center leading-tight"
            onClick={onStop}
          >
            Stop
          </Button>
          <Button className="h-9 w-full gap-2 px-4" onClick={onReenter}>
            <RotateCcw className="h-4 w-4" />
            Re-enter
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
