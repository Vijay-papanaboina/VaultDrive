"use client";

import { useState } from "react";
import { useCrypto } from "@/hooks/use-crypto";
import { validatePassphrase } from "@/lib/crypto";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff, KeyRound, Loader2, ShieldAlert } from "lucide-react";

interface PasswordDialogProps {
  /** A .meta fileId to validate the passphrase against */
  testFileId: string;
  onSuccess: () => void;
}

export function PasswordDialog({ testFileId, onSuccess }: PasswordDialogProps) {
  const { setPassphrase } = useCrypto();
  const [value, setValue] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;

    setStatus("loading");
    setErrorMsg("");

    try {
      const valid = await validatePassphrase(value, testFileId);
      if (valid) {
        await setPassphrase(value);
        onSuccess();
      } else {
        setStatus("error");
        setErrorMsg("Wrong passphrase — decryption failed. Try again.");
        setValue("");
      }
    } catch (err) {
      setStatus("error");
      setErrorMsg(
        err instanceof Error ? err.message : "Unexpected error during decryption."
      );
    }
  }

  return (
    <Dialog open>
      <DialogContent
        id="password-dialog"
        className="sm:max-w-sm"
        showCloseButton={false}
      >
        <DialogHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/15">
            <KeyRound className="h-5 w-5 text-violet-400" />
          </div>
          <DialogTitle>Enter decryption passphrase</DialogTitle>
          <DialogDescription>
            This folder contains encrypted{" "}
            <code className="rounded bg-muted px-1 text-xs">.meta</code> files.
            Enter your age passphrase to decrypt and browse them.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="relative">
            <Input
              id="passphrase-input"
              type={showPw ? "text" : "password"}
              placeholder="Your age passphrase…"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (status === "error") setStatus("idle");
              }}
              autoFocus
              autoComplete="off"
              className="pr-10"
              disabled={status === "loading"}
            />
            <button
              type="button"
              onClick={() => setShowPw((p) => !p)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showPw ? "Hide passphrase" : "Show passphrase"}
            >
              {showPw ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>

          {status === "error" && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              {errorMsg}
            </div>
          )}

          <Button
            id="passphrase-submit-btn"
            type="submit"
            disabled={!value.trim() || status === "loading"}
            className="w-full gap-2"
          >
            {status === "loading" && <Loader2 className="h-4 w-4 animate-spin" />}
            {status === "loading" ? "Decrypting…" : "Unlock"}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            Passphrase stays in browser memory only. Never sent anywhere.
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}
