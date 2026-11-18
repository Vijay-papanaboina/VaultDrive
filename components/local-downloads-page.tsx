"use client";

import { useEffect, useMemo, useState, type MouseEvent } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, ChevronLeft, ChevronRight, HardDriveDownload, Loader2, Pause, Play, RefreshCw, Settings2, Square, Trash2 } from "lucide-react";
import { useCrypto } from "@/hooks/use-crypto";
import { PassphraseGate } from "@/components/passphrase-gate";
import { MetaCard } from "@/components/meta-card";
import { useLocalDownloadActions, useLocalDownloads, type LocalTransfer } from "@/components/local-download-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { decryptLocalMetadata, pendingLocalMetadata } from "@/lib/local-library-metadata";
import { readLocalUnlockEmail } from "@/lib/local-download-library";
import { prepareOfflineDownloads } from "@/lib/offline-download-page";
import type { ProgressiveMetaFile } from "@/types";

const PAGE_SIZE = 24;
const errorText = (error: unknown) => error instanceof Error ? error.message : "Local operation failed.";
interface ConfirmAction {
  label: string;
  action: () => Promise<void>;
  title?: string;
  description?: string;
  confirmLabel?: string;
}

const stageText = {
  queued: "Queued", preparing: "Resolving Drive files", saving: "Saving ciphertext",
  verifying: "Verifying saved bytes", failed: "Download failed",
};

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  const power = Math.min(units.length, Math.floor(Math.log2(value) / 10));
  return `${(value / 1024 ** power).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[power - 1]}`;
}

function TransferRow({ transfer, onPause, onDiscard, busy }: { transfer: LocalTransfer; onPause: () => void; onDiscard: () => void; busy: boolean }) {
  const percent = transfer.total ? Math.min(100, Math.floor(transfer.bytes * 100 / transfer.total)) : 0;
  const canPause = transfer.stage !== "verifying" && transfer.stage !== "failed";
  return (
    <div className="grid gap-2 rounded-lg border border-white/8 bg-white/3 p-3 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0 space-y-1">
        <div className="truncate text-sm font-medium" title={transfer.name}>{transfer.name}</div>
        <p className="text-xs text-muted-foreground">
          {stageText[transfer.stage]}{transfer.total > 0 && ` · ${bytes(transfer.bytes)} / ${bytes(transfer.total)} · ${percent}%`}
        </p>
        {transfer.error && <p role="alert" className="text-xs text-red-300">{transfer.error}</p>}
        {(transfer.stage === "saving" || transfer.stage === "verifying") && (
          <progress aria-label={`Transfer progress for ${transfer.name}`} max={100} value={percent} className="h-1.5 w-full accent-violet-400" />
        )}
      </div>
      <div className="flex gap-2">
        {canPause && <Button variant="outline" size="sm" disabled={busy} onClick={onPause}><Pause className="size-3.5" />Pause</Button>}
        {transfer.stage !== "verifying" && <Button variant="ghost" size="sm" disabled={busy} onClick={onDiscard}>
          {transfer.stage === "failed" && !transfer.entryId ? "Dismiss" : "Discard"}
        </Button>}
      </div>
    </div>
  );
}

