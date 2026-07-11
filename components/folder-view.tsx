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

  const relativePath = breadcrumbs.map((b) => b.name).join("/");

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
            <Button
              id="refresh-meta-btn"
              variant="outline"
              size="xs"
              className="gap-1 bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10 hover:text-foreground"
              disabled={isListLoading || isDecrypting}
              onClick={() => refetch()}
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
          <MetaGrid files={files} isLoading={isListLoading} error={combinedError} relativePath={relativePath} />
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
