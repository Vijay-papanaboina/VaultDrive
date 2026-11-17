"use client";

import { useState } from "react";
import { AlertCircle, FolderOpen, HardDriveDownload, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { localDownloadMessage } from "@/lib/local-download-library";

interface FolderSettingsProps {
  onClose: () => void;
  chooseDirectory: () => Promise<void>;
  allowDirectory: () => Promise<void>;
  directoryName: string | null;
  available: boolean;
  error: string | null;
}

export function LocalDownloadSettings({ onClose, chooseDirectory, allowDirectory, directoryName, available, error }: FolderSettingsProps) {
  const [busy, setBusy] = useState<"choose" | "allow" | null>(null);
  const [problem, setProblem] = useState("");
  const run = async (action: "choose" | "allow") => {
    setBusy(action);
    setProblem("");
    try { await (action === "choose" ? chooseDirectory() : allowDirectory()); }
    catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setProblem(localDownloadMessage(cause));
    } finally { setBusy(null); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="border-white/10 bg-background/95 sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><HardDriveDownload className="size-5 text-violet-300" /> Encrypted download folder</DialogTitle>
          <DialogDescription>The browser saves the original ciphertext and metadata directly to this folder. VLC is not needed.</DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-white/8 bg-white/3 p-4">
          <p className="break-all font-mono text-sm">{directoryName ?? "No folder selected"}</p>
          {directoryName && <p className={`mt-1 text-xs ${available ? "text-emerald-300" : "text-amber-300"}`}>
            {available ? "Folder access granted" : "Folder access needed"}
          </p>}
        </div>
        {(problem || error) && <p role="alert" className="flex gap-2 text-sm text-amber-200">
          <AlertCircle className="mt-0.5 size-4 shrink-0" /> {problem || error}
        </p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={!!busy}>Done</Button>
          {directoryName && !available && <Button variant="outline" onClick={() => void run("allow")} disabled={!!busy}>
            {busy === "allow" && <Loader2 className="animate-spin" />} Allow access
          </Button>}
          <Button onClick={() => void run("choose")} disabled={!!busy}>
            {busy === "choose" ? <Loader2 className="animate-spin" /> : <FolderOpen />} {directoryName ? "Change folder" : "Choose folder"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface PlaybackSetupProps {
  directoryName: string | null;
  savedCode: boolean;
  error?: string;
  onClose: () => void;
  onPlay: (code: string) => Promise<void>;
}

export function VlcPlaybackSetup({ directoryName, savedCode, error, onClose, onPlay }: PlaybackSetupProps) {
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const validCode = /^[a-f0-9]{64}$/i.test(code.trim()) || (!code.trim() && savedCode);
  const origin = typeof window === "undefined" ? "<site origin>" : window.location.origin;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="border-white/10 bg-background/95 sm:max-w-xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Play className="size-5 text-violet-300" /> Play in VLC</DialogTitle>
          <DialogDescription>Start the helper and use the code it prints. Pairing is only for playback.</DialogDescription>
        </DialogHeader>
        <code className="break-all rounded-lg border border-white/8 bg-white/3 p-3 text-xs">
          vaultdrive-vlc serve {origin}
        </code>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          if (!validCode || busy) return;
          setBusy(true);
          setProblem("");
          void onPlay(code).catch((cause) => setProblem(localDownloadMessage(cause))).finally(() => setBusy(false));
        }}>
          <label className="block space-y-1.5 text-sm">
            Pairing code
            <Input type="password" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)}
              maxLength={64} disabled={busy} placeholder={savedCode ? "Use saved code" : "64 characters from the terminal"} />
          </label>
          <p className="text-xs text-muted-foreground">
            VLC uses {directoryName ? <strong className="font-mono text-foreground">{directoryName}</strong> : "your download folder"}.
            If it cannot find that folder, select it once in the desktop picker.
          </p>
          <p className="text-xs text-muted-foreground">If your browser asks, allow loopback or local network access for this site.</p>
          {(problem || error) && <p role="alert" className="flex gap-2 text-sm text-amber-200">
            <AlertCircle className="mt-0.5 size-4 shrink-0" /> {problem || error}
          </p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !validCode}>
              {busy && <Loader2 className="animate-spin" />} Pair and play
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
