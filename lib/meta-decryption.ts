import type { DriveMetaFile, MetaDetails, ProgressiveMetaFile } from "@/types";

export const DOWNLOAD_CONCURRENCY = 20;
export const DECRYPTION_STOPPED_ERROR = "Decryption stopped";

export interface WorkerDecryptResult {
  success: boolean;
  result?: {
    details: MetaDetails;
    thumbnailBytes?: Uint8Array | null;
    thumbnailFilename?: string | null;
    thumbnailMimeType?: string | null;
  };
  error?: string;
}

export function sortDriveFilesNewestFirst<T extends Pick<DriveMetaFile, "createdTime" | "modifiedTime">>(
  files: T[]
) {
  return [...files].sort((a, b) => {
    const dateA = a.createdTime
      ? new Date(a.createdTime).getTime()
      : (a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0);
    const dateB = b.createdTime
      ? new Date(b.createdTime).getTime()
      : (b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0);
    return dateB - dateA;
  });
}

export function createPendingMetaFile(file: DriveMetaFile): ProgressiveMetaFile {
  return {
    driveFile: file,
    originalFileName: file.name.replace(/\.meta$/i, ""),
    decrypted: false,
    status: "pending",
  };
}

export function createResolvedMetaFile(
  file: DriveMetaFile,
  decrypted: WorkerDecryptResult
): ProgressiveMetaFile {
  if (decrypted.success && decrypted.result) {
    let thumbnailUrl: string | null = null;
    if (decrypted.result.thumbnailBytes) {
      const blob = new Blob([decrypted.result.thumbnailBytes as unknown as BlobPart], {
        type: decrypted.result.thumbnailMimeType ?? "image/webp",
      });
      thumbnailUrl = URL.createObjectURL(blob);
    }
    return {
      driveFile: file,
      originalFileName: file.name.replace(/\.meta$/i, ""),
      decrypted: true,
      status: "decrypted",
      details: decrypted.result.details,
      thumbnailBytes: decrypted.result.thumbnailBytes ?? null,
      thumbnailFilename: decrypted.result.thumbnailFilename ?? null,
      thumbnailMimeType: decrypted.result.thumbnailMimeType ?? null,
      thumbnailUrl,
    };
  }

  return {
    driveFile: file,
    originalFileName: file.name.replace(/\.meta$/i, ""),
    decrypted: true,
    status: "error",
    decryptError: decrypted.error || "Decryption failed",
  };
}

export function replaceMetaFile(
  files: ProgressiveMetaFile[],
  fileId: string,
  nextFile: ProgressiveMetaFile
) {
  const updated = [...files];
  const pos = updated.findIndex((file) => file.driveFile.id === fileId);
  if (pos !== -1) {
    updated[pos] = nextFile;
  }
  return updated;
}

export function upsertMetaFile(
  files: ProgressiveMetaFile[],
  fileId: string,
  nextFile: ProgressiveMetaFile
) {
  const updated = [...files];
  const pos = updated.findIndex((file) => file.driveFile.id === fileId);
  if (pos !== -1) {
    updated[pos] = nextFile;
  } else {
    updated.push(nextFile);
  }
  return updated;
}

export function markUndecryptedFilesStopped(files: ProgressiveMetaFile[]) {
  return files.map((file) =>
    file.decrypted
      ? file
      : {
          ...file,
          decrypted: true,
          status: "error" as const,
          decryptError: DECRYPTION_STOPPED_ERROR,
        }
  );
}

export async function decryptWithWorker(
  worker: Worker,
  fileId: string,
  identity: string,
  encryptedData: Uint8Array,
  timeoutMs = 30000
): Promise<WorkerDecryptResult> {
  return new Promise<WorkerDecryptResult>((resolve) => {
    let resolved = false;

    const cleanup = () => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      clearTimeout(timeoutId);
    };

    const handleMessage = (e: MessageEvent) => {
      if (e.data.fileId === fileId) {
        cleanup();
        if (!resolved) {
          resolved = true;
          resolve(e.data as WorkerDecryptResult);
        }
      }
    };

    const handleError = (e: ErrorEvent) => {
      cleanup();
      if (!resolved) {
        resolved = true;
        resolve({ success: false, error: e.message || "Worker error occurred" });
      }
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      if (!resolved) {
        resolved = true;
        resolve({ success: false, error: "Decryption timeout" });
      }
    }, timeoutMs);

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage(
      {
        fileId,
        identity,
        encryptedData,
      },
      [encryptedData.buffer]
    );
  });
}
