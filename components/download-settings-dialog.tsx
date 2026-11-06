"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFileDownload } from "@/components/file-download-provider";
import {
  DEFAULT_DOWNLOAD_SETTINGS,
  DOWNLOAD_SETTINGS_MAX_VALUE,
  DOWNLOAD_SETTINGS_MIN_VALUE,
  type DownloadSettings,
} from "@/lib/download-settings";
import { SlidersHorizontal } from "lucide-react";

interface DownloadSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function DownloadSettingsDialog({ isOpen, onClose }: DownloadSettingsDialogProps) {
  const { downloadSettings, setDownloadSettings } = useFileDownload();
  const values = Array.from(
    { length: DOWNLOAD_SETTINGS_MAX_VALUE - DOWNLOAD_SETTINGS_MIN_VALUE + 1 },
    (_, index) => DOWNLOAD_SETTINGS_MIN_VALUE + index
  );

  const updateSetting = (key: keyof DownloadSettings, value: string) => {
    setDownloadSettings({ [key]: Number(value) });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent id="download-settings-dialog" className="sm:max-w-xl border-white/10 bg-background/95 backdrop-blur-xl">
        <DialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/15">
            <SlidersHorizontal className="h-5 w-5 text-violet-400" />
          </div>
          <DialogTitle className="text-foreground">Download settings</DialogTitle>
          <DialogDescription className="text-muted-foreground text-xs leading-normal">
            Adjust how many files and direct range requests can run at once.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="parallel-downloads" className="text-xs font-medium text-foreground">
              Parallel downloads
            </label>
            <select
              id="parallel-downloads"
              value={downloadSettings.parallelDownloads}
              onChange={(event) => updateSetting("parallelDownloads", event.target.value)}
              className="h-10 w-full rounded-lg border border-white/10 bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {values.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="requests-per-download" className="text-xs font-medium text-foreground">
              Requests per file (threads)
            </label>
            <select
              id="requests-per-download"
              value={downloadSettings.requestsPerDownload}
              onChange={(event) => updateSetting("requestsPerDownload", event.target.value)}
              className="h-10 w-full rounded-lg border border-white/10 bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {values.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-white/8 bg-white/3 p-3 text-xs leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">
            {downloadSettings.parallelDownloads} files × {downloadSettings.requestsPerDownload} requests = up to {downloadSettings.parallelDownloads * downloadSettings.requestsPerDownload} concurrent payload requests.
          </p>
          <p>Lower limits let in-flight work finish. New ranges use the updated limit when the read window refills. Higher counts are not guaranteed to be faster.</p>
          <p>Only these preferences are stored in browser storage. Download sessions stay in memory; reload, reopening, or vault lock ends the ability to resume. If storage is blocked, settings still apply until this page closes.</p>
        </div>

        <div className="flex justify-between gap-2 pt-1">
          <Button variant="outline" onClick={() => setDownloadSettings(DEFAULT_DOWNLOAD_SETTINGS)}>
            Reset to defaults
          </Button>
          <Button onClick={onClose}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
