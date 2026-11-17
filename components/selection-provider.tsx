"use client";

import React, { createContext, useContext, useState, ReactNode, useCallback, useEffect } from "react";
import { useCrypto } from "@/hooks/use-crypto";
import type { DriveMetaFile } from "@/types";

export interface SelectedFile {
  id: string;
  metaFileId: string;
  name: string;
  displayName: string;
  driveFile: DriveMetaFile;
  relativePath: string; // relative to root folder
  expectedSize?: number;
}

interface SelectionContextValue {
  isSelectionMode: boolean;
  toggleSelectionMode: () => void;
  selectedFiles: SelectedFile[];
  toggleFileSelection: (file: SelectedFile) => void;
  removeFileSelection: (metaFileId: string) => void;
  clearSelection: () => void;
  isFileSelected: (id: string) => boolean;
  exportFilesList: () => string; // returns the rclone file content string
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const { registerSensitiveCleanup } = useCrypto();
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);

  const toggleSelectionMode = useCallback(() => {
    setIsSelectionMode((prev) => !prev);
  }, []);

  const toggleFileSelection = useCallback((file: SelectedFile) => {
    setSelectedFiles((prev) => {
      const exists = prev.some((f) => f.metaFileId === file.metaFileId);
      if (exists) {
        return prev.filter((f) => f.metaFileId !== file.metaFileId);
      } else {
        return [...prev, file];
      }
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedFiles([]);
  }, []);

  const removeFileSelection = useCallback((metaFileId: string) => {
    setSelectedFiles((previous) => previous.filter((file) => file.metaFileId !== metaFileId));
  }, []);

  useEffect(() => registerSensitiveCleanup(clearSelection), [clearSelection, registerSensitiveCleanup]);

  const isFileSelected = useCallback((id: string) => {
    return selectedFiles.some((f) => f.metaFileId === id);
  }, [selectedFiles]);

  const exportFilesList = useCallback(() => {
    const lines: string[] = [];
    selectedFiles.forEach((file) => {
      const prefix = file.relativePath ? `${file.relativePath}/` : "";
      lines.push(`${prefix}${file.id}`);
    });
    
    const textContent = lines.join("\n") + "\n";

    // Download file
    const blob = new Blob([textContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "files.txt";
    link.click();
    URL.revokeObjectURL(url);

    return textContent;
  }, [selectedFiles]);

  return (
    <SelectionContext.Provider
      value={{
        isSelectionMode,
        toggleSelectionMode,
        selectedFiles,
        toggleFileSelection,
        removeFileSelection,
        clearSelection,
        isFileSelected,
        exportFilesList,
      }}
    >
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection() {
  const context = useContext(SelectionContext);
  if (!context) {
    throw new Error("useSelection must be used within a SelectionProvider");
  }
  return context;
}
