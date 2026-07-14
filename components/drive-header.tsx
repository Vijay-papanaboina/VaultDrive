"use client";

import { useState } from "react";
import Link from "next/link";
import { Shield, Lock, CheckSquare, Download, Clipboard, Check, Trash2, Search, KeyRound } from "lucide-react";
import { UserMenu } from "@/components/user-menu";
import { useSelection } from "@/components/selection-provider";
import { useCrypto } from "@/hooks/use-crypto";
import { GlobalSearchModal } from "@/components/global-search-modal";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function DriveHeader() {
  const {
    isSelectionMode,
    toggleSelectionMode,
    selectedFiles,
    clearSelection,
    exportFilesList,
  } = useSelection();
  const { hasPassphrase, setIsGateOpen } = useCrypto();

  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [rcloneRemote, setRcloneRemote] = useState("mygdrive:");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleExport = () => {
    exportFilesList();
    setIsExportModalOpen(true);
  };

  const commands = [
    {
      id: "rclone",
      label: "Copyable Rclone Command",
      value: `rclone copy "${rcloneRemote}" ./decrypted-files --files-from files.txt`,
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
                    onClick={handleExport}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg shadow-emerald-600/20 transition-all hover:bg-emerald-500 cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Download List</span>
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
