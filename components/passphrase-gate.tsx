"use client";

import { useState } from "react";
import { useCrypto } from "@/hooks/use-crypto";
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

/**
 * Global passphrase gate — shown immediately on /drive entry (login or refresh).
 * No test file needed: passphrase is stored and any wrong-key errors
 * surface naturally per-card when decryption fails.
 */
export function PassphraseGate({ children }: { children: React.ReactNode }) {
  const {
    hasPassphrase,
    setPassphrase,
    passphraseError,
    clearPassphraseError,
    isGateOpen,
    setIsGateOpen,
  } = useCrypto();
  const [value, setValue] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setLoading(true);
    // Small delay so the spinner renders before derivation blocks
    setTimeout(async () => {
      try {
        await setPassphrase(value.trim());
        setValue("");
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }, 50);
  }

  const isOpen = !hasPassphrase || isGateOpen;
  const shouldBlur = !hasPassphrase;

  return (
    <>
      {/* Render children underneath so layout is visible but blurred only when locked */}
      <div className={shouldBlur ? "pointer-events-none select-none blur-sm brightness-50" : ""} aria-hidden={shouldBlur}>
        {children}
      </div>

      <Dialog open={isOpen} onOpenChange={(open) => {
        if (!open && hasPassphrase) {
          setIsGateOpen(false);
          setValue("");
          if (passphraseError) clearPassphraseError();
        }
      }}>
        <DialogContent
          id="passphrase-gate-dialog"
          className="sm:max-w-md p-8 gap-6"
          showCloseButton={hasPassphrase}
        >
          <DialogHeader>
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/15">
              <KeyRound className="h-6 w-6 text-violet-400" />
            </div>
            <DialogTitle className="text-xl">
              {hasPassphrase ? "Change decryption passphrase" : "Enter decryption passphrase"}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs leading-normal">
              {hasPassphrase
                ? "Enter your new age passphrase. This will reset browser memory and start decrypting with the new key."
                : "Your age passphrase is required to decrypt .meta files. It stays in browser memory only — never sent anywhere."}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="relative">
              <Input
                id="passphrase-input"
                type={showPw ? "text" : "password"}
                placeholder={hasPassphrase ? "New age passphrase…" : "Your age passphrase…"}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (passphraseError) clearPassphraseError();
                }}
                autoFocus
                autoComplete="off"
                className="pr-12 h-11 text-sm rounded-lg"
                disabled={loading}
              />
              <button
                type="button"
                onClick={() => setShowPw((p) => !p)}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                aria-label={showPw ? "Hide passphrase" : "Show passphrase"}
              >
                {showPw ? (
                  <EyeOff className="h-4.5 w-4.5" />
                ) : (
                  <Eye className="h-4.5 w-4.5" />
                )}
              </button>
            </div>

            {passphraseError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
                <ShieldAlert className="mt-0.5 h-4.5 w-4.5 shrink-0" />
                {passphraseError}
              </div>
            )}

            <div className="flex gap-3">
              {hasPassphrase && (
                <Button
                  id="passphrase-cancel-btn"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setIsGateOpen(false);
                    setValue("");
                    if (passphraseError) clearPassphraseError();
                  }}
                  className="flex-1 h-11 cursor-pointer"
                  disabled={loading}
                >
                  Cancel
                </Button>
              )}
              <Button
                id="passphrase-submit-btn"
                type="submit"
                disabled={!value.trim() || loading}
                className="flex-1 h-11 gap-2 cursor-pointer"
              >
                {loading && <Loader2 className="h-4.5 w-4.5 animate-spin" />}
                {loading ? "Unlocking…" : hasPassphrase ? "Update Key" : "Unlock"}
              </Button>
            </div>

            <p className="text-center text-xs text-muted-foreground">
              Stored in memory only. Cleared on tab close or refresh.
            </p>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
