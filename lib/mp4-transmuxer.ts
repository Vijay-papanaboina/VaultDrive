import { createFile, type ISOFile, type MP4BoxBuffer } from "mp4box";

type QueuedSegment = {
  buffer: ArrayBuffer;
  sampleNumber?: number;
  initialization: boolean;
};

type TrackQueue = {
  id: number;
  sourceBuffer: SourceBuffer;
  queue: QueuedSegment[];
  active: QueuedSegment | null;
  initializationAppended: boolean;
  removeListeners(): void;
};

export type Mp4Transmuxer = {
  append(bytes: Uint8Array, fileOffset: number): number | null;
  seek(time: number): Promise<{ offset: number; time: number }>;
  finish(): Promise<void>;
  dispose(): void;
  readonly failed: Error | null;
  readonly ready: boolean;
};

function asError(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback);
}

export function createMp4Transmuxer(
  mediaSource: MediaSource,
  signal: AbortSignal,
  onPlayable: () => void,
): Mp4Transmuxer {
  if (mediaSource.readyState !== "open") throw new Error("Media source is not open");

  const file = createFile() as ISOFile<TrackQueue>;
  const tracks = new Map<number, TrackQueue>();
  let failure: Error | null = null;
  let configured = false;
  let finishing = false;
  let disposed = false;
  let playableNotified = false;
  let finishPromise: Promise<void> | null = null;
  let resolveFinish: (() => void) | null = null;
  let rejectFinish: ((error: Error) => void) | null = null;

  const finishWithError = (error: unknown, fallback: string) => {
    if (failure) return;
    failure = asError(error, fallback);
    rejectFinish?.(failure);
  };

  const isDrained = () => [...tracks.values()].every((track) => !track.active && !track.sourceBuffer.updating && track.queue.length === 0);
  const notifyPlayable = () => {
    if (playableNotified || [...tracks.values()].some((track) => !track.initializationAppended)) return;
    playableNotified = true;
    try {
      onPlayable();
    } catch (error) {
      finishWithError(error, "Preview could not start");
    }
  };
  const finishWhenDrained = () => {
    if (!finishing || failure || !configured || !isDrained()) return;
    try {
      if (mediaSource.readyState === "open") mediaSource.endOfStream();
      resolveFinish?.();
    } catch (error) {
      finishWithError(error, "Media stream could not finish");
    }
  };

  const pump = (track: TrackQueue) => {
    if (failure || disposed || track.active || track.sourceBuffer.updating) return;
    const next = track.queue.shift();
    if (!next) {
      finishWhenDrained();
      return;
    }
    track.active = next;
    try {
      track.sourceBuffer.appendBuffer(next.buffer);
    } catch (error) {
      track.active = null;
      finishWithError(error, "Media segment could not be appended");
    }
  };

  const waitForTrackIdle = (track: TrackQueue) => new Promise<void>((resolve, reject) => {
    if (!track.active && !track.sourceBuffer.updating) {
      resolve();
      return;
    }
    const cleanup = () => {
      track.sourceBuffer.removeEventListener("updateend", updated);
      track.sourceBuffer.removeEventListener("error", errored);
    };
    const updated = () => { cleanup(); resolve(); };
    const errored = () => { cleanup(); reject(new Error("The browser could not update this MP4 stream")); };
    track.sourceBuffer.addEventListener("updateend", updated, { once: true });
    track.sourceBuffer.addEventListener("error", errored, { once: true });
  });

  const clearBufferedMedia = async () => {
    for (const track of tracks.values()) {
      track.queue.length = 0;
      await waitForTrackIdle(track);
      if (!track.sourceBuffer.buffered.length) continue;
      const end = Number.isFinite(mediaSource.duration) && mediaSource.duration > 0
        ? mediaSource.duration
        : Number.MAX_SAFE_INTEGER;
      track.sourceBuffer.remove(0, end);
      await waitForTrackIdle(track);
    }
  };

  const enqueue = (track: TrackQueue, segment: QueuedSegment) => {
    if (failure || disposed) return;
    track.queue.push(segment);
    pump(track);
  };

  const addTrack = (id: number, type: string | undefined, codec: string) => {
    const mime = type === "video" ? `video/mp4; codecs="${codec}"` : `audio/mp4; codecs="${codec}"`;
    if (!MediaSource.isTypeSupported(mime)) return;
    const sourceBuffer = mediaSource.addSourceBuffer(mime);
    const track: TrackQueue = {
      id,
      sourceBuffer,
      queue: [],
      active: null,
      initializationAppended: false,
      removeListeners: () => undefined,
    };
    const updated = () => {
      const completed = track.active;
      track.active = null;
      if (completed?.initialization) {
        track.initializationAppended = true;
        notifyPlayable();
      }
      if (completed?.sampleNumber !== undefined) {
        try {
          file.releaseUsedSamples(track.id, completed.sampleNumber);
        } catch (error) {
          finishWithError(error, "Media samples could not be released");
          return;
        }
      }
      pump(track);
      finishWhenDrained();
    };
    const errored = () => finishWithError(new Error("The browser could not decode this MP4 stream"), "The browser could not decode this MP4 stream");
    sourceBuffer.addEventListener("updateend", updated);
    sourceBuffer.addEventListener("error", errored);
    track.removeListeners = () => {
      sourceBuffer.removeEventListener("updateend", updated);
      sourceBuffer.removeEventListener("error", errored);
    };
    tracks.set(id, track);
    file.setSegmentOptions(id, track, { nbSamples: 30 });
  };

  file.onError = (module, message) => finishWithError(new Error(`${module}: ${message}`), "MP4 parsing failed");
  file.onReady = (info) => {
    if (failure || disposed || configured) return;
    try {
      for (const track of info.tracks) {
        if (track.type === "video" || track.type === "audio") addTrack(track.id, track.type, track.codec);
      }
      if (!tracks.size) throw new Error("This MP4 has no browser-supported audio or video track");
      configured = true;
      mediaSource.duration = info.duration / info.timescale;
      const initializations = file.initializeSegmentation("per-track");
      for (const initialization of initializations) {
        const track = tracks.get(initialization.id);
        if (track) enqueue(track, { buffer: initialization.buffer, initialization: true });
      }
      file.start();
      finishWhenDrained();
    } catch (error) {
      finishWithError(error, "MP4 stream could not be configured");
    }
  };
  file.onSegment = (id, user, buffer, sampleNumber) => {
    enqueue(user, { buffer, sampleNumber, initialization: false });
  };

  const abort = () => finishWithError(new DOMException("Preview was closed", "AbortError"), "Preview was closed");
  signal.addEventListener("abort", abort, { once: true });

  return {
    append(bytes, fileOffset) {
      if (failure || disposed || signal.aborted) return null;
      if (!Number.isSafeInteger(fileOffset) || fileOffset < 0) {
        finishWithError(new Error("MP4 byte offset is invalid"), "MP4 parsing failed");
        return null;
      }
      const copy = bytes.slice();
      const buffer = copy.buffer as MP4BoxBuffer;
      buffer.fileStart = fileOffset;
      try {
        const nextOffset = file.appendBuffer(buffer);
        return Number.isSafeInteger(nextOffset) && nextOffset >= 0 ? nextOffset : null;
      } catch (error) {
        finishWithError(error, "MP4 parsing failed");
        return null;
      }
    },
    async seek(time) {
      if (failure) throw failure;
      if (disposed || signal.aborted) throw new DOMException("Preview was closed", "AbortError");
      if (!configured) throw new Error("MP4 metadata is not ready for seeking");
      if (!Number.isFinite(time) || time < 0) throw new Error("Requested media time is invalid");
      try {
        if (mediaSource.readyState === "ended") mediaSource.duration = mediaSource.duration;
        file.stop();
        await clearBufferedMedia();
        if (failure) throw failure;
        if (disposed || signal.aborted) throw new DOMException("Preview was closed", "AbortError");
        const position = file.seek(time, true);
        if (!Number.isSafeInteger(position.offset) || position.offset < 0 || !Number.isFinite(position.time)) {
          throw new Error("MP4Box returned an invalid seek position");
        }
        file.start();
        return position;
      } catch (error) {
        finishWithError(error, "MP4 seeking failed");
        throw failure || asError(error, "MP4 seeking failed");
      }
    },
    finish() {
      if (finishPromise) return finishPromise;
      finishPromise = new Promise<void>((resolve, reject) => {
        resolveFinish = resolve;
        rejectFinish = reject;
        if (failure) {
          reject(failure);
          return;
        }
        if (disposed) {
          reject(new DOMException("Preview was closed", "AbortError"));
          return;
        }
        finishing = true;
        try {
          file.flush();
        } catch (error) {
          finishWithError(error, "MP4 parsing failed");
          return;
        }
        if (!configured) {
          finishWithError(new Error("The MP4 header could not be read"), "The MP4 header could not be read");
          return;
        }
        finishWhenDrained();
      });
      return finishPromise;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", abort);
      for (const track of tracks.values()) {
        track.queue.length = 0;
        track.removeListeners();
      }
      tracks.clear();
      try {
        file.stop();
      } catch {
        // The parser may not have started yet.
      }
      finishWithError(new DOMException("Preview was closed", "AbortError"), "Preview was closed");
    },
    get failed() {
      return failure;
    },
    get ready() {
      return configured;
    },
  };
}
