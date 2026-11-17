"use client";

import React, {
  useCallback,
  createContext,
  useContext,
  useRef,
  useState,
  ReactNode,
} from "react";
import { deriveAgeIdentity } from "@/lib/crypto";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import type { ProgressiveMetaFile } from "@/types";
import { readLocalUnlockEmail } from "@/lib/local-download-library";

interface CryptoContextValue {
  hasPassphrase: boolean;
  keyVersion: number;
  getPassphrase: () => string | null;
  authenticatedEmail: string | undefined;
  setPassphrase: (pw: string, offlineUnlock?: boolean) => Promise<void>;
  cancelPassphraseOperation: () => void;
  clearPassphrase: (errorMsg?: string) => void;
  passphraseError: string | null;
  clearPassphraseError: () => void;
  dismissedPassphraseError: boolean;
  setDismissedPassphraseError: (val: boolean) => void;
  isGateOpen: boolean;
  setIsGateOpen: (val: boolean) => void;
  registerSensitiveCleanup: (cleanup: () => void | Promise<void>) => () => void;
}

const CryptoContext = createContext<CryptoContextValue | null>(null);


export function CryptoProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  // The derived private identity stays in memory, never in browser storage.
  const identityRef = useRef<string | null>(null);
  const passphraseOperationRef = useRef(0);
  // useState for reactivity (so UI re-renders when passphrase is set/cleared)
  const [hasPassphrase, setHasPassphrase] = useState(false);
  const [keyVersion, setKeyVersion] = useState(0);
  const [passphraseError, setPassphraseError] = useState<string | null>(null);
  const [dismissedPassphraseError, setDismissedPassphraseError] = useState(false);
  const [isGateOpen, setIsGateOpen] = useState(false);
  const cleanupRef = useRef(new Set<() => void | Promise<void>>());

  const queryClient = useQueryClient();

  function clearDecryptedFileCache() {
    for (const [, files] of queryClient.getQueriesData<ProgressiveMetaFile[]>({
      queryKey: ["decrypted-folder"],
    })) {
      files?.forEach((file) => {
        if (file.thumbnailUrl) URL.revokeObjectURL(file.thumbnailUrl);
      });
    }
    queryClient.removeQueries({ queryKey: ["decrypted-folder"] });
  }

  async function runSensitiveCleanups() {
    await Promise.allSettled(Array.from(cleanupRef.current, (cleanup) => cleanup()));
  }

  function getPassphrase() {
    return identityRef.current;
  }

  async function setPassphrase(pw: string, offlineUnlock = false) {
    const operation = ++passphraseOperationRef.current;
    const email = session?.user?.email || (offlineUnlock ? readLocalUnlockEmail() : null);
    if (!email) {
      throw new Error(offlineUnlock
        ? "Sign in and open your download folder once while online to set up offline unlock."
        : "Cannot set passphrase without an authenticated user email session.");
    }
    const identity = await deriveAgeIdentity(pw, email);
    if (operation !== passphraseOperationRef.current) {
      throw new DOMException("Passphrase entry cancelled", "AbortError");
    }
    // A replacement key invalidates every plaintext view built with the old one.
    await runSensitiveCleanups();
    if (operation !== passphraseOperationRef.current) {
      throw new DOMException("Passphrase entry cancelled", "AbortError");
    }
    identityRef.current = identity;
    setHasPassphrase(true);
    setKeyVersion((version) => version + 1);
    setPassphraseError(null);
    setDismissedPassphraseError(false);
    setIsGateOpen(false);
    clearDecryptedFileCache();
  }

  const cancelPassphraseOperation = useCallback(() => {
    passphraseOperationRef.current += 1;
  }, []);

  function clearPassphrase(errorMsg?: string) {
    passphraseOperationRef.current += 1;
    void runSensitiveCleanups();
    identityRef.current = null;
    setHasPassphrase(false);
    setKeyVersion((version) => version + 1);
    setIsGateOpen(false);
    clearDecryptedFileCache();
    if (typeof errorMsg === "string") {
      setPassphraseError(errorMsg);
    } else {
      setPassphraseError(null);
    }
  }

  function registerSensitiveCleanup(cleanup: () => void | Promise<void>) {
    cleanupRef.current.add(cleanup);
    return () => cleanupRef.current.delete(cleanup);
  }

  function clearPassphraseError() {
    setPassphraseError(null);
  }

  return React.createElement(
    CryptoContext.Provider,
    {
      value: {
        hasPassphrase,
        keyVersion,
        getPassphrase,
        authenticatedEmail: session?.user?.email,
        setPassphrase,
        cancelPassphraseOperation,
        clearPassphrase,
        passphraseError,
        clearPassphraseError,
        dismissedPassphraseError,
        setDismissedPassphraseError,
        isGateOpen,
        setIsGateOpen,
        registerSensitiveCleanup,
      },
    },
    children
  );
}

export function useCrypto() {
  const ctx = useContext(CryptoContext);
  if (!ctx) throw new Error("useCrypto must be used within CryptoProvider");
  return ctx;
}
