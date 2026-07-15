"use client";

import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRecursiveMetaFiles } from "@/hooks/use-recursive-meta-files";
import { useCrypto } from "@/hooks/use-crypto";
import { MetaGrid } from "@/components/meta-grid";
import { BreadcrumbNav } from "@/components/breadcrumb-nav";
import { Badge } from "@/components/ui/badge";
import FolderLoading from "@/app/drive/[folderId]/loading";
import type { BreadcrumbItem, DriveMetaFile, ProgressiveMetaFile } from "@/types";
import {
  RefreshCw,
  RotateCcw,
  ArrowUpDown,
  Search,
  X,
  FileX,
  ChevronDown,
  KeyRound,
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

interface SearchViewProps {
  folderId: string;
}

async function fetchBreadcrumbs(folderId: string): Promise<BreadcrumbItem[]> {
  const params = new URLSearchParams({ folderId });
  const res = await fetch(`/api/drive/path?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch breadcrumbs");
  const data = await res.json();
  return data.path as BreadcrumbItem[];
}

export function SearchView({ folderId }: SearchViewProps) {
  const {
    clearPassphrase,
    dismissedPassphraseError,
    setDismissedPassphraseError,
  } = useCrypto();

  const {
    data: breadcrumbs = [],
    isLoading: isPathLoading,
    error: pathError,
  } = useQuery<BreadcrumbItem[]>({
    queryKey: ["breadcrumbs", folderId],
    queryFn: () => fetchBreadcrumbs(folderId),
    enabled: !!folderId,
  });

  // Derive root folder display name from breadcrumbs (everything except "my drive")
  const rootFolderName = breadcrumbs
    .map((b) => b.name)
    .filter((name) => name.toLowerCase() !== "my drive")
    .join("/");

  const {
    files,
    isCrawling,
    isListLoading,
    isDecrypting,
    error: metaError,
    refetch,
    cancelDecryption,
    folderIdToPath,
  } = useRecursiveMetaFiles(folderId, rootFolderName || undefined);

  const [searchQuery, setSearchQuery] = useState("");
  const [prevFolderId, setPrevFolderId] = useState(folderId);
  const [sortBy, setSortBy] = useState<
    "created" | "modified" | "size" | "name"
  >("created");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [isDecryptPromptOpen, setIsDecryptPromptOpen] = useState(false);

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
    // Defer the reordering update slightly so the dropdown closes and updates tick mark instantly
    setTimeout(() => {
      setSortBy(newSortBy);
      if (newSortBy === "name") {
        setSortOrder("asc");
      } else {
        setSortOrder("desc");
      }
    }, 50);
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

  // folderIdToPath built during BFS; used to give each file its correct subfolder path
  // Falls back to rootFolderName if a folderId isn't in the map yet (e.g. root itself)
  const getRelativePath = (file: ProgressiveMetaFile) => {
    const fid = (file.driveFile as DriveMetaFile & { folderId?: string }).folderId;
    return fid ? (folderIdToPath[fid] ?? rootFolderName) : rootFolderName;
  };

  const isLoading = isCrawling || isPathLoading;

  const hasDecryptionErrors = files.some((f) => f.decryptError);

  useEffect(() => {
    if (hasDecryptionErrors && !dismissedPassphraseError) {
      const timeoutId = window.setTimeout(() => {
        setDismissedPassphraseError(true);
        setIsDecryptPromptOpen(true);
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [hasDecryptionErrors, dismissedPassphraseError, setDismissedPassphraseError]);

  if (isLoading) {
    return <FolderLoading />;
  }

  const combinedError =
    metaError || pathError?.message || null;
  const showMetaSection = files.length > 0 || isListLoading || !!combinedError;

  const handleDismiss = () => {
    setIsDecryptPromptOpen(false);
  };

  const handleReenter = () => {
    const firstErrFile = files.find((f) => f.decryptError);
    setIsDecryptPromptOpen(false);
    clearPassphrase(firstErrFile?.decryptError || "Decryption failed");
  };

  const handleCancelAndStop = () => {
    setIsDecryptPromptOpen(false);
    cancelDecryption();
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumb & Search Mode Badge */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/5 pb-4">
        {breadcrumbs.length > 0 && (
          <div className="flex items-center gap-3">
            <BreadcrumbNav path={breadcrumbs} />
            <Badge variant="secondary" className="bg-violet-500/10 border border-violet-500/20 text-violet-400 font-mono text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5">
              Recursive Search Mode
            </Badge>
          </div>
        )}
      </div>

      {/* Meta Files Grid */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Recursive Files
            </h2>
            {isDecrypting && (
              <span className="text-[10px] text-violet-400 font-mono animate-pulse">
                (Decrypting in background...)
              </span>
            )}
          </div>
          {showMetaSection && (
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/40" />
                <input
                  type="text"
                  placeholder="Search recursive files..."
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
              files found recursively in this folder or its subfolders.
            </p>
          </div>
        ) : files.length > 0 && filteredFiles.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-white/8 bg-white/3 py-16 text-center">
            <FileX className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="font-medium text-muted-foreground">No matches found</p>
              <p className="mt-1 text-sm text-muted-foreground/60">
                No recursive files match &quot;{searchQuery}&quot;.
              </p>
            </div>
          </div>
        ) : (
          <MetaGrid
            files={sortedFiles}
            isLoading={isListLoading}
            error={combinedError}
            relativePath={rootFolderName}
            getRelativePath={getRelativePath}
          />
        )}
      </section>

      <Dialog
        open={isDecryptPromptOpen}
        onOpenChange={(open) => {
          setIsDecryptPromptOpen(open);
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
              Some files in these folders could not be decrypted. This might be
              due to a wrong passphrase. Would you like to re-enter it?
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 mt-5 sm:grid-cols-3">
            <Button
              variant="outline"
              className="w-full h-9 px-4"
              onClick={handleDismiss}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="w-full h-9 px-4 whitespace-normal text-center leading-tight"
              onClick={handleCancelAndStop}
            >
              Stop
            </Button>
            <Button className="w-full h-9 gap-2 px-4" onClick={handleReenter}>
              <RotateCcw className="h-4 w-4" />
              Re-enter
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
