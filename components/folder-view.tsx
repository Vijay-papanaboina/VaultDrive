"use client";

import { useQuery } from "@tanstack/react-query";
import { useMetaFiles } from "@/hooks/use-meta-files";
import { useCrypto } from "@/hooks/use-crypto";
import { FolderList } from "@/components/folder-list";
import { BreadcrumbNav } from "@/components/breadcrumb-nav";
import { DecryptionErrorDialog } from "@/components/decryption-error-dialog";
import { DriveFileBrowser } from "@/components/drive-file-browser";
import FolderLoading from "@/app/drive/[folderId]/loading";
import type { DriveFolder, BreadcrumbItem } from "@/types";
import { Folder } from "lucide-react";
import { fetchBreadcrumbs, fetchSubfolders } from "@/lib/drive-client";
import { breadcrumbsToRelativePath } from "@/lib/drive-path";
import { useDecryptionErrorPrompt } from "@/hooks/use-decryption-error-prompt";

interface FolderViewProps {
  folderId: string;
}

export function FolderView({ folderId }: FolderViewProps) {
  const {
    clearPassphrase,
    dismissedPassphraseError,
    setDismissedPassphraseError,
  } = useCrypto();

  const {
    files,
    isListLoading,
    isDecrypting,
    error: metaError,
    refetch,
    cancelDecryption,
    refreshKey,
  } = useMetaFiles(folderId);

  const {
    data: subFolders = [],
    isLoading: isFoldersLoading,
    error: foldersError,
  } = useQuery<DriveFolder[]>({
    queryKey: ["subfolders", folderId, refreshKey],
    queryFn: () => fetchSubfolders(folderId, refreshKey > 0),
    enabled: !!folderId,
  });

  const {
    data: breadcrumbs = [],
    isLoading: isPathLoading,
    error: pathError,
  } = useQuery<BreadcrumbItem[]>({
    queryKey: ["breadcrumbs", folderId, refreshKey],
    queryFn: () => fetchBreadcrumbs(folderId, refreshKey > 0),
    enabled: !!folderId,
  });

  const relativePath = breadcrumbsToRelativePath(breadcrumbs);

  const isLoading = isFoldersLoading || isPathLoading;
  const decryptPrompt = useDecryptionErrorPrompt({
    files,
    dismissedPassphraseError,
    setDismissedPassphraseError,
    clearPassphrase,
    cancelDecryption,
  });

  if (isLoading) {
    return <FolderLoading />;
  }

  const combinedError =
    metaError || foldersError?.message || pathError?.message || null;

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

      <DriveFileBrowser
        folderId={folderId}
        heading="Files"
        files={files}
        isListLoading={isListLoading}
        isDecrypting={isDecrypting}
        error={combinedError}
        relativePath={relativePath}
        onRefresh={refetch}
        searchPlaceholder="Search files..."
        emptyMessage={'No `.meta` files in this folder.'}
        noMatchesMessage={(query) => `No files in this folder match "${query}".`}
      />

      <DecryptionErrorDialog
        open={decryptPrompt.isOpen}
        description="Some files in this folder could not be decrypted. This might be due to a wrong passphrase. Would you like to re-enter it?"
        onOpenChange={decryptPrompt.setIsOpen}
        onCancel={decryptPrompt.dismiss}
        onStop={decryptPrompt.stop}
        onReenter={decryptPrompt.reenter}
      />
    </div>
  );
}
