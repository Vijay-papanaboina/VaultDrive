"use client";

import { useEffect, useState } from "react";
import type { ProgressiveMetaFile } from "@/types";

interface UseDecryptionErrorPromptOptions {
  files: ProgressiveMetaFile[];
  dismissedPassphraseError: boolean;
  setDismissedPassphraseError: (value: boolean) => void;
  clearPassphrase: (errorMsg?: string) => void;
  cancelDecryption: () => void;
}

export function useDecryptionErrorPrompt({
  files,
  dismissedPassphraseError,
  setDismissedPassphraseError,
  clearPassphrase,
  cancelDecryption,
}: UseDecryptionErrorPromptOptions) {
  const [isOpen, setIsOpen] = useState(false);
  const hasDecryptionErrors = files.some((file) => file.decryptError);

  useEffect(() => {
    if (hasDecryptionErrors && !dismissedPassphraseError) {
      const timeoutId = window.setTimeout(() => {
        setDismissedPassphraseError(true);
        setIsOpen(true);
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [hasDecryptionErrors, dismissedPassphraseError, setDismissedPassphraseError]);

  function dismiss() {
    setIsOpen(false);
  }

  function reenter() {
    const firstErrFile = files.find((file) => file.decryptError);
    setIsOpen(false);
    clearPassphrase(firstErrFile?.decryptError || "Decryption failed");
  }

  function stop() {
    setIsOpen(false);
    cancelDecryption();
  }

  return {
    isOpen,
    setIsOpen,
    dismiss,
    reenter,
    stop,
  };
}
