"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCrypto } from "@/hooks/use-crypto";
import { transferEncryptedDownload, type EncryptedDownloadTarget } from "@/lib/encrypted-download";
import {
  LocalDownloadBridge, LocalHelperError, randomLocalId, savedPlaybackDirectory,
  savePairingCode, savePlaybackDirectory, savedPairingCode,
} from "@/lib/local-download-bridge";
import {
  LocalDownloadLibrary, localDownloadMessage, pickEncryptedDirectory, rememberEncryptedDirectory,
  rememberLocalUnlockEmail, savedEncryptedDirectory,
} from "@/lib/local-download-library";
import type { LocalDownload } from "@/lib/local-download-types";
import { LocalDownloadSettings, VlcPlaybackSetup } from "@/components/local-download-settings";

const PARALLEL_FILES = 2;
type TransferStage = "queued" | "preparing" | "saving" | "verifying" | "failed";
export interface LocalTransfer {
  metaFileId: string;
  name: string;
  entryId?: string;
  stage: TransferStage;
  bytes: number;
  total: number;
  error?: string;
}

interface TransferJob {
  storage: LocalDownloadLibrary;
  target: EncryptedDownloadTarget;
  stop: AbortController;
  entryId?: string;
  active?: Promise<void>;
  verifying: boolean;
  generation: number;
}

interface LocalActions {
  enqueue(targets: EncryptedDownloadTarget[]): void;
  openSettings(): void;
  markRemoteDeleted(ids: string[]): void;
}

interface LocalLibrary {
  entries: LocalDownload[];
  transfers: Record<string, LocalTransfer>;
  directoryName: string | null;
  directoryAvailable: boolean;
  playingInVlc: boolean;
  error: string | null;
  loading: boolean;
  rescanVersion: number;
  refresh(rescan?: boolean): Promise<void>;
  pause(metaFileId: string): Promise<void>;
  discard(metaFileId: string): Promise<void>;
  remove(id: string): Promise<void>;
  readMeta(entry: LocalDownload, signal: AbortSignal): Promise<Uint8Array>;
  readPrefix(entry: LocalDownload, signal: AbortSignal): Promise<Uint8Array>;
  play(ids: string[], selected: string): Promise<number | null>;
  stopPlayback(): Promise<void>;
}

const LocalActionsContext = createContext<LocalActions | null>(null);
const LocalLibraryContext = createContext<LocalLibrary | null>(null);
interface PlayPrompt {
  ids: string[];
  selected: string;
  folderKey: string;
  folderName: string;
  error?: string;
}

