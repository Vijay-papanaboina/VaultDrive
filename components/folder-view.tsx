"use client";

import { useQuery } from "@tanstack/react-query";
import { useMetaFiles } from "@/hooks/use-meta-files";
import { useCrypto } from "@/hooks/use-crypto";
import { MetaGrid } from "@/components/meta-grid";
import { FolderList } from "@/components/folder-list";
import { BreadcrumbNav } from "@/components/breadcrumb-nav";
import FolderLoading from "@/app/drive/[folderId]/loading";
import type { DriveFolder, BreadcrumbItem } from "@/types";
import { Folder, RefreshCw, KeyRound, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
    hasPassphrase,
    clearPassphrase,
    dismissedPassphraseError,
    setDismissedPassphraseError,
  } = useCrypto();

  const { data: subFolders = [], isLoading: isFoldersLoading, error: foldersError } = useQuery<DriveFolder[]>({
    queryKey: ["subfolders", folderId],
    queryFn: () => fetchSubfolders(folderId),
    enabled: !!folderId,
  });

  const { data: breadcrumbs = [], isLoading: isPathLoading, error: pathError } = useQuery<BreadcrumbItem[]>({
    queryKey: ["breadcrumbs", folderId],
    queryFn: () => fetchBreadcrumbs(folderId),
    enabled: !!folderId,
  });

  const { files, isListLoading, isDecrypting, error: metaError, refetch } = useMetaFiles(folderId);

  const isLoading = isFoldersLoading || isPathLoading || isListLoading;

  if (isLoading) {
    return <FolderLoading />;
  }

  const combinedError = metaError || foldersError?.message || pathError?.message || null;
  const showMetaSection = files.length > 0 || isListLoading || !!combinedError;

  const hasDecryptionErrors = files.some((f) => f.decryptError);
  const showPrompt = hasDecryptionErrors && !dismissedPassphraseError && !isDecrypting && !isListLoading;

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

      {/* Subfolder section */}
      {subFolders.length > 0 && (
        <section>
          <div className="mb-3 flex items-center gap-2">
            <Folder className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Folders ({subFolders.length})
            </h2>
          </div>
          <FolderList folders={subFolders} />
        </section>
      )}

      {/* Meta files section */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              {showMetaSection
                ? `Encrypted files${files.length > 0 ? ` (${files.length})` : ""}`
                : "No .meta files"}
            </h2>
            {isDecrypting && (
              <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-400 animate-pulse">
                Decrypting...
              </span>
            )}
          </div>
          {hasPassphrase && showMetaSection && (
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

        {!showMetaSection ? (
          <div className="rounded-xl border border-white/8 bg-white/3 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No <code className="rounded bg-white/5 px-1 text-xs">.meta</code> files in this folder.
            </p>
          </div>
        ) : (
          <MetaGrid files={files} isLoading={isListLoading} error={combinedError} />
        )}
      </section>

      <Dialog open={showPrompt} onOpenChange={(open) => { if (!open) handleDismiss(); }}>
        <DialogContent id="decryption-error-prompt-dialog" className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/15">
              <KeyRound className="h-5 w-5 text-amber-400" />
            </div>
            <DialogTitle>Decryption failed for some files</DialogTitle>
            <DialogDescription>
              Some files in this folder could not be decrypted. This might be due to a wrong passphrase. Would you like to re-enter it?
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
            <Button
              className="flex-1 gap-2"
              onClick={handleReenter}
            >
              <RotateCcw className="h-4 w-4" />
              Re-enter
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
