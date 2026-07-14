"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMetaFiles } from "@/hooks/use-meta-files";
import { useCrypto } from "@/hooks/use-crypto";
import { MetaGrid } from "@/components/meta-grid";
import { FolderList } from "@/components/folder-list";
import { BreadcrumbNav } from "@/components/breadcrumb-nav";
import FolderLoading from "@/app/drive/[folderId]/loading";
import type { DriveFolder, BreadcrumbItem } from "@/types";
import {
  Folder,
  RefreshCw,
  KeyRound,
  RotateCcw,
  ArrowUpDown,
  Search,
  X,
  FileX,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface FolderViewProps {
  folderId: string;
}

async function fetchSubfolders(parentId: string): Promise<DriveFolder[]> {
  const params = new URLSearchParams({ parentId });
  const res = await fetch(`/api/drive/folders?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch folders");
  const data = await res.json();
  return data.folders;
}

async function fetchBreadcrumbs(folderId: string): Promise<BreadcrumbItem[]> {
  const params = new URLSearchParams({ folderId });
  const res = await fetch(`/api/drive/path?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch breadcrumbs");
  const data = await res.json();
  return data.path;
}

export function FolderView({ folderId }: FolderViewProps) {
  const {
    clearPassphrase,
    dismissedPassphraseError,
    setDismissedPassphraseError,
  } = useCrypto();

  const {
    data: subFolders = [],
    isLoading: isFoldersLoading,
    error: foldersError,
  } = useQuery<DriveFolder[]>({
    queryKey: ["subfolders", folderId],
    queryFn: () => fetchSubfolders(folderId),
    enabled: !!folderId,
  });

  const {
    data: breadcrumbs = [],
    isLoading: isPathLoading,
    error: pathError,
  } = useQuery<BreadcrumbItem[]>({
    queryKey: ["breadcrumbs", folderId],
    queryFn: () => fetchBreadcrumbs(folderId),
    enabled: !!folderId,
  });

  const {
    files,
    isListLoading,
    isDecrypting,
    error: metaError,
    refetch,
  } = useMetaFiles(folderId);

  const [searchQuery, setSearchQuery] = useState("");
  const [prevFolderId, setPrevFolderId] = useState(folderId);
  const [sortBy, setSortBy] = useState<
    "created" | "modified" | "size" | "name"
  >("created");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // Reset inline search query when folder changes
  if (folderId !== prevFolderId) {
    setPrevFolderId(folderId);
    setSearchQuery("");
  }

  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return files;
    const normalize = (str: string) => str.toLowerCase().replace(/\s+/g, "");
    const queryNormalized = normalize(searchQuery);
    return files.filter((f) => {
      const origNormalized = normalize(f.originalFileName);
      const decNormalized = f.details?.name ? normalize(f.details.name) : "";
      return (
        origNormalized.includes(queryNormalized) ||
        decNormalized.includes(queryNormalized)
      );
    });
  }, [files, searchQuery]);

  const handleSortChange = (
    newSortBy: "created" | "modified" | "size" | "name",
  ) => {
    setSortBy(newSortBy);
    if (newSortBy === "name") {
      setSortOrder("asc");
    } else {
      setSortOrder("desc");
    }
  };

  const sortedFiles = [...filteredFiles].sort((a, b) => {
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
    } else if (sortBy === "name") {
      comparison = a.driveFile.name.localeCompare(b.driveFile.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    }
    return sortOrder === "asc" ? comparison : -comparison;
  });

  const relativePath = breadcrumbs
    .map((b) => b.name)
    .filter((name) => name.toLowerCase() !== "my drive")
    .join("/");

  const isLoading = isFoldersLoading || isPathLoading;

  if (isLoading) {
    return <FolderLoading />;
  }

  const combinedError =
    metaError || foldersError?.message || pathError?.message || null;
  const showMetaSection = files.length > 0 || isListLoading || !!combinedError;

  const hasDecryptionErrors = files.some((f) => f.decryptError);
  const showPrompt =
    hasDecryptionErrors &&
    !dismissedPassphraseError &&
    !isDecrypting &&
    !isListLoading;

  const handleDismiss = () => {
    setDismissedPassphraseError(true);
  };

  const handleReenter = () => {
    const firstErrFile = files.find((f) => f.decryptError);
    clearPassphrase(firstErrFile?.decryptError || "Decryption failed");
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumb */}
      {breadcrumbs.length > 0 && <BreadcrumbNav path={breadcrumbs} />}

      {/* Subfolders List */}
      {subFolders.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Folder className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Folders
            </h2>
          </div>
          <FolderList folders={subFolders} />
        </section>
      )}

      {/* Meta Files Grid */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Files
          </h2>
          {showMetaSection && (
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/40" />
                <input
                  type="text"
                  placeholder="Search files..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-8 w-72 rounded-lg border border-white/10 bg-white/5 pl-8 pr-7 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-white/50 focus:outline-none focus:ring-0 transition-all font-mono"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded-full hover:bg-white/10 text-muted-foreground hover:text-foreground cursor-pointer"
                    title="Clear search"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger
                  id="sort-meta-trigger"
                  className="h-8 rounded-lg border border-white/10 bg-white/5 px-2.5 text-xs text-muted-foreground hover:bg-white/10 hover:text-foreground focus:outline-none cursor-pointer flex items-center gap-1.5"
                >
                  <span>
                    {sortBy === "created"
                      ? "Sort: Created Time"
                      : sortBy === "modified"
                      ? "Sort: Modified Time"
                      : sortBy === "size"
                      ? "Sort: Original Size"
                      : "Sort: Meta Name"}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48 bg-popover text-popover-foreground border border-white/10">
                  <DropdownMenuRadioGroup
                    value={sortBy}
                    onValueChange={(val) => handleSortChange(val as "created" | "modified" | "size" | "name")}
                  >
                    <DropdownMenuRadioItem value="created" className="cursor-pointer">
                      Created Time
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="modified" className="cursor-pointer">
                      Modified Time
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="size" className="cursor-pointer">
                      Original Size
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="name" className="cursor-pointer">
                      Meta Name
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                id="toggle-sort-order-btn"
                variant="outline"
                size="default"
                className="h-8 w-8 p-0 bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10 hover:text-foreground cursor-pointer"
                onClick={() =>
                  setSortOrder((o) => (o === "asc" ? "desc" : "asc"))
                }
                aria-label={`Switch to ${sortOrder === "asc" ? "descending" : "ascending"} sort order`}
                title={`Switch to ${sortOrder === "asc" ? "descending" : "ascending"} sort order`}
              >
                <ArrowUpDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                id="refresh-meta-btn"
                variant="outline"
                size="default"
                className="gap-1.5 h-8 bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10 hover:text-foreground cursor-pointer"
                disabled={isListLoading || isDecrypting}
                onClick={() => refetch()}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </Button>
            </div>
          )}
        </div>

        {!showMetaSection ? (
          <div className="rounded-xl border border-white/8 bg-white/3 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No <code className="rounded bg-white/5 px-1 text-xs">.meta</code>{" "}
              files in this folder.
            </p>
          </div>
        ) : files.length > 0 && filteredFiles.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-white/8 bg-white/3 py-16 text-center">
            <FileX className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="font-medium text-muted-foreground">No matches found</p>
              <p className="mt-1 text-sm text-muted-foreground/60">
                No files in this folder match &quot;{searchQuery}&quot;.
              </p>
            </div>
          </div>
        ) : (
          <MetaGrid
            files={sortedFiles}
            isLoading={isListLoading}
            error={combinedError}
            relativePath={relativePath}
          />
        )}
      </section>

      <Dialog
        open={showPrompt}
        onOpenChange={(open) => {
          if (!open) handleDismiss();
        }}
      >
        <DialogContent
          id="decryption-error-prompt-dialog"
          className="sm:max-w-sm"
          showCloseButton={false}
        >
          <DialogHeader>
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/15">
              <KeyRound className="h-5 w-5 text-amber-400" />
            </div>
            <DialogTitle>Decryption failed for some files</DialogTitle>
            <DialogDescription>
              Some files in this folder could not be decrypted. This might be
              due to a wrong passphrase. Would you like to re-enter it?
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-3 mt-4">
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleDismiss}
            >
              Cancel
            </Button>
            <Button className="flex-1 gap-2" onClick={handleReenter}>
              <RotateCcw className="h-4 w-4" />
              Re-enter
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
