"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useCrypto } from "@/hooks/use-crypto";
import { openRandomAccessAgeReader, type RandomAccessAgeReader } from "@/lib/random-access-age-reader";
import { PayloadTransportError } from "@/lib/direct-payload-source";
import {
  DEFAULT_DOWNLOAD_SETTINGS,
  DOWNLOAD_SETTINGS_STORAGE_KEY,
  isDownloadSettingValue,
  parseDownloadSettings,
  type DownloadSettings,
} from "@/lib/download-settings";
import { runParallelDownload } from "@/lib/parallel-download";

const DOWNLOAD_READ_BYTES = 3 * 1024 * 1024;

export interface FileDownloadTarget {
  metaFileId: string;
  fallbackName?: string;
  expectedSize?: number;
}

export interface BatchDownloadFailure {
  target: FileDownloadTarget;
  filename: string;
  error: string;
}

export interface BatchDownloadResult {
  total: number;
  succeeded: number;
  failed: BatchDownloadFailure[];
}

export type DownloadStage =
  | "queued"
  | "paused"
  | "resolving"
  | "downloading"
  | "streaming"
  | "finalizing"
  | "complete"
  | "failed";

export interface DownloadItem {
  metaFileId: string;
  filename: string;
  stage: DownloadStage;
  bytesWritten: number;
  expectedSize?: number;
  error?: string;
  canContinue: boolean;
  startedAt: number;
}

export interface BatchDownloadState {
  active: boolean;
  completed: number;
  total: number;
  currentFilename?: string;
}

interface WritableFileLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

interface FileHandleLike {
  createWritable(): Promise<WritableFileLike>;
}

interface DirectoryHandleLike {
  getFileHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<FileHandleLike>;
}

interface FileSystemAccessWindow extends Window {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
  }) => Promise<FileHandleLike>;
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
  }) => Promise<DirectoryHandleLike>;
}

interface FileDestination {
  open(filename: string): Promise<WritableFileLike>;
  sharedDirectory?: boolean;
}

interface DownloadJob {
  target: FileDownloadTarget;
  destination?: FileDestination;
  identity: string | null;
  generation: number;
  lifetime: AbortController;
  run?: AbortController;
  reader?: RandomAccessAgeReader;
  writer?: WritableFileLike;
  chunks: Uint8Array[];
  filename?: string;
  committedOffset: number;
  paused: boolean;
  queued: boolean;
  running: boolean;
  terminal: boolean;
  finalizing: boolean;
  runPauseRequested: boolean;
  resumeRequested: boolean;
  settled: boolean;
  failed: boolean;
  canContinue: boolean;
  startedAt: number;
  runTask?: Promise<void>;
  cleanupTask?: Promise<void>;
  completion: Promise<void>;
  resolveCompletion: () => void;
  rejectCompletion: (error: Error) => void;
}

interface FileDownloadContextValue {
  downloadItems: Record<string, DownloadItem>;
  batch: BatchDownloadState | null;
  downloadSettings: DownloadSettings;
  setDownloadSettings: (partial: Partial<DownloadSettings>) => void;
  downloadFile: (target: FileDownloadTarget) => Promise<void>;
  downloadSelected: (targets: FileDownloadTarget[]) => Promise<BatchDownloadResult>;
  pauseDownload: (metaFileId: string) => void;
  resumeDownload: (metaFileId: string) => void;
  continueDownload: (metaFileId: string) => Promise<void>;
  discardDownload: (metaFileId: string) => Promise<void>;
  restartDownload: (target: FileDownloadTarget) => Promise<void>;
  clearDownloadHistory: () => Promise<void>;
}

const FileDownloadContext = createContext<FileDownloadContextValue | null>(null);

function safeFilename(filename: string): string {
  const safe = filename
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim();
  return safe && safe !== "." && safe !== ".." ? safe : "download";
}