export function LocalDownloadsPage() {
  const { hasPassphrase, authenticatedEmail } = useCrypto();
  const { openSettings } = useLocalDownloadActions();
  const { directoryName, directoryAvailable, refresh, loading, error } = useLocalDownloads();
  const [offlineReady, setOfflineReady] = useState(false);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    let alive = true;
    void prepareOfflineDownloads().then((ready) => { if (alive) setOfflineReady(ready); }, () => undefined);
    return () => { alive = false; };
  }, []);

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-white/8 bg-background/90 backdrop-blur-xl">
        <nav aria-label="VaultDrive" className="mx-auto flex min-h-14 max-w-7xl flex-wrap items-center gap-2 px-4 py-2 sm:px-6">
          <Link href="/drive" prefetch={false} className="mr-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-muted-foreground hover:bg-white/8 hover:text-foreground">
            <ArrowLeft className="size-4" /> Drive
          </Link>
          <span aria-current="page" className="flex items-center gap-2 rounded-lg bg-violet-500/12 px-3 py-1.5 text-sm font-medium text-violet-200">
            <HardDriveDownload className="size-4" /> Downloads
          </span>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={openSettings}><Settings2 className="size-3.5" /> Settings</Button>
          </div>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 sm:py-10">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-2 text-[11px] font-medium tracking-[0.16em] text-violet-300 uppercase">Local library</p>
            <h1 className="text-3xl font-semibold tracking-tight">Encrypted Downloads</h1>
            <p className="mt-2 text-sm text-muted-foreground">Your originals stay encrypted on disk and play in VLC without Drive.</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void refresh(true)} disabled={loading}>
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /> Rescan folder
          </Button>
        </div>
        <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/8 bg-white/3 px-4 py-3 text-xs">
          <span className="flex items-center gap-2 font-medium">
            <span className={`size-2 rounded-full ${directoryAvailable ? "bg-emerald-400" : "bg-amber-400"}`} />
            {directoryAvailable ? "Folder ready" : loading ? "Reading folder" : directoryName ? "Folder access needed" : "No folder selected"}
          </span>
          {directoryName && <span className="min-w-0 break-all font-mono text-muted-foreground">{directoryName}</span>}
          {offlineReady && <span className="text-emerald-300">Page available offline</span>}
        </div>
        {error && <p role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/8 p-3 text-sm text-amber-200">
          <AlertCircle className="mt-0.5 size-4 shrink-0" /> {error}
        </p>}
        {directoryAvailable ? (
          hasPassphrase || authenticatedEmail || readLocalUnlockEmail()
            ? <PassphraseGate offlineUnlock><Library /></PassphraseGate>
            : <p className="rounded-xl border border-white/12 p-5 text-sm text-muted-foreground">Sign in to Drive and unlock once while online so this browser can derive the same vault key offline.</p>
        ) : !loading && (
          <div className="rounded-xl border border-dashed border-white/14 px-5 py-12 text-center">
            <HardDriveDownload className="mx-auto mb-4 size-8 text-violet-300" />
            <p className="font-medium">{directoryName ? "Allow access to your download folder" : "Choose where encrypted downloads are saved"}</p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">Choose a folder once in Settings. The VLC helper is only needed to play videos.</p>
            <Button className="mt-4" onClick={openSettings}>Open Settings</Button>
          </div>
        )}
      </main>
    </>
  );
}

