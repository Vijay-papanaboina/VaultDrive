"use client";

import { useMetaFiles } from "@/hooks/use-meta-files";
import { useCrypto } from "@/hooks/use-crypto";
import { PasswordDialog } from "@/components/password-dialog";
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
  firstMetaFileId: string | null; // used to validate passphrase
}

export function FolderView({
  folderId,
  initialFolders,
  breadcrumbs,
  firstMetaFileId,
}: FolderViewProps) {
  const { hasPassphrase } = useCrypto();
  const { files, isLoading, error, refetch } = useMetaFiles(folderId);

  // Derive dialog visibility — no state/effect needed
  const hasMeta = firstMetaFileId !== null;
  const showPasswordDialog = hasMeta && !hasPassphrase;

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
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              {hasMeta
                ? hasPassphrase
                  ? `Encrypted files${files.length > 0 ? ` (${files.length})` : ""}`
                  : "Encrypted files · passphrase required"
                : "No .meta files"}
            </h2>
          </div>
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
              No <code className="rounded bg-white/5 px-1 text-xs">.meta</code> files found in this folder.
            </p>
          </div>
        ) : !hasPassphrase ? (
          <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              Enter your passphrase above to decrypt and view metadata.
            </p>
          </div>
        ) : (
          <MetaGrid files={files} isLoading={isLoading} error={error} />
        )}
      </section>

      {/* Password dialog shown until passphrase is set */}
      {showPasswordDialog && firstMetaFileId && (
        <PasswordDialog
          testFileId={firstMetaFileId}
          onSuccess={() => { /* hasPassphrase flips → showPasswordDialog auto-hides */ }}
        />
      )}
    </div>
  );
}
