"use client";

import React, {
  createContext,
  useContext,
  useRef,
  useState,
  ReactNode,
} from "react";

interface CryptoContextValue {
  hasPassphrase: boolean;
  getPassphrase: () => string | null;
  setPassphrase: (pw: string) => void;
  clearPassphrase: () => void;
}

const CryptoContext = createContext<CryptoContextValue | null>(null);

export function CryptoProvider({ children }: { children: ReactNode }) {
  // useRef keeps the passphrase in memory only — never written to storage
  const passphraseRef = useRef<string | null>(null);
  // useState for reactivity (so UI re-renders when passphrase is set/cleared)
  const [hasPassphrase, setHasPassphrase] = useState(false);

  function getPassphrase() {
    return passphraseRef.current;
  }

  function setPassphrase(pw: string) {
    passphraseRef.current = pw;
    setHasPassphrase(true);
  }

  function clearPassphrase() {
    passphraseRef.current = null;
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
