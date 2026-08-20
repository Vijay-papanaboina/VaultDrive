"use client";

import { useState } from "react";
import Link from "next/link";
import { Shield, Lock, CheckSquare, Download, Clipboard, Check, Trash2, Search, KeyRound, Files, List, Loader2, AlertCircle } from "lucide-react";
import { UserMenu } from "@/components/user-menu";
import { useSelection } from "@/components/selection-provider";
import { useCrypto } from "@/hooks/use-crypto";
import { useFileDownload } from "@/components/file-download-provider";
import { GlobalSearchModal } from "@/components/global-search-modal";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function formatDownloadBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function DriveHeader() {
  const {
    isSelectionMode,
    toggleSelectionMode,
    selectedFiles,
    clearSelection,
    exportFilesList,
  } = useSelection();
  const { hasPassphrase, setIsGateOpen } = useCrypto();
  const {
    batch,
    downloadItems,
    downloadSelected,
    clearDownloadHistory,
  } = useFileDownload();

  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isDownloadChoiceOpen, setIsDownloadChoiceOpen] = useState(false);
  const [batchResult, setBatchResult] = useState<{
    total: number;
    succeeded: number;
    failed: Array<{ filename: string; error: string }>;
  } | null>(null);
  const [isBatchResultOpen, setIsBatchResultOpen] = useState(false);
  const [isDownloadsOpen, setIsDownloadsOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [rcloneRemote, setRcloneRemote] = useState("mygdrive:");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const downloadList = Object.values(downloadItems).sort(
    (a, b) => b.startedAt - a.startedAt
  );

  const handleExport = () => {
    setIsDownloadChoiceOpen(false);
    exportFilesList();
    setIsExportModalOpen(true);
  };

  const handleOriginalDownload = async () => {
    setIsDownloadChoiceOpen(false);
    setBatchResult(null);
    try {
      const result = await downloadSelected(
        selectedFiles.map((file) => ({
          metaFileId: file.metaFileId,
          fallbackName: file.name,
          expectedSize: file.expectedSize,
        }))
      );
      setBatchResult({
        total: result.total,
        succeeded: result.succeeded,
        failed: result.failed.map((failure) => ({
          filename: failure.filename,
          error: failure.error,
        })),
      });
      setIsBatchResultOpen(true);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setBatchResult({
        total: selectedFiles.length,
        succeeded: 0,
        failed: [{
          filename: "Selected files",
          error: error instanceof Error ? error.message : "Download failed",
        }],
      });
      setIsBatchResultOpen(true);
    }
  };

  const commands = [
    {
      id: "rclone",
      label: "Copyable Rclone Command",
      value: `rclone copy "${rcloneRemote}" ./encrypted-files -P --files-from files.txt`,
    },
    {
      id: "flatten",
      label: "Flatten Command (Run inside destination dir)",
      value: `find . -mindepth 1 -type f -exec mv -t . {} +`,
    },
  ];

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error(`Failed to copy command ${id}:`, err);
    }
  };

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-white/8 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
          {/* Logo / brand */}
          <Link href="/drive" className="cursor-pointer flex items-center gap-2 font-semibold text-foreground">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-600/20 border border-violet-500/30">
              <Lock className="h-3.5 w-3.5 text-violet-400" />
            </div>
            <span>VaultDrive</span>
          </Link>

          <div className="flex flex-1 items-center justify-end gap-3">
            {/* Global Selection Mode controls */}
            <div className="flex items-center gap-2">
              {hasPassphrase && (
                <button
                  onClick={() => setIsGateOpen(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-white/10 hover:text-foreground transition-all cursor-pointer"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  <span>Re-enter Key</span>
                </button>
              )}

              <button
                onClick={() => setIsSearchOpen(true)}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-white/10 hover:text-foreground transition-all cursor-pointer"
              >
                <Search className="h-3.5 w-3.5" />
                <span>Search</span>
              </button>

              {selectedFiles.length > 0 && (
                <>
                  <button
                    onClick={() => setIsDownloadChoiceOpen(true)}
                    disabled={batch?.active}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg shadow-emerald-600/20 transition-all hover:bg-emerald-500 disabled:cursor-wait disabled:opacity-70 cursor-pointer"
                  >
                    {batch?.active ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {batch?.active
                        ? `Downloading ${batch.completed}/${batch.total}`
                        : "Download"}
                    </span>
                  </button>

                  <button
                    onClick={clearSelection}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-red-500/10 hover:text-red-400 transition-all cursor-pointer"
                    title="Clear all selections"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Clear All</span>
                  </button>
                </>
              )}

              {downloadList.length > 0 && (
                <button
                  onClick={() => setIsDownloadsOpen(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:bg-white/10 hover:text-foreground cursor-pointer"
                >
                  {batch?.active ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  <span>
                    {batch?.active
                      ? `Downloads ${batch.completed}/${batch.total}`
                      : `Downloads (${downloadList.length})`}
                  </span>
                </button>
              )}

              <button
                onClick={toggleSelectionMode}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all cursor-pointer ${
                  isSelectionMode
                    ? "bg-violet-600 text-white shadow-lg shadow-violet-600/20"
                    : "border border-white/10 bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
                }`}
              >
                <CheckSquare className="h-3.5 w-3.5" />
                <span>
                  {isSelectionMode
                    ? `Selecting (${selectedFiles.length})`
                    : selectedFiles.length > 0
                    ? `Selected (${selectedFiles.length})`
                    : "Select Files"}
                </span>
              </button>
            </div>

            {/* Security indicator */}
            <div className="hidden items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-400 sm:flex">
              <Shield className="h-3 w-3" />
              Client-side decryption
            </div>
            <UserMenu />
          </div>
        </div>
      </header>

      <Dialog open={isDownloadChoiceOpen} onOpenChange={setIsDownloadChoiceOpen}>
        <DialogContent className="max-w-md border-white/10 bg-[#0f0f13]/95 text-foreground backdrop-blur-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
              <Download className="h-5 w-5 text-emerald-400" />
              Download selected files
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">
              Choose whether to export the encrypted file list or decrypt and save the original files in your browser.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-3 grid gap-3">
            <button
              type="button"
              onClick={handleExport}
              className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 p-4 text-left transition-colors hover:border-violet-400/40 hover:bg-violet-500/10"
            >
              <List className="mt-0.5 h-5 w-5 shrink-0 text-violet-400" />
              <span className="flex flex-col gap-1">
                <span className="text-sm font-medium">Download file list</span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  Save files.txt for rclone and local CLI decryption.
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={handleOriginalDownload}
              disabled={batch?.active}
              className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 p-4 text-left transition-colors hover:border-emerald-400/40 hover:bg-emerald-500/10 disabled:cursor-wait disabled:opacity-60"
            >
              {batch?.active ? (
                <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-emerald-400" />
              ) : (
                <Files className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
              )}
              <span className="flex flex-col gap-1">
                <span className="text-sm font-medium">Download original files</span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  Fetch, decrypt, and save {selectedFiles.length} file{selectedFiles.length === 1 ? "" : "s"} one at a time.
                </span>
              </span>
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isDownloadsOpen} onOpenChange={setIsDownloadsOpen}>
        <DialogContent className="max-w-lg border-white/10 bg-[#0f0f13]/95 text-foreground backdrop-blur-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
              <Download className="h-5 w-5 text-emerald-400" />
              Downloads
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">
              Files stream from Drive, decrypt, and write to disk in chunks when your browser supports direct file access.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-2 max-h-[55vh] space-y-2 overflow-y-auto pr-1 custom-scrollbar">
            {downloadList.map((item) => {
              const progress = item.expectedSize && item.expectedSize > 0
                ? Math.min(100, (item.bytesWritten / item.expectedSize) * 100)
                : item.stage === "complete"
                  ? 100
                  : 0;
              const stageLabel = item.stage === "resolving"
                ? "Preparing"
                : item.stage === "downloading"
                  ? "Downloading encrypted payload"
                  : item.stage === "streaming"
                    ? "Decrypting and writing stream"
                    : item.stage === "complete"
                      ? "Complete"
                      : "Failed";

              return (
                <div
                  key={item.metaFileId}
                  className="rounded-xl border border-white/8 bg-white/3 p-3"
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0">
                      {item.stage === "complete" ? (
                        <Check className="h-4 w-4 text-emerald-400" />
                      ) : item.stage === "failed" ? (
                        <AlertCircle className="h-4 w-4 text-amber-400" />
                      ) : (
                        <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" title={item.filename}>
                        {item.filename}
                      </p>
                      <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                        <span>{stageLabel}</span>
                        {item.expectedSize ? (
                          <span>{formatDownloadBytes(item.bytesWritten)} / {formatDownloadBytes(item.expectedSize)}</span>
                        ) : item.bytesWritten > 0 ? (
                          <span>{formatDownloadBytes(item.bytesWritten)}</span>
                        ) : null}
                      </div>
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                        {item.stage === "streaming" && !item.expectedSize ? (
                          <div className="h-full w-1/3 animate-pulse rounded-full bg-violet-400" />
                        ) : (
                          <div
                            className={`h-full rounded-full transition-[width] duration-300 ${item.stage === "failed" ? "bg-amber-400" : "bg-emerald-400"}`}
                            style={{ width: `${progress}%` }}
                          />
                        )}
                      </div>
                      {item.error && (
                        <p className="mt-1.5 text-[11px] text-amber-200/80">{item.error}</p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={clearDownloadHistory}
              disabled={batch?.active}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear history
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isBatchResultOpen} onOpenChange={setIsBatchResultOpen}>
        <DialogContent className="max-w-md border-white/10 bg-[#0f0f13]/95 text-foreground backdrop-blur-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
              {batchResult?.failed.length ? (
                <AlertCircle className="h-5 w-5 text-amber-400" />
              ) : (
                <Check className="h-5 w-5 text-emerald-400" />
              )}
              Original download complete
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">
              {batchResult?.succeeded ?? 0} of {batchResult?.total ?? 0} file{batchResult?.total === 1 ? "" : "s"} downloaded successfully.
            </DialogDescription>
          </DialogHeader>

          {batchResult?.failed.length ? (
            <div className="mt-2 space-y-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
              <p className="text-xs font-medium text-amber-300">Files that could not be downloaded</p>
              {batchResult.failed.map((failure) => (
                <div key={`${failure.filename}-${failure.error}`} className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{failure.filename}</span>
                  <span className="block text-amber-200/70">{failure.error}</span>
                </div>
              ))}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Rclone Command helper Dialog */}
      <Dialog open={isExportModalOpen} onOpenChange={setIsExportModalOpen}>
        <DialogContent className="max-w-md border-white/10 bg-[#0f0f13]/95 text-foreground backdrop-blur-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
              <Download className="h-5 w-5 text-emerald-400" />
              files.txt Downloaded Successfully
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">
              Use this command to download the encrypted files using rclone.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            {/* Input field to customize the rclone remote */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Rclone Remote Name & Path
              </label>
              <input
                type="text"
                value={rcloneRemote}
                onChange={(e) => setRcloneRemote(e.target.value)}
                placeholder="mygdrive:secure-backup"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-foreground placeholder-white/30 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 transition-all"
              />
              <span className="text-[10px] text-muted-foreground/60 block">
                Change this to match your local rclone config name and Google Drive path.
              </span>
            </div>

            {/* Copyable commands */}
            {commands.map((cmd) => (
              <div key={cmd.id} className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  {cmd.label}
                </label>
                <div className="relative flex items-center justify-between rounded-lg bg-[#070709] border border-white/5 p-3 text-xs font-mono text-violet-300">
                  <span className="break-all pr-8 leading-relaxed">
                    {cmd.value}
                  </span>
                  <button
                    onClick={() => handleCopy(cmd.id, cmd.value)}
                    className="absolute right-2 top-2 p-1.5 rounded-md hover:bg-white/5 text-muted-foreground hover:text-foreground transition-all"
                    title={`Copy ${cmd.label} to clipboard`}
                  >
                    {copiedId === cmd.id ? (
                      <Check className="h-4 w-4 text-emerald-400" />
                    ) : (
                      <Clipboard className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            ))}

            {/* Instructions */}
            <div className="rounded-lg bg-white/5 border border-white/5 p-3 text-[11px] leading-relaxed text-muted-foreground space-y-1">
              <p className="font-semibold text-foreground">Next Steps:</p>
              <p>1. Move the downloaded <code className="text-violet-400 font-mono">files.txt</code> into the directory where you plan to run the command.</p>
              <p>2. Run the copied command in your terminal.</p>
              <p>3. Use <code className="text-violet-400 font-mono">decrypt-file.mjs</code> to restore the original filenames after downloading.</p>
              <p>4. (Optional) Run the flatten command inside the destination folder to move all nested files to the root level.</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <GlobalSearchModal isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />
    </>
  );
}
