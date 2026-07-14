"use client";

import React, { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Fuse from "fuse.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MetaCard } from "@/components/meta-card";
import { MetaDetailModal } from "@/components/meta-detail-modal";
import { useSelection } from "@/components/selection-provider";
import type { ProgressiveMetaFile, BreadcrumbItem, DecryptedMeta } from "@/types";
import { Search, FileX, Archive } from "lucide-react";

interface GlobalSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SearchableFile extends ProgressiveMetaFile {
  folderId: string;
  relativePath: string;
  normalizedName: string;
  normalizedOrigName: string;
}

export function GlobalSearchModal({ isOpen, onClose }: GlobalSearchModalProps) {
  const queryClient = useQueryClient();
  const { isSelectionMode, isFileSelected, toggleFileSelection } = useSelection();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDetail, setSelectedDetail] = useState<DecryptedMeta | null>(null);

  // 1. Gather all files from the React Query cache
  const allFiles = useMemo(() => {
    if (!isOpen) return [];

    const cacheData = queryClient.getQueriesData<ProgressiveMetaFile[]>({
      queryKey: ["decrypted-folder"],
    });

    const filesList: SearchableFile[] = [];
    const normalize = (str: string) => str.toLowerCase().replace(/\s+/g, "");

    cacheData.forEach(([queryKey, data]) => {
      if (!data) return;
      const folderId = queryKey[1] as string;
      
      // Resolve path from breadcrumbs cache if present
      const breadcrumbs =
        queryClient.getQueryData<BreadcrumbItem[]>(["breadcrumbs", folderId]) || [];
      const relativePath = breadcrumbs
        .map((b) => b.name)
        .filter((name) => name.toLowerCase() !== "my drive")
        .join("/");

      data.forEach((file) => {
        // Only include decrypted files without errors
        if (file.decrypted && file.details && !file.decryptError) {
          filesList.push({
            ...file,
            folderId,
            relativePath,
            normalizedName: normalize(file.details.name),
            normalizedOrigName: normalize(file.originalFileName),
          });
        }
      });
    });

    return filesList;
  }, [isOpen, queryClient]);

  // 2. Set up Fuse.js for fuzzy search
  const fuse = useMemo(() => {
    return new Fuse(allFiles, {
      keys: ["details.name", "originalFileName", "normalizedName", "normalizedOrigName"],
      threshold: 0.3,
      distance: 100,
    });
  }, [allFiles]);

  // 3. Compute search results
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const queryNormalized = searchQuery.toLowerCase().replace(/\s+/g, "");
    return fuse.search(queryNormalized).map((r) => r.item);
  }, [fuse, searchQuery]);

  const handleCardClick = (file: SearchableFile) => {
    const fileId = file.driveFile.name.replace(".meta", "");
    if (isSelectionMode) {
      toggleFileSelection({
        id: fileId,
        name: file.originalFileName,
        relativePath: file.relativePath,
      });
    } else {
      if (file.decrypted && file.details && !file.decryptError) {
        setSelectedDetail({
          driveFile: file.driveFile,
          details: file.details,
          thumbnailBytes: file.thumbnailBytes ?? null,
          thumbnailMimeType: file.thumbnailMimeType ?? null,
          originalFileName: file.originalFileName,
        });
      }
    }
  };

  const handleClose = () => {
    setSearchQuery("");
    onClose();
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(open) => { if (!open) handleClose(); }}>
        <DialogContent
          id="global-search-modal"
          className="max-h-[95vh] w-full sm:max-w-[95vw] lg:max-w-[90vw] xl:max-w-7xl overflow-hidden p-6 border-white/10 bg-background text-foreground flex flex-col gap-4"
        >
          <DialogHeader className="pr-6">
            <DialogTitle className="text-lg font-semibold flex items-center gap-2">
              <Search className="h-5 w-5 text-foreground" />
              Global Search (Cached Files)
            </DialogTitle>
          </DialogHeader>

          {/* Search Input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search decrypted filenames across visited folders... (e.g. database)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-10 w-full bg-white/5 border-white/10 focus-visible:border-white/50 focus-visible:ring-0 placeholder:text-muted-foreground/50 font-mono text-sm"
              autoFocus
            />
          </div>

          {/* Results Area */}
          <div className="flex-1 overflow-y-auto min-h-[400px] max-h-[75vh] pr-2 custom-scrollbar">
            {allFiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <Archive className="h-10 w-10 text-muted-foreground/30" />
                <div>
                  <p className="font-medium text-muted-foreground">No cached files</p>
                  <p className="mt-1 text-xs text-muted-foreground/50 max-w-md">
                    Open some folders to load and decrypt files first. Search only queries decrypted files stored in memory.
                  </p>
                </div>
              </div>
            ) : !searchQuery.trim() ? (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground/60">
                <Search className="h-8 w-8 opacity-40" />
                <p className="text-sm">Start typing to search {allFiles.length} cached file{allFiles.length === 1 ? "" : "s"}...</p>
              </div>
            ) : searchResults.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <FileX className="h-10 w-10 text-muted-foreground/30" />
                <div>
                  <p className="font-medium text-muted-foreground">No matches found</p>
                  <p className="mt-1 text-xs text-muted-foreground/50">
                    No decrypted file matches &quot;{searchQuery}&quot; in your cache.
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {searchResults.map((file) => {
                  const fileId = file.driveFile.name.replace(".meta", "");
                  return (
                    <div key={file.driveFile.id} className="relative">
                      <MetaCard
                        meta={file}
                        isSelectionMode={isSelectionMode}
                        isSelected={isFileSelected(fileId)}
                        onClick={() => handleCardClick(file)}
                      />
                      {/* Location Badge */}
                      {file.relativePath && (
                        <div className="absolute bottom-2.5 right-2.5 pointer-events-none">
                          <span className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground/80 border border-white/5 backdrop-blur-xs truncate max-w-[150px] inline-block">
                            /{file.relativePath}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Re-render the detail modal inside this stack when clicked */}
      <MetaDetailModal
        meta={selectedDetail}
        onClose={() => setSelectedDetail(null)}
      />
    </>
  );
}
