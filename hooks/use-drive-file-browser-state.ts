"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
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
  const [workerResult, setWorkerResult] = useState<{
    key: string;
    orderedIds: string[];
  }>({
    key: "",
    orderedIds: files.map((file) => file.driveFile.id),
  });
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const latestAppliedRequestIdRef = useRef(0);
  const requestKeyByIdRef = useRef(new Map<number, string>());

  const fileById = useMemo(() => {
    return new Map(files.map((file) => [file.driveFile.id, file]));
  }, [files]);

  const indexedFiles = useMemo(() => {
    return files.map((file) => ({
      id: file.driveFile.id,
      originalNameNormalized: normalize(file.originalFileName),
      detailsNameNormalized: file.details?.name ? normalize(file.details.name) : "",
      createdAtMs: file.driveFile.createdTime
        ? Date.parse(file.driveFile.createdTime)
        : file.driveFile.modifiedTime
          ? Date.parse(file.driveFile.modifiedTime)
          : 0,
      modifiedAtMs: file.driveFile.modifiedTime ? Date.parse(file.driveFile.modifiedTime) : 0,
      originalSizeBytes: Number(file.details?.extra?.size_bytes ?? 0),
      metaName: file.driveFile.name,
    }));
  }, [files]);

  const filesKey = useMemo(() => {
    const head = files.slice(0, 8).map((file) => file.driveFile.id).join("|");
    const tail = files.slice(-2).map((file) => file.driveFile.id).join("|");
    return `${files.length}::${head}::${tail}`;
  }, [files]);
  const currentComputeKey = `${filesKey}::${searchQuery}::${sortBy}::${sortOrder}`;

  useEffect(() => {
    const worker = new Worker(
      new URL("../lib/drive-browser.worker.ts", import.meta.url)
    );
    workerRef.current = worker;

    const handleMessage = (event: MessageEvent<{ requestId: number; orderedIds: string[] }>) => {
      const { requestId, orderedIds: nextOrderedIds } = event.data;
      if (requestId < latestAppliedRequestIdRef.current) return;

      const requestKey = requestKeyByIdRef.current.get(requestId);
      if (!requestKey) return;

      latestAppliedRequestIdRef.current = requestId;
      setWorkerResult({
        key: requestKey,
        orderedIds: nextOrderedIds,
      });
      requestKeyByIdRef.current.delete(requestId);
    };

    worker.addEventListener("message", handleMessage);

    return () => {
      worker.removeEventListener("message", handleMessage);
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    workerRef.current?.postMessage({
      type: "set-files",
      records: indexedFiles,
    });
  }, [indexedFiles]);

  useEffect(() => {
    if (!workerRef.current) return;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    requestKeyByIdRef.current.set(requestId, currentComputeKey);

    workerRef.current.postMessage({
      type: "compute",
      requestId,
      searchQuery,
      sortBy,
      sortOrder,
    });
  }, [currentComputeKey, indexedFiles, searchQuery, sortBy, sortOrder]);

  const sortedFiles = useMemo(() => {
    if (workerResult.key !== currentComputeKey) return files;

    return workerResult.orderedIds
      .map((id) => fileById.get(id))
      .filter((file): file is ProgressiveMetaFile => Boolean(file));
  }, [currentComputeKey, fileById, files, workerResult]);

  function updateSearchQuery(query: string) {
    setSearchState({ folderId, query });
  }

  function updateSort(sortByValue: SortBy, sortOrderValue: SortOrder) {
    startTransition(() => {
      setSortBy(sortByValue);
      setSortOrder(sortOrderValue);
    });
  }

  function handleSortChange(nextSortBy: SortBy) {
    const nextSortOrder = nextSortBy === "name" ? "asc" : "desc";
    const applyChange = () => updateSort(nextSortBy, nextSortOrder);

    if (deferSortChange) {
      window.setTimeout(applyChange, 50);
      return;
    }

    applyChange();
  }

  function toggleSortOrder() {
    startTransition(() => {
      setSortOrder((current) => (current === "asc" ? "desc" : "asc"));
    });
  }

  return {
    searchQuery,
    setSearchQuery: updateSearchQuery,
    sortBy,
    sortOrder,
    resultCount: sortedFiles.length,
    sortedFiles,
    handleSortChange,
    toggleSortOrder,
  };
}