function Library() {
  const { hasPassphrase, keyVersion, getPassphrase, registerSensitiveCleanup } = useCrypto();
  const { enqueue } = useLocalDownloadActions();
  const { entries, transfers, playingInVlc, loading, pause, discard, remove, removeMany, removeAll, readMeta, readPrefix, play, stopPlayback, rescanVersion } = useLocalDownloads();
  const [page, setPage] = useState(0);
  const [oldestFirst, setOldestFirst] = useState(true);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [resolved, setResolved] = useState<Record<string, ProgressiveMetaFile>>({});
  const [inspect, setInspect] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [working, setWorking] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [operationError, setOperationError] = useState("");
  const ordered = useMemo(() => [...entries].sort((a, b) =>
    (oldestFirst ? a.addedAt - b.addedAt : b.addedAt - a.addedAt) || a.id.localeCompare(b.id)
  ), [entries, oldestFirst]);
  const selectedEntryIds = useMemo(
    () => new Set(entries.filter((entry) => selectedIds.has(entry.id)).map((entry) => entry.id)),
    [entries, selectedIds]
  );
  const pages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = useMemo(() => ordered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE), [ordered, currentPage]);
  // One view at a time, with two metadata decryptions in flight and no persistent plaintext.
  const metaViewKey = JSON.stringify(visible.map((entry) => [entry.id, entry.metaBytes === entry.pair.meta.size, entry.status === "complete"]));
  const identity = hasPassphrase ? getPassphrase() : null;
  useEffect(() => {
    if (!identity) return;
    const controller = new AbortController();
    const urls = new Set<string>();
    const candidates = visible.filter((entry) => entry.metaBytes === entry.pair.meta.size);
    let next = 0;
    const run = async () => {
      while (!controller.signal.aborted && next < candidates.length) {
        const entry = candidates[next++];
        let detail: ProgressiveMetaFile;
        try {
          detail = await decryptLocalMetadata(entry, await readMeta(entry, controller.signal), identity,
            () => readPrefix(entry, controller.signal), controller.signal);
          if (detail.thumbnailUrl) urls.add(detail.thumbnailUrl);
        } catch {
          detail = { ...pendingLocalMetadata(entry), status: "error", decrypted: true,
            decryptError: "Could not open local metadata. Check the vault password or the saved files." };
        }
        if (controller.signal.aborted) {
          if (detail.thumbnailUrl) URL.revokeObjectURL(detail.thumbnailUrl);
          return;
        }
        setResolved((old) => ({ ...old, [entry.id]: detail }));
      }
    };
    const cleanup = () => {
      controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
    const unregister = registerSensitiveCleanup(() => {
      cleanup();
      setResolved({});
      setInspect(null);
      setConfirm(null);
      setNotice("");
      setOperationError("");
      setSelectionMode(false);
      setSelectedIds(new Set());
    });
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setResolved({});
      void run();
      void run();
    });
    return () => { cleanup(); unregister(); };
  // The content versions and metadata availability determine what must be fetched again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, keyVersion, metaViewKey, readMeta, readPrefix, rescanVersion]);

  const completed = ordered.filter((entry) => entry.status === "complete");
  const playing = async (id: string) => {
    setOpening(id);
    setOperationError("");
    setNotice("");
    try {
      const count = await play(completed.map((entry) => entry.id), id);
      if (count !== null) setNotice(`VLC opened with ${count} ${count === 1 ? "video" : "videos"} in library order.`);
    } catch (error) { setOperationError(errorText(error)); }
    finally { setOpening(null); }
  };
  const confirmAction = async () => {
    if (!confirm || working) return;
    setWorking(true);
    setOperationError("");
    try { await confirm.action(); setConfirm(null); }
    catch (error) { setOperationError(errorText(error)); }
    finally { setWorking(false); }
  };
  const requestDeleteSelected = () => {
    const ids = [...selectedEntryIds];
    if (working || ids.length === 0) return;
    const removed = new Set(ids);
    const count = ids.length;
    setConfirm({
      label: `${count} selected local ${count === 1 ? "download" : "downloads"}`,
      title: "Delete selected downloads?",
      description: "This removes the selected encrypted files from this computer only. Files in Google Drive are unchanged.",
      confirmLabel: `Delete ${count} local ${count === 1 ? "copy" : "copies"}`,
      action: async () => {
        const removedCount = await removeMany(ids);
        setSelectedIds((current) => new Set([...current].filter((id) => !removed.has(id))));
        setNotice(`Deleted ${removedCount} local ${removedCount === 1 ? "download" : "downloads"}.`);
      },
    });
  };
  const requestDeleteAll = () => {
    const entryCount = entries.length;
    const queuedCount = transferList.filter((transfer) => transfer.stage === "queued").length;
    const activeCount = transferList.filter((transfer) => transfer.stage === "preparing" || transfer.stage === "saving" || transfer.stage === "verifying").length;
    const failedCount = transferList.filter((transfer) => transfer.stage === "failed").length;
    if (working || (entryCount === 0 && transferList.length === 0)) return;
    const transferSummary = [
      queuedCount > 0 ? `${queuedCount} queued transfer${queuedCount === 1 ? "" : "s"} will be cleared.` : "",
      activeCount > 0 ? `${activeCount} active transfer${activeCount === 1 ? "" : "s"} will be paused or canceled.` : "",
      failedCount > 0 ? `${failedCount} failed transfer${failedCount === 1 ? "" : "s"} will be cleared.` : "",
    ].filter(Boolean).join(" ");
    const description = [
      `This removes all ${entryCount} local library ${entryCount === 1 ? "entry" : "entries"} from this computer only.`,
      transferSummary,
      "Google Drive files are unchanged.",
    ].filter(Boolean).join(" ");
    setConfirm({
      label: `${entryCount} local ${entryCount === 1 ? "download" : "downloads"}`,
      title: "Delete all local downloads?",
      description,
      confirmLabel: "Delete all local copies",
      action: async () => {
        const removedCount = await removeAll();
        setSelectedIds(new Set());
        setSelectionMode(false);
        setNotice(`Deleted ${removedCount} local ${removedCount === 1 ? "download" : "downloads"}.`);
      },
    });
  };
  const stopCard = (event: MouseEvent) => event.stopPropagation();
  const detail = inspect ? resolved[inspect] : null;
  const transferList = Object.values(transfers);
  if (!hasPassphrase) return null;

  return (
    <div className="space-y-6">
      {(notice || operationError) && <p role={operationError ? "alert" : "status"} className={`rounded-lg border p-3 text-sm ${operationError ? "border-red-500/25 text-red-300" : "border-emerald-500/25 text-emerald-300"}`}>
        {operationError || notice}
      </p>}
      {transferList.length > 0 && <section aria-label="Encrypted transfers" className="space-y-2">
        <h2 className="text-sm font-medium">Encrypted transfers</h2>
        {transferList.map((transfer) => <TransferRow key={transfer.metaFileId} transfer={transfer}
          busy={working}
          onPause={() => void pause(transfer.metaFileId).catch((error) => setOperationError(errorText(error)))}
          onDiscard={() => transfer.stage === "failed" && !transfer.entryId
            ? void discard(transfer.metaFileId)
            : setConfirm({ label: transfer.name, action: () => transfer.stage === "failed" && transfer.entryId
              ? remove(transfer.entryId)
              : discard(transfer.metaFileId) })}
        />)}
      </section>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 pb-3">
        <p className="text-xs text-muted-foreground">{completed.length} saved · {ordered.length - completed.length} incomplete</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={working} onClick={() => {
            if (selectionMode) {
              setSelectionMode(false);
              setSelectedIds(new Set());
            } else {
              setSelectionMode(true);
            }
          }}>{selectionMode ? "Done" : "Select"}</Button>
          {selectionMode && <>
            <Button size="sm" variant="outline" disabled={working || entries.length === 0}
              onClick={() => setSelectedIds(new Set(entries.map((entry) => entry.id)))}>Select all</Button>
            <Button size="sm" variant="outline" disabled={working || selectedEntryIds.size === 0}
              onClick={() => setSelectedIds(new Set())}>Clear selection</Button>
            <Button size="sm" variant="destructive" disabled={working || selectedEntryIds.size === 0}
              onClick={requestDeleteSelected}>Delete selected ({selectedEntryIds.size})</Button>
          </>}
          <Button size="sm" variant="destructive" disabled={working || (entries.length === 0 && transferList.length === 0)}
            onClick={requestDeleteAll}>Delete all</Button>
          {playingInVlc && <Button size="sm" variant="outline" disabled={working} onClick={() => {
            void stopPlayback().then(() => setNotice("VLC session closed."), (error) => setOperationError(errorText(error)));
          }}><Square className="size-3.5" /> Stop VLC</Button>}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Order
            <select className="h-8 rounded-md border border-white/12 bg-background px-2 text-foreground"
              value={oldestFirst ? "oldest" : "newest"} onChange={(event) => { setOldestFirst(event.target.value === "oldest"); setPage(0); }}>
              <option value="oldest">Oldest saved first</option>
              <option value="newest">Newest saved first</option>
            </select>
          </label>
        </div>
      </div>
      {visible.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((entry) => {
            const file = resolved[entry.id] ?? pendingLocalMetadata(entry);
            const managed = transferList.some((transfer) => transfer.entryId === entry.id && transfer.stage !== "failed");
            const loaded = entry.metaBytes === entry.pair.meta.size;
            const canResume = entry.status !== "complete" && !entry.remoteDeleted && !managed;
            const title = file.details?.name || "Encrypted download";
            return <MetaCard key={entry.id} meta={file} isSelectionMode={selectionMode}
              isSelected={selectedEntryIds.has(entry.id)} onClick={() => {
                if (working) return;
                if (!selectionMode) {
                  setInspect(entry.id);
                  return;
                }
                const validIds = new Set(entries.map((item) => item.id));
                setSelectedIds((current) => {
                  const next = new Set([...current].filter((id) => validIds.has(id)));
                  if (next.has(entry.id)) next.delete(entry.id);
                  else next.add(entry.id);
                  return next;
                });
              }} local={{ footer: (
              <div className="mt-auto space-y-2 border-t border-white/8 pt-2" onClick={stopCard}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}>
                <p className="text-[11px] text-muted-foreground">
                  {entry.status === "complete" ? "Stored encrypted" : `${entry.status === "downloading" ? "In progress" : entry.status === "paused" ? "Paused" : "Failed"} · ${bytes(entry.metaBytes + entry.payloadBytes)} saved`}
                  {entry.remoteDeleted && <span className="ml-1.5 text-amber-300">· Removed from Drive</span>}
                </p>
                {!loaded && entry.status !== "complete" && <p className="text-[11px] text-muted-foreground">Metadata not downloaded yet.</p>}
                {entry.error && !managed && <p className="text-[11px] text-amber-200">{entry.error}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  {entry.status === "complete" && <Button size="sm" variant="outline"
                    disabled={working || !!opening || !file.details}
                    onClick={() => void playing(entry.id)}>
                    {opening === entry.id ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Play in VLC
                  </Button>}
                  {canResume && <Button size="sm" variant="outline" disabled={working}
                    onClick={() => enqueue([{ metaFileId: entry.pair.meta.id, name: title, resume: entry }])}>Resume</Button>}
                  {!managed && <Button size="sm" variant="ghost" disabled={working} aria-label="Delete local download" title="Delete local download"
                    onClick={() => setConfirm({ label: title, action: () => remove(entry.id) })}>
                    <Trash2 className="size-3.5" />
                  </Button>}
                </div>
              </div>
            ) }} />;
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-white/14 p-10 text-center text-sm text-muted-foreground">
          {loading ? "Reading the encrypted download folder…" : "No local files yet. Use Download encrypted on a Drive card to get started."}
        </div>
      )}
      {pages > 1 && <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
        <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
          <ChevronLeft className="size-4" />
        </Button>{currentPage + 1} / {pages}
        <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>
          <ChevronRight className="size-4" />
        </Button>
      </div>}
      <Dialog open={!!detail?.details} onOpenChange={(open) => { if (!open) setInspect(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="break-all">{detail?.details?.name}</DialogTitle>
            <DialogDescription>Metadata decrypted from the local archive.</DialogDescription>
          </DialogHeader>
          {detail?.details?.description && <p className="whitespace-pre-wrap text-sm">{detail.details.description}</p>}
          {detail?.details?.date && <p className="text-xs text-muted-foreground">{detail.details.date}</p>}
          {detail?.details?.extra && <dl className="grid max-h-[44vh] grid-cols-[auto_1fr] gap-x-4 gap-y-2 overflow-auto text-xs">
            {Object.entries(detail.details.extra).map(([name, value]) => <div className="contents" key={name}>
              <dt className="break-all text-muted-foreground">{name}</dt><dd className="break-all text-right">{typeof value === "string" ? value : JSON.stringify(value)}</dd>
            </div>)}
          </dl>}
        </DialogContent>
      </Dialog>
      <Dialog open={!!confirm} onOpenChange={(open) => { if (!open && !working) setConfirm(null); }}>
        <DialogContent showCloseButton={!working} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{confirm?.title ?? "Delete local download?"}</DialogTitle>
            <DialogDescription>{confirm?.description ?? "This removes the encrypted payload and metadata from this computer only. Files in Google Drive are unchanged."}</DialogDescription>
          </DialogHeader>
          <p className="break-all text-sm">{confirm?.label}</p>
          {operationError && <p role="alert" className="text-sm text-red-300">{operationError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={working} onClick={() => setConfirm(null)}>Keep files</Button>
            <Button variant="destructive" disabled={working} onClick={() => void confirmAction()}>
              {working ? "Deleting…" : confirm?.confirmLabel ?? "Delete local copy"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