export function LocalDownloadProvider({ children }: { children: ReactNode }) {
  const { getPassphrase, registerSensitiveCleanup, authenticatedEmail } = useCrypto();
  const storage = useRef<LocalDownloadLibrary | null>(null);
  const storedDirectory = useRef<Promise<LocalDownloadLibrary | null> | null>(null);
  const waitingForDirectory = useRef(new Map<string, EncryptedDownloadTarget>());
  const jobs = useRef(new Map<string, TransferJob>());
  const generation = useRef(0);
  const scans = useRef(0);
  const [entries, setEntries] = useState<LocalDownload[]>([]);
  const [transfers, setTransfers] = useState<Record<string, LocalTransfer>>({});
  const [directoryName, setDirectoryName] = useState<string | null>(null);
  const [directoryAvailable, setDirectoryAvailable] = useState(false);
  const [playingInVlc, setPlayingInVlc] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rescanVersion, setRescanVersion] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [playPrompt, setPlayPrompt] = useState<PlayPrompt | null>(null);
  const playback = useRef(new Map<string, LocalDownloadBridge>());

  const getStorage = useCallback(async () => {
    if (storage.current) return storage.current;
    storedDirectory.current ??= savedEncryptedDirectory().then((handle) => handle ? new LocalDownloadLibrary(handle) : null);
    const result = await storedDirectory.current.catch((error) => {
      storedDirectory.current = null;
      throw error;
    });
    storage.current ??= result;
    return storage.current;
  }, []);

  const refresh = useCallback(async (rescan = false) => {
    const scan = ++scans.current;
    setLoading(true);
    try {
      const library = await getStorage();
      if (scan !== scans.current) return;
      setDirectoryName(library?.directory.name ?? null);
      if (!library) {
        setDirectoryAvailable(false);
        setEntries([]);
        setError(null);
        return;
      }
      const access = await library.queryAccess();
      if (scan !== scans.current) return;
      if (access !== "granted") {
        setDirectoryAvailable(false);
        setEntries([]);
        setError("Allow access to the saved folder in Settings to see your downloads.");
        return;
      }
      if (authenticatedEmail) rememberLocalUnlockEmail(authenticatedEmail);
      const result = await library.list();
      if (scan === scans.current) {
        setDirectoryAvailable(true);
        setEntries(result);
        if (rescan) setRescanVersion((version) => version + 1);
        setError(null);
      }
    } catch (e) {
      if (scan === scans.current) {
        setDirectoryAvailable(false);
        setError(localDownloadMessage(e));
      }
    } finally {
      if (scan === scans.current) setLoading(false);
    }
  }, [getStorage, authenticatedEmail]);

  const update = useCallback((key: string, patch: Partial<LocalTransfer>) => {
    setTransfers((items) => items[key] ? { ...items, [key]: { ...items[key], ...patch } } : items);
  }, []);

  const clearTransfer = useCallback((key: string) => {
    setTransfers((items) => {
      if (!items[key]) return items;
      const next = { ...items };
      delete next[key];
      return next;
    });
  }, []);

  const pump = useCallback(function pumpQueue() {
    const active = Array.from(jobs.current.values()).filter((job) => job.active).length;
    const ready = Array.from(jobs.current.entries()).filter(([, job]) => !job.active).slice(0, PARALLEL_FILES - active);
    for (const [key, job] of ready) {
      function current() { return jobs.current.get(key) === job && job.generation === generation.current; }
      const apply = (patch: Partial<LocalTransfer>) => { if (current()) update(key, patch); };
      job.active = (async () => {
        try {
          apply({ stage: "preparing" });
          await transferEncryptedDownload(job.target, job.storage, {
            entry(entry) {
              job.entryId = entry.id;
              if (!current()) return;
              setEntries((old) => [entry, ...old.filter((other) => other.id !== entry.id)]);
              apply({
                stage: "saving", entryId: entry.id, bytes: entry.payloadBytes + entry.metaBytes,
                total: entry.pair.payload.size + entry.pair.meta.size,
              });
            },
            progress(entry, part, offset) {
              apply({ bytes: part === "meta" ? offset : offset + entry.pair.meta.size });
            },
            verify() { job.verifying = true; apply({ stage: "verifying" }); },
          }, job.stop.signal);
          if (current()) clearTransfer(key);
        } catch (e) {
          if (current()) {
            if (job.stop.signal.aborted && e instanceof DOMException && e.name === "AbortError") clearTransfer(key);
            else apply({ stage: "failed", error: localDownloadMessage(e) });
          }
        } finally {
          if (jobs.current.get(key) === job) jobs.current.delete(key);
          if (job.entryId || job.target.resume) void refresh();
          pumpQueue();
        }
      })();
    }
  }, [clearTransfer, refresh, update]);

  const queueReady = useCallback(async () => {
    const currentGeneration = generation.current;
    try {
      const library = await getStorage();
      const access = await library?.queryAccess();
      if (currentGeneration !== generation.current) return;
      if (!library || access !== "granted") {
        setDirectoryName(library?.directory.name ?? null);
        setDirectoryAvailable(false);
        setSettingsOpen(true);
        return;
      }
      if (authenticatedEmail) rememberLocalUnlockEmail(authenticatedEmail);
      const queued: Record<string, LocalTransfer> = {};
      for (const target of waitingForDirectory.current.values()) {
        const key = target.metaFileId;
        if (jobs.current.has(key)) continue;
        jobs.current.set(key, { storage: library, target, generation: currentGeneration, stop: new AbortController(),
          entryId: target.resume?.id, verifying: false });
        queued[key] = { metaFileId: key, entryId: target.resume?.id, name: target.name, stage: "queued", bytes: 0, total: 0 };
      }
      waitingForDirectory.current.clear();
      setTransfers((previous) => ({ ...previous, ...queued }));
      pump();
    } catch (e) {
      setError(localDownloadMessage(e));
      setSettingsOpen(true);
    }
  }, [getStorage, authenticatedEmail, pump]);

  const enqueue = useCallback((targets: EncryptedDownloadTarget[]) => {
    for (const target of targets) waitingForDirectory.current.set(target.metaFileId, target);
    void queueReady();
  }, [queueReady]);

  const pause = useCallback(async (key: string) => {
    const job = jobs.current.get(key);
    if (!job || job.verifying) return;
    job.stop.abort();
    if (job.active) await job.active;
    else {
      jobs.current.delete(key);
      clearTransfer(key);
    }
  }, [clearTransfer]);

  const discard = useCallback(async (key: string) => {
    const job = jobs.current.get(key);
    await pause(key);
    if (job && !job.verifying && job.entryId) await job.storage.remove(job.entryId);
    clearTransfer(key);
    await refresh();
  }, [pause, clearTransfer, refresh]);

  const remove = useCallback(async (id: string) => {
    const library = await getStorage();
    if (!library) return;
    await library.remove(id);
    setEntries((old) => old.filter((entry) => entry.id !== id));
    setTransfers((old) => Object.fromEntries(Object.entries(old).filter(([, transfer]) => transfer.entryId !== id)));
    await refresh();
  }, [getStorage, refresh]);

  const readMeta = useCallback(async (entry: LocalDownload, signal: AbortSignal) => {
    const library = await getStorage();
    if (!library) throw new Error("Choose the download folder first.");
    return library.meta(entry, signal);
  }, [getStorage]);

  const readPrefix = useCallback(async (entry: LocalDownload, signal: AbortSignal) => {
    const library = await getStorage();
    if (!library) throw new Error("Choose the download folder first.");
    return library.prefix(entry, signal);
  }, [getStorage]);

  const revokePlayback = useCallback(async () => {
    const outcomes = await Promise.allSettled(Array.from(playback.current, async ([id, client]) => {
      await client.stopPlayback(id);
      playback.current.delete(id);
    }));
    if (!playback.current.size) setPlayingInVlc(false);
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  }, []);

  const launch = useCallback(async (prompt: PlayPrompt, code: string) => {
    const identity = getPassphrase();
    if (!identity) throw new Error("Unlock the vault to play local videos.");
    const client = new LocalDownloadBridge(code);
    const id = randomLocalId();
    playback.current.set(id, client);
    try {
      const result = await client.play(identity, prompt.ids, prompt.selected, id, {
        directory: savedPlaybackDirectory(prompt.folderKey) || undefined,
        folderKey: prompt.folderKey,
        folderName: prompt.folderName,
      });
      if (playback.current.has(id)) {
        // The helper replaces the previous session itself; no extra request is needed.
        playback.current.clear();
        playback.current.set(id, client);
        setPlayingInVlc(true);
      }
      try {
        savePairingCode(code);
        savePlaybackDirectory(prompt.folderKey, result.directory);
      } catch { /* Playback can continue if the browser cannot save settings. */ }
      return result.count;
    } catch (e) {
      playback.current.delete(id);
      if (!(e instanceof LocalHelperError) || e.status === 408) {
        // The request may have been accepted before the reply failed.
        void client.stopPlayback(id).catch(() => undefined);
      }
      throw e;
    }
  }, [getPassphrase]);

  const play = useCallback(async (ids: string[], selected: string) => {
    const library = await getStorage();
    if (!library || !getPassphrase()) throw new Error("Unlock the vault and allow access to the download folder.");
    const folderKey = await library.folderKey();
    if (!getPassphrase()) return null;
    const prompt = { ids, selected, folderKey, folderName: library.directory.name };
    const code = savedPairingCode();
    if (!code) {
      setPlayPrompt(prompt);
      return null;
    }
    try { return await launch(prompt, code); }
    catch (error) {
      if (error instanceof LocalHelperError && error.status === 401) {
        setPlayPrompt({ ...prompt, error: error.message });
        return null;
      }
      throw error;
    }
  }, [getStorage, getPassphrase, launch]);

  useEffect(() => registerSensitiveCleanup(() => {
    generation.current += 1;
    for (const [key, job] of jobs.current) {
      if (!job.verifying) job.stop.abort();
      if (!job.active) jobs.current.delete(key);
    }
    waitingForDirectory.current.clear();
    setTransfers({});
    setPlayPrompt(null);
    void revokePlayback().catch(() => setPlayingInVlc(false));
  }), [registerSensitiveCleanup, revokePlayback]);

  const pairAndPlay = async (code: string) => {
    const prompt = playPrompt;
    if (!prompt) return;
    const key = code.trim().toLowerCase() || savedPairingCode();
    if (!key) throw new Error("Enter the code printed by the VLC helper.");
    await launch(prompt, key);
    setPlayPrompt(null);
  };

  const chooseDirectory = async () => {
    if (jobs.current.size) throw new Error("Pause encrypted downloads before changing the folder.");
    const directory = await pickEncryptedDirectory(storage.current?.directory);
    await rememberEncryptedDirectory(directory);
    storage.current = new LocalDownloadLibrary(directory);
    storedDirectory.current = null;
    setEntries([]);
    await refresh(true);
    await queueReady();
  };

  const allowDirectory = async () => {
    const library = storage.current;
    if (!library) throw new Error("Choose a folder first.");
    if (await library.requestAccess() !== "granted") throw new Error("Folder access was not granted.");
    await refresh(true);
    await queueReady();
  };

  const actions = useMemo<LocalActions>(() => ({
    enqueue,
    openSettings: () => {
      setSettingsOpen(true);
      void refresh();
    },
    markRemoteDeleted(ids) {
      void getStorage().then(async (library) => {
        if (!library || await library.queryAccess() !== "granted") return;
        await library.markRemoteDeleted(ids);
        await refresh();
      }).catch(() => undefined);
    },
  }), [enqueue, getStorage, refresh]);

  return (
    <LocalActionsContext.Provider value={actions}>
      <LocalLibraryContext.Provider value={{ entries, transfers, directoryName, directoryAvailable, playingInVlc, error, loading, rescanVersion,
        refresh, pause, discard, remove, readMeta, readPrefix, play, stopPlayback: revokePlayback }}>
        {children}
        {settingsOpen && <LocalDownloadSettings
          onClose={() => { waitingForDirectory.current.clear(); setSettingsOpen(false); }}
          chooseDirectory={chooseDirectory} allowDirectory={allowDirectory}
          directoryName={directoryName} available={directoryAvailable} error={error}
        />}
        {playPrompt && <VlcPlaybackSetup
          onClose={() => setPlayPrompt(null)} onPlay={pairAndPlay} directoryName={directoryName}
          savedCode={!!savedPairingCode()} error={playPrompt.error}
        />}
      </LocalLibraryContext.Provider>
    </LocalActionsContext.Provider>
  );
}

export function useLocalDownloadActions() {
  const value = useContext(LocalActionsContext);
  if (!value) throw new Error("Local download actions require their provider.");
  return value;
}

export function useLocalDownloads() {
  const value = useContext(LocalLibraryContext);
  if (!value) throw new Error("The local download library requires its provider.");
  return value;
}
