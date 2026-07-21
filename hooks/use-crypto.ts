"use client";

import React, {
  createContext,
  useContext,
  useRef,
  useState,
  ReactNode,
} from "react";
import { deriveAgeIdentity } from "@/lib/crypto";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";

interface CryptoContextValue {
  hasPassphrase: boolean;
  getPassphrase: () => string | null;
  setPassphrase: (pw: string) => Promise<void>;
  clearPassphrase: (errorMsg?: string) => void;
  passphraseError: string | null;
  clearPassphraseError: () => void;
  dismissedPassphraseError: boolean;
  setDismissedPassphraseError: (val: boolean) => void;
  isGateOpen: boolean;
  setIsGateOpen: (val: boolean) => void;
}

const CryptoContext = createContext<CryptoContextValue | null>(null);


export function CryptoProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  // useRef keeps the derived private identity key in memory only — never written to storage
  const identityRef = useRef<string | null>(null);
  // useState for reactivity (so UI re-renders when passphrase is set/cleared)
  const [hasPassphrase, setHasPassphrase] = useState(false);
  const [passphraseError, setPassphraseError] = useState<string | null>(null);
  const [dismissedPassphraseError, setDismissedPassphraseError] = useState(false);
  const [isGateOpen, setIsGateOpen] = useState(false);

  const queryClient = useQueryClient();

  function clearDecryptedFileCache() {
    queryClient.removeQueries({ queryKey: ["decrypted-folder"] });
  }

  function getPassphrase() {
    return identityRef.current;
  }

  async function setPassphrase(pw: string) {
    const email = session?.user?.email;
    if (!email) {
      throw new Error("Cannot set passphrase without an authenticated user email session.");
    }
    const identity = await deriveAgeIdentity(pw, email);
    identityRef.current = identity;
    setHasPassphrase(true);
    setPassphraseError(null);
    setDismissedPassphraseError(false);
    setIsGateOpen(false);
    clearDecryptedFileCache();
  }

  function clearPassphrase(errorMsg?: string) {
    identityRef.current = null;
    setHasPassphrase(false);
    setIsGateOpen(false);
    clearDecryptedFileCache();
    if (typeof errorMsg === "string") {
      setPassphraseError(errorMsg);
    } else {
      setPassphraseError(null);
    }
  }

  function clearPassphraseError() {
    setPassphraseError(null);
  }

  return React.createElement(
    CryptoContext.Provider,
    {
      value: {
        hasPassphrase,
        getPassphrase,
        setPassphrase,
        clearPassphrase,
        passphraseError,
        clearPassphraseError,
        dismissedPassphraseError,
        setDismissedPassphraseError,
        isGateOpen,
        setIsGateOpen,
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
