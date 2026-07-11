"use client";

import { useMetaFiles } from "@/hooks/use-meta-files";
import { useCrypto } from "@/hooks/use-crypto";
import { MetaGrid } from "@/components/meta-grid";
import { FolderList } from "@/components/folder-list";
import { BreadcrumbNav } from "@/components/breadcrumb-nav";
import type { DriveFolder, BreadcrumbItem } from "@/types";
import { Folder, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface FolderViewProps {
  folderId: string;
  initialFolders: DriveFolder[];
  breadcrumbs: BreadcrumbItem[];
  firstMetaFileId: string | null;
}

export function FolderView({
  folderId,
  initialFolders,
  breadcrumbs,
  firstMetaFileId,
}: FolderViewProps) {
  const { hasPassphrase } = useCrypto();
  const { files, isLoading, error, refetch } = useMetaFiles(folderId);

  const hasMeta = firstMetaFileId !== null;

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumb */}
      <BreadcrumbNav path={breadcrumbs} />

      {/* Subfolder section */}
      {initialFolders.length > 0 && (
        <section>
          <div className="mb-3 flex items-center gap-2">
            <Folder className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Folders ({initialFolders.length})
            </h2>
          </div>
          <FolderList folders={initialFolders} />
        </section>
      )}

      {/* Meta files section */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            {hasMeta
              ? `Encrypted files${files.length > 0 ? ` (${files.length})` : ""}`
              : "No .meta files"}
          </h2>
          {hasPassphrase && hasMeta && (
            <Button
              id="refetch-btn"
              variant="ghost"
              size="sm"
              onClick={refetch}
              className="gap-1.5 text-xs text-muted-foreground"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </Button>
          )}
        </div>

        {!hasMeta ? (
          <div className="rounded-xl border border-white/8 bg-white/3 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No <code className="rounded bg-white/5 px-1 text-xs">.meta</code> files in this folder.
            </p>
          </div>
        ) : (
          <MetaGrid files={files} isLoading={isLoading} error={error} />
        )}
      </section>
    </div>
  );
}
