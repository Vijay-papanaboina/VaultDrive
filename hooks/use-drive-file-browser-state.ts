"use client";

import { useMemo, useState } from "react";
import type { ProgressiveMetaFile } from "@/types";

interface UseDriveFileBrowserStateOptions {
  files: ProgressiveMetaFile[];
  folderId: string;
  deferSortChange?: boolean;
}

type SortBy = "created" | "modified" | "size" | "name";
type SortOrder = "asc" | "desc";

function normalize(str: string) {
  return str.toLowerCase().replace(/\s+/g, "");
}

export function useDriveFileBrowserState({
  files,
  folderId,
  deferSortChange = false,
}: UseDriveFileBrowserStateOptions) {
  const [searchState, setSearchState] = useState({
    folderId,
    query: "",
  });
  const [sortBy, setSortBy] = useState<SortBy>("created");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const searchQuery = searchState.folderId === folderId ? searchState.query : "";

  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return files;
    const queryNormalized = normalize(searchQuery);
    return files.filter((file) => {
      const origNormalized = normalize(file.originalFileName);
      const decNormalized = file.details?.name ? normalize(file.details.name) : "";
      return (
        origNormalized.includes(queryNormalized) ||
        decNormalized.includes(queryNormalized)
      );
    });
  }, [files, searchQuery]);

  const sortedFiles = useMemo(() => {
    return [...filteredFiles].sort((a, b) => {
      let comparison = 0;

      if (sortBy === "created") {
        const dateA = a.driveFile.createdTime
          ? new Date(a.driveFile.createdTime).getTime()
          : a.driveFile.modifiedTime
            ? new Date(a.driveFile.modifiedTime).getTime()
            : 0;
        const dateB = b.driveFile.createdTime
          ? new Date(b.driveFile.createdTime).getTime()
          : b.driveFile.modifiedTime
            ? new Date(b.driveFile.modifiedTime).getTime()
            : 0;
        comparison = dateA - dateB;
      } else if (sortBy === "modified") {
        const dateA = a.driveFile.modifiedTime
          ? new Date(a.driveFile.modifiedTime).getTime()
          : 0;
        const dateB = b.driveFile.modifiedTime
          ? new Date(b.driveFile.modifiedTime).getTime()
          : 0;
        comparison = dateA - dateB;
      } else if (sortBy === "size") {
        const sizeA = Number(a.details?.extra?.size_bytes ?? 0);
        const sizeB = Number(b.details?.extra?.size_bytes ?? 0);
        comparison = sizeA - sizeB;
      } else {
        comparison = a.driveFile.name.localeCompare(b.driveFile.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      }

      return sortOrder === "asc" ? comparison : -comparison;
    });
  }, [filteredFiles, sortBy, sortOrder]);

  function handleSortChange(nextSortBy: SortBy) {
    const applyChange = () => {
      setSortBy(nextSortBy);
      setSortOrder(nextSortBy === "name" ? "asc" : "desc");
    };

    if (deferSortChange) {
      window.setTimeout(applyChange, 50);
      return;
    }

    applyChange();
  }

  function toggleSortOrder() {
    setSortOrder((current) => (current === "asc" ? "desc" : "asc"));
  }

  return {
    searchQuery,
    setSearchQuery: (query: string) => setSearchState({ folderId, query }),
    sortBy,
    sortOrder,
    filteredFiles,
    sortedFiles,
    handleSortChange,
    toggleSortOrder,
  };
}