function triggerDownload(chunks: Uint8Array[], filename: string): string {
  const blob = new Blob(chunks as unknown as BlobPart[], {
    type: "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  return url;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortError(message = "Download cancelled") {
  return new DOMException(message, "AbortError");
}

async function chooseSingleDestination(
  suggestedName: string
): Promise<FileDestination | undefined> {
  const fileSystemWindow = window as FileSystemAccessWindow;
  if (!fileSystemWindow.showSaveFilePicker) return undefined;

  const handle = await fileSystemWindow.showSaveFilePicker({
    suggestedName: safeFilename(suggestedName),
  });
  return {
    open: () => handle.createWritable(),
  };
}

async function chooseDirectoryDestination(): Promise<FileDestination | undefined> {
  const fileSystemWindow = window as FileSystemAccessWindow;
  if (!fileSystemWindow.showDirectoryPicker) return undefined;

  const directory = await fileSystemWindow.showDirectoryPicker({ mode: "readwrite" });
  return {
    sharedDirectory: true,
    open: async (filename) => {
      const handle = await directory.getFileHandle(safeFilename(filename), {
        create: true,
      });
      return handle.createWritable();
    },
  };
}

function makeJob(
  target: FileDownloadTarget,
  identity: string | null,
  destination: FileDestination | undefined,
  generation: number,
): DownloadJob {
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);
  return {
    target,
    destination,
    identity,
    generation,
    lifetime: new AbortController(),
    chunks: [],
    committedOffset: 0,
    paused: false,
    queued: false,
    running: false,
    terminal: false,
    finalizing: false,
    runPauseRequested: false,
    resumeRequested: false,
    settled: false,
    failed: false,
    canContinue: false,
    startedAt: Date.now(),
    completion,
    resolveCompletion,
    rejectCompletion,
  };
}

function clearChunks(job: DownloadJob) {
  for (const chunk of job.chunks) chunk.fill(0);
  job.chunks = [];
}

export function FileDownloadProvider({ children }: { children: React.ReactNode }) {
  const { getPassphrase, registerSensitiveCleanup } = useCrypto();
  const [downloadItems, setDownloadItems] = useState<Record<string, DownloadItem>>({});
  const [batch, setBatch] = useState<BatchDownloadState | null>(null);
  const [downloadSettings, setDownloadSettingsState] = useState<DownloadSettings>(DEFAULT_DOWNLOAD_SETTINGS);
  const settingsRef = useRef<DownloadSettings>({ ...DEFAULT_DOWNLOAD_SETTINGS });
  const settingsLoadedRef = useRef(false);
  const jobsRef = useRef(new Map<string, DownloadJob>());
  const pendingSingleRef = useRef(new Map<string, DownloadJob>());
  const queueRef = useRef<DownloadJob[]>([]);
  const activeCountRef = useRef(0);
  const pumpRef = useRef<() => void>(() => undefined);
  const batchActiveRef = useRef(false);
  const fallbackUrlsRef = useRef(new Set<string>());
  const directoryNamesRef = useRef(new WeakMap<FileDestination, Map<string, string>>());
  const sensitiveGenerationRef = useRef(0);

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      try {
        const stored = window.localStorage.getItem(DOWNLOAD_SETTINGS_STORAGE_KEY);
        if (mounted && stored !== null) {
          const loaded = parseDownloadSettings(JSON.parse(stored));
          settingsRef.current = loaded;
          setDownloadSettingsState(loaded);
        }
      } catch {
        // Blocked or malformed preferences leave the in-memory defaults active.
      } finally {
        if (mounted) {
          settingsLoadedRef.current = true;
          pumpRef.current();
        }
      }
    });
    return () => { mounted = false; };
  }, []);

  const setDownloadSettings = useCallback((partial: Partial<DownloadSettings>) => {
    const candidate = typeof partial === "object" && partial !== null
      ? partial
      : {};
    const current = settingsRef.current;
    const next: DownloadSettings = {
      parallelDownloads: isDownloadSettingValue(candidate.parallelDownloads)
        ? candidate.parallelDownloads
        : current.parallelDownloads,
      requestsPerDownload: isDownloadSettingValue(candidate.requestsPerDownload)
        ? candidate.requestsPerDownload
        : current.requestsPerDownload,
    };
    settingsRef.current = next;
    setDownloadSettingsState(next);
    try {
      window.localStorage.setItem(DOWNLOAD_SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Preferences still apply for this provider lifetime when storage is blocked.
    }
    pumpRef.current();
  }, []);

  const updateItem = useCallback(
    (metaFileId: string, update: Partial<DownloadItem>) => {
      setDownloadItems((previous) => {
        const current = previous[metaFileId];
        if (!current) return previous;
        return { ...previous, [metaFileId]: { ...current, ...update } };
      });
    },
    []
  );

  const setJobItem = useCallback((job: DownloadJob, stage: DownloadStage) => {
    setDownloadItems((previous) => ({
      ...previous,
      [job.target.metaFileId]: {
        ...previous[job.target.metaFileId],
        metaFileId: job.target.metaFileId,
        filename: job.filename || job.target.fallbackName || job.target.metaFileId,
        stage,
        bytesWritten: job.committedOffset,
        expectedSize: job.reader?.originalSize ?? job.target.expectedSize,
        error: undefined,
        canContinue: stage === "failed" && job.canContinue,
        startedAt: job.startedAt,
      },
    }));
  }, []);

  const removeJob = useCallback((job: DownloadJob) => {
    if (jobsRef.current.get(job.target.metaFileId) === job) {
      jobsRef.current.delete(job.target.metaFileId);
    }
    queueRef.current = queueRef.current.filter((entry) => entry !== job);
    job.queued = false;
  }, []);

  const settleJob = useCallback((job: DownloadJob, error?: Error) => {
    if (job.settled) return;
    job.settled = true;
    if (error) job.rejectCompletion(error);
    else job.resolveCompletion();
  }, []);

  const finishJob = useCallback(
    async (job: DownloadJob, error?: Error) => {
      if (job.terminal) return;
      job.terminal = true;
      job.identity = null;
      job.run?.abort();
      job.lifetime.abort();
      const originalSize = job.reader?.originalSize ?? job.target.expectedSize;
      job.reader?.close();
      job.reader = undefined;
      if (error) {
        if (job.writer?.abort) await job.writer.abort(error).catch(() => undefined);
        if (sensitiveGenerationRef.current !== job.generation) return;
        removeJob(job);
        clearChunks(job);
        job.writer = undefined;
        if (sensitiveGenerationRef.current === job.generation) {
          updateItem(job.target.metaFileId, {
            stage: "failed",
            error: isAbortError(error) ? "Download cancelled" : error.message,
            canContinue: false,
          });
        }
        settleJob(job, error);
        return;
      }

      removeJob(job);
      job.writer = undefined;
      if (sensitiveGenerationRef.current === job.generation) {
        updateItem(job.target.metaFileId, {
          stage: "complete",
          bytesWritten: job.committedOffset,
          expectedSize: originalSize,
          filename: job.filename || job.target.fallbackName || job.target.metaFileId,
          canContinue: false,
        });
      }
      settleJob(job);
    },
    [removeJob, settleJob, updateItem]
  );

  const enqueueJob = useCallback(
    (job: DownloadJob) => {
      if (job.terminal || job.generation !== sensitiveGenerationRef.current) return;
      jobsRef.current.set(job.target.metaFileId, job);
      job.paused = false;
      job.queued = true;
      queueRef.current.push(job);
      setJobItem(job, "queued");
      pumpRef.current();
    },
    [setJobItem]
  );

  const reserveContinuation = useCallback((failedJob: DownloadJob): DownloadJob => {
    const id = failedJob.target.metaFileId;
    const pending = pendingSingleRef.current.get(id);
    if (pending) return pending;
    if (!failedJob.failed || !failedJob.canContinue || failedJob.terminal || failedJob.cleanupTask) return failedJob;

    const next = makeJob(failedJob.target, failedJob.identity, failedJob.destination, failedJob.generation);
    next.startedAt = failedJob.startedAt;
    pendingSingleRef.current.set(id, next);

    const transfer = async () => {
      try {
        await failedJob.runTask?.catch(() => undefined);
        if (
          failedJob.generation !== sensitiveGenerationRef.current ||
          next.terminal ||
          pendingSingleRef.current.get(id) !== next
        ) {
          throw abortError();
        }
        if (jobsRef.current.get(id) !== failedJob || failedJob.terminal || !failedJob.failed || !failedJob.canContinue) {
          throw new Error("This download can no longer continue.");
        }

        next.lifetime = failedJob.lifetime;
        next.reader = failedJob.reader;
        next.writer = failedJob.writer;
        next.chunks = failedJob.chunks;
        next.filename = failedJob.filename;
        next.committedOffset = failedJob.committedOffset;
        next.identity = failedJob.identity;

        failedJob.terminal = true;
        failedJob.identity = null;
        failedJob.lifetime = new AbortController();
        failedJob.reader = undefined;
        failedJob.writer = undefined;
        failedJob.chunks = [];
        failedJob.failed = false;
        failedJob.canContinue = false;
        removeJob(failedJob);
        pendingSingleRef.current.delete(id);
        enqueueJob(next);
      } catch (error) {
        if (pendingSingleRef.current.get(id) === next) pendingSingleRef.current.delete(id);
        next.identity = null;
        settleJob(next, error instanceof Error ? error : abortError());
      }
    };
    void transfer();
    return next;
  }, [enqueueJob, removeJob, settleJob]);

  const discardRetainedJob = useCallback(async (job: DownloadJob, generation: number) => {
    if (job.cleanupTask) return job.cleanupTask;
    const id = job.target.metaFileId;
    if (!job.failed || !job.canContinue || job.terminal) return;

    const cleanup = (async () => {
      await job.runTask?.catch(() => undefined);
      if (generation !== sensitiveGenerationRef.current) return;
      if (jobsRef.current.get(id) !== job || !job.failed || !job.canContinue) return;
      job.terminal = true;
      job.identity = null;
      job.run?.abort();
      job.lifetime.abort();
      job.reader?.close();
      job.reader = undefined;
      if (job.writer?.abort) await job.writer.abort(abortError()).catch(() => undefined);
      if (generation !== sensitiveGenerationRef.current) return;
      removeJob(job);
      clearChunks(job);
      job.writer = undefined;
      job.failed = false;
      job.canContinue = false;
    })();
    job.cleanupTask = cleanup;
    return cleanup;
  }, [removeJob]);

  const runJob = useCallback(
    async (job: DownloadJob, run: AbortController) => {
      const generation = job.generation;
      const phase: { current: "setup" | "bootstrap" | "destination" | "read" | "write" | "between" | "finalize" } = { current: "setup" };
      const ensureLifetime = () => {
        if (sensitiveGenerationRef.current !== generation || job.lifetime.signal.aborted) {
          throw abortError();
        }
      };
      const ensureRun = () => {
        ensureLifetime();
        if (run.signal.aborted) throw abortError();
      };

      try {
        ensureRun();
        if (!job.reader) {
          phase.current = "bootstrap";
          setJobItem(job, "resolving");
          if (!job.identity) throw new Error("Download identity is unavailable. Retry the download.");
          const reader = await openRandomAccessAgeReader({
            identity: job.identity,
            metaFileId: job.target.metaFileId,
            signal: job.lifetime.signal,
            requestSignal: run.signal,
          });
          if (sensitiveGenerationRef.current !== generation || job.lifetime.signal.aborted) {
            reader.close();
            throw abortError();
          }
          job.reader = reader;
          job.identity = null;
          job.filename = safeFilename(reader.filename || job.target.fallbackName || "download");
          phase.current = "between";
          ensureRun();
          setJobItem(job, "streaming");
        }

        ensureRun();
        const reader = job.reader;
        if (!reader) throw new Error("The decrypted file reader is unavailable.");
        job.filename = safeFilename(reader.filename || job.filename || job.target.fallbackName || "download");
        if (job.destination?.sharedDirectory) {
          let names = directoryNamesRef.current.get(job.destination);
          if (!names) {
            names = new Map<string, string>();
            directoryNamesRef.current.set(job.destination, names);
          }
          const reservedFor = names.get(job.filename);
          if (reservedFor && reservedFor !== job.target.metaFileId) {
            throw new Error(`Another selected file resolves to the same filename: ${job.filename}`);
          }
          names.set(job.filename, job.target.metaFileId);
        }

        if (job.destination && !job.writer) {
          phase.current = "destination";
          const writer = await job.destination.open(job.filename);
          if (sensitiveGenerationRef.current !== generation || job.lifetime.signal.aborted) {
            await writer.abort?.(abortError()).catch(() => undefined);
            throw abortError();
          }
          job.writer = writer;
          phase.current = "between";
          ensureRun();
        }

        updateItem(job.target.metaFileId, {
          stage: "streaming",
          filename: job.filename,
          expectedSize: reader.originalSize,
        });
        await runParallelDownload({
          start: job.committedOffset,
          end: reader.originalSize,
          chunkSize: DOWNLOAD_READ_BYTES,
          getConcurrency: () => settingsRef.current.requestsPerDownload,
          signal: run.signal,
          read: (offset, length, signal) => reader.read(offset, length, signal),
          write: async (bytes) => {
            if (job.writer) await job.writer.write(bytes);
            else job.chunks.push(bytes);
          },
          retainWrittenBytes: !job.writer,
          onCommit: (offset, length) => {
            ensureLifetime();
            if (job.committedOffset !== offset) {
              throw new Error("Download commit offset changed unexpectedly.");
            }
            job.committedOffset = offset + length;
            updateItem(job.target.metaFileId, {
              bytesWritten: job.committedOffset,
              expectedSize: reader.originalSize,
              filename: job.filename,
            });
          },
          onPhase: (nextPhase) => { phase.current = nextPhase; },
          assertCurrent: ensureLifetime,
        });

        ensureRun();
        job.finalizing = true;
        phase.current = "finalize";
        setJobItem(job, "finalizing");
        if (job.writer) {
          await job.writer.close();
          ensureLifetime();
          job.writer = undefined;
        } else {
          const url = triggerDownload(job.chunks, job.filename);
          fallbackUrlsRef.current.add(url);
          clearChunks(job);
          setTimeout(() => {
            if (fallbackUrlsRef.current.delete(url)) URL.revokeObjectURL(url);
          }, 1000);
        }
        await finishJob(job);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error("Download failed");
        if (
          job.runPauseRequested &&
          run.signal.aborted &&
          !job.lifetime.signal.aborted &&
          sensitiveGenerationRef.current === generation &&
          (phase.current === "bootstrap" || phase.current === "read" || phase.current === "between")
        ) {
          return;
        }
        if (
          error instanceof PayloadTransportError &&
          (phase.current === "bootstrap" || phase.current === "read") &&
          sensitiveGenerationRef.current === generation &&
          !job.terminal
        ) {
          job.failed = true;
          job.canContinue = true;
          updateItem(job.target.metaFileId, {
            stage: "failed",
            error: normalized.message,
            canContinue: true,
          });
          settleJob(job, normalized);
          return;
        }
        if (sensitiveGenerationRef.current === generation && !job.terminal) {
          await finishJob(job, normalized);
        }
      }
    },
    [finishJob, setJobItem, settleJob, updateItem]
  );

  const pumpQueue = useCallback(() => {
    if (!settingsLoadedRef.current) return;
    while (activeCountRef.current < settingsRef.current.parallelDownloads && queueRef.current.length > 0) {
      const job = queueRef.current.shift();
      if (!job || job.terminal || job.paused || job.generation !== sensitiveGenerationRef.current) continue;
      job.queued = false;
      job.running = true;
      job.runPauseRequested = false;
      job.resumeRequested = false;
      const run = new AbortController();
      job.run = run;
      activeCountRef.current += 1;
      const task = runJob(job, run).finally(() => {
        if (
          sensitiveGenerationRef.current !== job.generation ||
          job.run !== run
        ) {
          return;
        }
        job.running = false;
        job.run = undefined;
        activeCountRef.current = Math.max(0, activeCountRef.current - 1);
        if (!job.terminal && !job.failed && job.runPauseRequested) {
          if (job.resumeRequested && !job.paused) {
            job.runPauseRequested = false;
            job.resumeRequested = false;
            job.queued = true;
            queueRef.current.push(job);
            setJobItem(job, "queued");
          } else {
            job.paused = true;
            setJobItem(job, "paused");
          }
        }
        pumpRef.current();
      });
      job.runTask = task;
      void task.catch(() => undefined);
    }
  }, [runJob, setJobItem]);
  useEffect(() => {
    pumpRef.current = pumpQueue;
    if (settingsLoadedRef.current) pumpQueue();
  }, [pumpQueue]);

  const clearSensitiveState = useCallback(() => {
    sensitiveGenerationRef.current += 1;
    const cancellation = abortError();
    const allJobs = new Set([...jobsRef.current.values(), ...pendingSingleRef.current.values()]);
    for (const job of allJobs) {
      job.terminal = true;
      job.identity = null;
      job.run?.abort();
      job.lifetime.abort();
      job.reader?.close();
      job.reader = undefined;
      if (job.writer?.abort) void job.writer.abort(cancellation).catch(() => undefined);
      job.writer = undefined;
      clearChunks(job);
      settleJob(job, cancellation);
    }
    jobsRef.current.clear();
    pendingSingleRef.current.clear();
    queueRef.current = [];
    activeCountRef.current = 0;
    fallbackUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    fallbackUrlsRef.current.clear();
    batchActiveRef.current = false;
    setDownloadItems({});
    setBatch(null);
  }, [settleJob]);

  useEffect(() => registerSensitiveCleanup(clearSensitiveState), [clearSensitiveState, registerSensitiveCleanup]);
  useEffect(() => () => clearSensitiveState(), [clearSensitiveState]);

  const downloadFile = useCallback(
    (target: FileDownloadTarget): Promise<void> => {
      const pending = pendingSingleRef.current.get(target.metaFileId);
      if (pending) return pending.completion;
      const existing = jobsRef.current.get(target.metaFileId);
      if (existing) {
        if (existing.failed && existing.canContinue) return reserveContinuation(existing).completion;
        return existing.completion;
      }
      let identity: string | null;
      try {
        identity = getPassphrase();
      } catch (error) {
        return Promise.reject(error);
      }
      if (!identity) return Promise.reject(new Error("Enter your decryption passphrase first"));

      const generation = sensitiveGenerationRef.current;
      const job = makeJob(target, identity, undefined, generation);
      pendingSingleRef.current.set(target.metaFileId, job);
      let destinationRequest: Promise<FileDestination | undefined>;
      try {
        destinationRequest = chooseSingleDestination(target.fallbackName || target.metaFileId);
      } catch (error) {
        pendingSingleRef.current.delete(target.metaFileId);
        job.identity = null;
        settleJob(job, error instanceof Error ? error : new Error("Could not choose a download destination"));
        return job.completion;
      }
      void destinationRequest.then((destination) => {
        if (sensitiveGenerationRef.current !== generation || job.terminal) {
          settleJob(job, abortError());
          return;
        }
        if (pendingSingleRef.current.get(target.metaFileId) !== job) return;
        job.destination = destination;
        pendingSingleRef.current.delete(target.metaFileId);
        const alreadyQueued = jobsRef.current.get(target.metaFileId);
        if (alreadyQueued) {
          job.identity = null;
          settleJob(job, abortError("This file is already queued for download"));
          return;
        }
        enqueueJob(job);
      }).catch((error: unknown) => {
        if (pendingSingleRef.current.get(target.metaFileId) === job) {
          pendingSingleRef.current.delete(target.metaFileId);
        }
        job.identity = null;
        settleJob(job, error instanceof Error ? error : new Error("Could not choose a download destination"));
      });
      return job.completion;
    },
    [enqueueJob, getPassphrase, reserveContinuation, settleJob]
  );

  const downloadSelected = useCallback(
    async (inputTargets: FileDownloadTarget[]): Promise<BatchDownloadResult> => {
      if (batchActiveRef.current) throw new Error("A download is already in progress");
      batchActiveRef.current = true;
      const generation = sensitiveGenerationRef.current;
      const targets = Array.from(
        new Map(inputTargets.map((target) => [target.metaFileId, target])).values()
      );
      setBatch({ active: true, completed: 0, total: targets.length });

      try {
        const jobsById = new Map<string, DownloadJob>();
        const missing: FileDownloadTarget[] = [];
        for (const target of targets) {
          const pending = pendingSingleRef.current.get(target.metaFileId);
          if (pending) {
            jobsById.set(target.metaFileId, pending);
            continue;
          }
          const existing = jobsRef.current.get(target.metaFileId);
          if (existing?.failed && existing.canContinue) {
            jobsById.set(target.metaFileId, reserveContinuation(existing));
          } else if (existing) {
            jobsById.set(target.metaFileId, existing);
          } else {
            missing.push(target);
          }
        }

        const prepared: DownloadJob[] = [];
        if (missing.length) {
          const identity = getPassphrase();
          if (!identity) throw new Error("Enter your decryption passphrase first");
          for (const target of missing) {
            const job = makeJob(target, identity, undefined, generation);
            prepared.push(job);
            jobsById.set(target.metaFileId, job);
            pendingSingleRef.current.set(target.metaFileId, job);
          }

          let destination: FileDestination | undefined;
          try {
            destination = await chooseDirectoryDestination();
          } catch (error) {
            for (const job of prepared) {
              if (pendingSingleRef.current.get(job.target.metaFileId) === job) {
                pendingSingleRef.current.delete(job.target.metaFileId);
              }
              job.identity = null;
              settleJob(job, error instanceof Error ? error : new Error("Could not choose a download destination"));
            }
            throw error;
          }
          if (generation !== sensitiveGenerationRef.current) throw abortError();

          // Register every new job before the scheduler is allowed to start one.
          for (const job of prepared) {
            if (pendingSingleRef.current.get(job.target.metaFileId) !== job) continue;
            job.destination = destination;
            pendingSingleRef.current.delete(job.target.metaFileId);
            jobsRef.current.set(job.target.metaFileId, job);
            job.queued = true;
            queueRef.current.push(job);
            setJobItem(job, "queued");
          }
          pumpRef.current();
        }

        let completed = 0;
        let succeeded = 0;
        const failed: BatchDownloadFailure[] = [];
        await Promise.all(targets.map(async (target) => {
          const job = jobsById.get(target.metaFileId);
          if (!job) {
            failed.push({ target, filename: target.fallbackName || target.metaFileId, error: "Download job is unavailable" });
          } else {
            setBatch({ active: true, completed, total: targets.length, currentFilename: job.filename || target.fallbackName });
            try {
              await job.completion;
              succeeded += 1;
            } catch (error) {
              if (generation !== sensitiveGenerationRef.current) return;
              failed.push({
                target,
                filename: job.filename || target.fallbackName || target.metaFileId,
                error: error instanceof Error ? error.message : "Download failed",
              });
            }
          }
          if (generation === sensitiveGenerationRef.current) {
            completed += 1;
            setBatch({ active: true, completed, total: targets.length });
          }
        }));
        if (generation !== sensitiveGenerationRef.current) throw abortError();
        return { total: targets.length, succeeded, failed };
      } finally {
        if (generation === sensitiveGenerationRef.current) {
          batchActiveRef.current = false;
          setBatch({ active: false, completed: targets.length, total: targets.length });
        }
      }
    },
    [getPassphrase, reserveContinuation, setJobItem, settleJob]
  );

  const pauseDownload = useCallback((metaFileId: string) => {
    const job = jobsRef.current.get(metaFileId);
    if (!job || job.terminal || job.failed) return;
    if (job.queued) {
      queueRef.current = queueRef.current.filter((entry) => entry !== job);
      job.queued = false;
      job.paused = true;
      setJobItem(job, "paused");
      return;
    }
    if (job.running && !job.finalizing) {
      job.paused = true;
      job.resumeRequested = false;
      job.runPauseRequested = true;
      job.run?.abort();
      setJobItem(job, "paused");
    }
  }, [setJobItem]);

  const resumeDownload = useCallback((metaFileId: string) => {
    const job = jobsRef.current.get(metaFileId);
    if (!job || job.terminal || job.failed || !job.paused) return;
    job.paused = false;
    if (job.running) {
      job.resumeRequested = true;
      setJobItem(job, "queued");
      return;
    }
    job.queued = true;
    queueRef.current.push(job);
    setJobItem(job, "queued");
    pumpRef.current();
  }, [setJobItem]);

  const continueDownload = useCallback((metaFileId: string): Promise<void> => {
    const pending = pendingSingleRef.current.get(metaFileId);
    if (pending) return pending.completion;
    const job = jobsRef.current.get(metaFileId);
    if (!job?.failed || !job.canContinue || job.terminal) {
      return Promise.reject(new Error("This download cannot continue from its saved offset."));
    }
    if (job.cleanupTask) return Promise.reject(new Error("Download cleanup is already in progress."));
    return reserveContinuation(job).completion;
  }, [reserveContinuation]);

  const discardDownload = useCallback(async (metaFileId: string): Promise<void> => {
    if (pendingSingleRef.current.has(metaFileId)) return;
    const generation = sensitiveGenerationRef.current;
    const job = jobsRef.current.get(metaFileId);
    if (job) {
      if (!job.failed || !job.canContinue || job.running || job.queued || job.paused) return;
      await discardRetainedJob(job, generation);
      if (generation !== sensitiveGenerationRef.current || pendingSingleRef.current.has(metaFileId)) return;
    }
    setDownloadItems((previous) => {
      const item = previous[metaFileId];
      const currentJob = jobsRef.current.get(metaFileId);
      if (!item || (item.stage !== "complete" && item.stage !== "failed") || (currentJob && !currentJob.terminal)) {
        return previous;
      }
      const next = { ...previous };
      delete next[metaFileId];
      return next;
    });
  }, [discardRetainedJob]);

  const restartDownload = useCallback((target: FileDownloadTarget): Promise<void> => {
    const id = target.metaFileId;
    const pending = pendingSingleRef.current.get(id);
    if (pending) return pending.completion;
    const oldJob = jobsRef.current.get(id);
    if (oldJob && (!oldJob.failed || !oldJob.canContinue || oldJob.terminal)) {
      return Promise.reject(new Error("Pause or finish the existing download before restarting it."));
    }
    if (oldJob?.cleanupTask) return Promise.reject(new Error("Download cleanup is already in progress."));

    let identity: string | null;
    try {
      identity = getPassphrase();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!identity) return Promise.reject(new Error("Enter your decryption passphrase first"));

    const generation = sensitiveGenerationRef.current;
    const replacement = makeJob(target, identity, undefined, generation);
    pendingSingleRef.current.set(id, replacement);
    let destinationRequest: Promise<FileDestination | undefined>;
    try {
      // Invoke the picker before the first await to preserve browser user activation.
      destinationRequest = chooseSingleDestination(target.fallbackName || id);
    } catch (error) {
      pendingSingleRef.current.delete(id);
      replacement.identity = null;
      settleJob(replacement, error instanceof Error ? error : new Error("Could not choose a download destination"));
      return replacement.completion;
    }

    const launch = async () => {
      try {
        const destination = await destinationRequest;
        if (generation !== sensitiveGenerationRef.current || replacement.terminal || pendingSingleRef.current.get(id) !== replacement) {
          throw abortError();
        }
        const current = jobsRef.current.get(id);
        if (current && current !== oldJob) throw new Error("Another download replaced this failed job.");
        if (current && current.failed && current.canContinue) await discardRetainedJob(current, generation);
        if (generation !== sensitiveGenerationRef.current || replacement.terminal || pendingSingleRef.current.get(id) !== replacement) {
          throw abortError();
        }
        if (jobsRef.current.has(id)) throw new Error("The previous download could not be released safely.");
        replacement.destination = destination;
        pendingSingleRef.current.delete(id);
        enqueueJob(replacement);
      } catch (error) {
        if (pendingSingleRef.current.get(id) === replacement) pendingSingleRef.current.delete(id);
        replacement.identity = null;
        settleJob(replacement, error instanceof Error ? error : new Error("Could not restart the download"));
      }
    };
    void launch();
    return replacement.completion;
  }, [discardRetainedJob, enqueueJob, getPassphrase, settleJob]);

  const clearDownloadHistory = useCallback(async (): Promise<void> => {
    const generation = sensitiveGenerationRef.current;
    const clearable = Object.values(downloadItems).filter((item) => item.stage === "complete" || item.stage === "failed");
    for (const item of clearable) {
      if (pendingSingleRef.current.has(item.metaFileId)) continue;
      const job = jobsRef.current.get(item.metaFileId);
      if (job && (job.running || job.queued || job.paused || !job.failed || !job.canContinue)) continue;
      if (job) await discardRetainedJob(job, generation);
      if (generation !== sensitiveGenerationRef.current) return;
    }
    setDownloadItems((previous) => Object.fromEntries(
      Object.entries(previous).filter(([id, item]) => {
        if (item.stage !== "complete" && item.stage !== "failed") return true;
        if (pendingSingleRef.current.has(id)) return true;
        const job = jobsRef.current.get(id);
        return Boolean(job && !job.terminal);
      })
    ));
  }, [discardRetainedJob, downloadItems]);

  return (
    <FileDownloadContext.Provider
      value={{
        downloadItems,
        batch,
        downloadSettings,
        setDownloadSettings,
        downloadFile,
        downloadSelected,
        pauseDownload,
        resumeDownload,
        continueDownload,
        discardDownload,
        restartDownload,
        clearDownloadHistory,
      }}
    >
      {children}
    </FileDownloadContext.Provider>
  );
}

export function useFileDownload() {
  const context = useContext(FileDownloadContext);
  if (!context) {
    throw new Error("useFileDownload must be used within a FileDownloadProvider");
  }
  return context;
}
