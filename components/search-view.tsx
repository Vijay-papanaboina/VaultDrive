"use client";

import { useQuery } from "@tanstack/react-query";
import { useRecursiveMetaFiles } from "@/hooks/use-recursive-meta-files";
import { useCrypto } from "@/hooks/use-crypto";
import { BreadcrumbNav } from "@/components/breadcrumb-nav";
import { Badge } from "@/components/ui/badge";
import { DecryptionErrorDialog } from "@/components/decryption-error-dialog";
import { DriveFileBrowser } from "@/components/drive-file-browser";
import FolderLoading from "@/app/drive/[folderId]/loading";
import type { BreadcrumbItem, DriveMetaFile, ProgressiveMetaFile } from "@/types";
import { fetchBreadcrumbs } from "@/lib/drive-client";
import { breadcrumbsToRelativePath } from "@/lib/drive-path";
import { useDecryptionErrorPrompt } from "@/hooks/use-decryption-error-prompt";

interface SearchViewProps {
  folderId: string;
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
  const rootFolderName = breadcrumbsToRelativePath(breadcrumbs);

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

  // folderIdToPath built during BFS; used to give each file its correct subfolder path
  // Falls back to rootFolderName if a folderId isn't in the map yet (e.g. root itself)
  const getRelativePath = (file: ProgressiveMetaFile) => {
    const fid = (file.driveFile as DriveMetaFile & { folderId?: string }).folderId;
    return fid ? (folderIdToPath[fid] ?? rootFolderName) : rootFolderName;
  };

  const isLoading = isCrawling || isPathLoading;
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
    metaError || pathError?.message || null;

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

      <DriveFileBrowser
        folderId={folderId}
        heading="Recursive Files"
        headingAccessory={
          isDecrypting ? (
            <span className="animate-pulse font-mono text-[10px] text-violet-400">
              (Decrypting in background...)
            </span>
          ) : null
        }
        files={files}
        isListLoading={isListLoading}
        isDecrypting={isDecrypting}
        error={combinedError}
        relativePath={rootFolderName}
        getRelativePath={getRelativePath}
        onRefresh={refetch}
        searchPlaceholder="Search recursive files..."
        emptyMessage={'No `.meta` files found recursively in this folder or its subfolders.'}
        noMatchesMessage={(query) => `No recursive files match "${query}".`}
        deferSortChange
      />

      <DecryptionErrorDialog
        open={decryptPrompt.isOpen}
        description="Some files in these folders could not be decrypted. This might be due to a wrong passphrase. Would you like to re-enter it?"
        onOpenChange={decryptPrompt.setIsOpen}
        onCancel={decryptPrompt.dismiss}
        onStop={decryptPrompt.stop}
        onReenter={decryptPrompt.reenter}
      />
    </div>
  );
}
