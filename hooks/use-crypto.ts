"use client";

import React, {
  createContext,
  useContext,
  useRef,
  useState,
  ReactNode,
} from "react";
import { deriveAgeIdentity } from "@/lib/crypto";

interface CryptoContextValue {
  hasPassphrase: boolean;
  getPassphrase: () => string | null;
  setPassphrase: (pw: string) => Promise<void>;
  clearPassphrase: () => void;
}

const CryptoContext = createContext<CryptoContextValue | null>(null);

export function CryptoProvider({ children }: { children: ReactNode }) {
  // useRef keeps the derived private identity key in memory only — never written to storage
  const identityRef = useRef<string | null>(null);
  // useState for reactivity (so UI re-renders when passphrase is set/cleared)
  const [hasPassphrase, setHasPassphrase] = useState(false);

  function getPassphrase() {
    return identityRef.current;
  }

  async function setPassphrase(pw: string) {
    const identity = await deriveAgeIdentity(pw);
    identityRef.current = identity;
    setHasPassphrase(true);
  }

  function clearPassphrase() {
    identityRef.current = null;
    setHasPassphrase(false);
  }

  return React.createElement(
    CryptoContext.Provider,
    { value: { hasPassphrase, getPassphrase, setPassphrase, clearPassphrase } },
    children
  );
}

export function useCrypto() {
  const ctx = useContext(CryptoContext);
  if (!ctx) throw new Error("useCrypto must be used within CryptoProvider");
  return ctx;
}
