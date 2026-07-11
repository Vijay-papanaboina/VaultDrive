"use client";

import React, { createContext, useContext, useState, ReactNode, useCallback } from "react";

interface SelectedFile {
  id: string;
  name: string;
  relativePath: string; // relative to root folder
}

interface SelectionContextValue {
  isSelectionMode: boolean;
  toggleSelectionMode: () => void;
  selectedFiles: SelectedFile[];
  toggleFileSelection: (file: SelectedFile) => void;
  clearSelection: () => void;
  isFileSelected: (id: string) => boolean;
  exportFilesList: () => string; // returns the rclone file content string
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);

  const toggleSelectionMode = useCallback(() => {
    setIsSelectionMode((prev) => !prev);
  }, []);

  const toggleFileSelection = useCallback((file: SelectedFile) => {
    setSelectedFiles((prev) => {
      const exists = prev.some((f) => f.id === file.id);
      if (exists) {
        return prev.filter((f) => f.id !== file.id);
      } else {
        return [...prev, file];
      }
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedFiles([]);
  }, []);

  const isFileSelected = useCallback((id: string) => {
    return selectedFiles.some((f) => f.id === id);
  }, [selectedFiles]);

  const exportFilesList = useCallback(() => {
    const lines: string[] = [];
    selectedFiles.forEach((file) => {
      const prefix = file.relativePath ? `${file.relativePath}/` : "";
      lines.push(`${prefix}${file.id}.meta`);
      lines.push(`${prefix}${file.id}`);
    });
    
    const textContent = lines.join("\n");

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
