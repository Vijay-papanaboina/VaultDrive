"use client";

import type { ReactNode } from "react";
import { ArrowUpDown, ChevronDown, FileX, RefreshCw, Search, X } from "lucide-react";
import { MetaGrid } from "@/components/meta-grid";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDriveFileBrowserState } from "@/hooks/use-drive-file-browser-state";
import type { ProgressiveMetaFile } from "@/types";

interface DriveFileBrowserProps {
  folderId: string;
  heading: string;
  headingAccessory?: ReactNode;
  files: ProgressiveMetaFile[];
  isListLoading: boolean;
  isDecrypting: boolean;
  error: string | null;
  relativePath: string;
  getRelativePath?: (file: ProgressiveMetaFile) => string;
  onRefresh: () => void;
  searchPlaceholder: string;
  emptyMessage: string;
  noMatchesMessage: (query: string) => string;
  deferSortChange?: boolean;
}

export function DriveFileBrowser({
  folderId,
  heading,
  headingAccessory,
  files,
  isListLoading,
  isDecrypting,
  error,
  relativePath,
  getRelativePath,
  onRefresh,
  searchPlaceholder,
  emptyMessage,
  noMatchesMessage,
  deferSortChange = false,
}: DriveFileBrowserProps) {
  const {
    searchQuery,
    setSearchQuery,
    sortBy,
    sortOrder,
    filteredFiles,
    sortedFiles,
    handleSortChange,
    toggleSortOrder,
  } = useDriveFileBrowserState({
    files,
    folderId,
    deferSortChange,
  });

  const showMetaSection = files.length > 0 || isListLoading || !!error;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {heading}
          </h2>
          {headingAccessory}
        </div>
        {showMetaSection && (
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/40" />
              <input
                type="text"
                placeholder={searchPlaceholder}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 w-72 rounded-lg border border-white/10 bg-white/5 pl-8 pr-7 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 transition-all focus:border-white/50 focus:outline-none focus:ring-0"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
                  title="Clear search"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                id="sort-meta-trigger"
                className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 text-xs text-muted-foreground hover:bg-white/10 hover:text-foreground focus:outline-none"
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
              <DropdownMenuContent
                align="end"
                className="w-48 border border-white/10 bg-popover text-popover-foreground"
              >
                <DropdownMenuRadioGroup
                  value={sortBy}
                  onValueChange={(value) =>
                    handleSortChange(value as "created" | "modified" | "size" | "name")
                  }
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
              className="h-8 w-8 cursor-pointer border-white/10 bg-white/5 p-0 text-muted-foreground hover:bg-white/10 hover:text-foreground"
              onClick={toggleSortOrder}
              aria-label={`Switch to ${sortOrder === "asc" ? "descending" : "ascending"} sort order`}
              title={`Switch to ${sortOrder === "asc" ? "descending" : "ascending"} sort order`}
            >
              <ArrowUpDown className="h-3.5 w-3.5" />
            </Button>
            <Button
              id="refresh-meta-btn"
              variant="outline"
              size="default"
              className="h-8 cursor-pointer gap-1.5 border-white/10 bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
              disabled={isListLoading || isDecrypting}
              onClick={onRefresh}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>
        )}
      </div>

      {!showMetaSection ? (
        <div className="rounded-xl border border-white/8 bg-white/3 py-12 text-center">
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        </div>
      ) : files.length > 0 && filteredFiles.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-white/8 bg-white/3 py-16 text-center">
          <FileX className="h-10 w-10 text-muted-foreground/40" />
          <div>
            <p className="font-medium text-muted-foreground">No matches found</p>
            <p className="mt-1 text-sm text-muted-foreground/60">
              {noMatchesMessage(searchQuery)}
            </p>
          </div>
        </div>
      ) : (
        <MetaGrid
          files={sortedFiles}
          isLoading={isListLoading}
          error={error}
          relativePath={relativePath}
          getRelativePath={getRelativePath}
        />
      )}
    </section>
  );
}
