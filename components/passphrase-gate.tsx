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
  const { hasPassphrase, setPassphrase, passphraseError, clearPassphraseError } = useCrypto();
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
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }, 50);
  }

  if (hasPassphrase) return <>{children}</>;

  return (
    <>
      {/* Render children underneath so layout is visible but blurred */}
      <div className="pointer-events-none select-none blur-sm brightness-50" aria-hidden>
        {children}
      </div>

      <Dialog open>
        <DialogContent
          id="passphrase-gate-dialog"
          className="sm:max-w-sm"
          showCloseButton={false}
        >
          <DialogHeader>
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/15">
              <KeyRound className="h-5 w-5 text-violet-400" />
            </div>
            <DialogTitle>Enter decryption passphrase</DialogTitle>
            <DialogDescription>
              Your age passphrase is required to decrypt{" "}
              <code className="rounded bg-muted px-1 text-xs">.meta</code>{" "}
              files. It stays in browser memory only — never sent anywhere.
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
                  if (passphraseError) clearPassphraseError();
                }}
                autoFocus
                autoComplete="off"
                className="pr-10"
                disabled={loading}
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

            {passphraseError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                {passphraseError}
              </div>
            )}

            <Button
              id="passphrase-submit-btn"
              type="submit"
              disabled={!value.trim() || loading}
              className="w-full gap-2"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? "Unlocking…" : "Unlock"}
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              Stored in memory only. Cleared on tab close or refresh.
            </p>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
