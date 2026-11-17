export interface EncryptedFileVersion {
  id: string;
  revision: string;
  size: number;
  checksum: string;
}

export interface EncryptedDownloadPair {
  meta: EncryptedFileVersion;
  payload: EncryptedFileVersion;
  modifiedTime: string;
}

export type LocalDownloadStatus = "downloading" | "paused" | "failed" | "complete";

export interface LocalDownload {
  id: string;
  pair: EncryptedDownloadPair;
  addedAt: number;
  status: LocalDownloadStatus;
  error: string | null;
  remoteDeleted: boolean;
  metaBytes: number;
  payloadBytes: number;
}

const DRIVE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const CHECKSUM = /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/;

function isVersion(value: unknown): value is EncryptedFileVersion {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<EncryptedFileVersion>;
  return typeof file.id === "string" && DRIVE_ID.test(file.id) &&
    typeof file.revision === "string" && DRIVE_ID.test(file.revision) &&
    typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size > 0 &&
    typeof file.checksum === "string" && CHECKSUM.test(file.checksum);
}

export function isEncryptedDownloadPair(value: unknown): value is EncryptedDownloadPair {
  if (!value || typeof value !== "object") return false;
  const pair = value as Partial<EncryptedDownloadPair>;
  return isVersion(pair.meta) && isVersion(pair.payload) && pair.meta.id !== pair.payload.id &&
    pair.meta.size <= 25 * 1024 * 1024 &&
    typeof pair.modifiedTime === "string" && pair.modifiedTime.length <= 64;
}

export function sameEncryptedDownloadPair(a: EncryptedDownloadPair, b: EncryptedDownloadPair): boolean {
  const same = (left: EncryptedFileVersion, right: EncryptedFileVersion) =>
    left.id === right.id && left.revision === right.revision &&
    left.size === right.size && left.checksum === right.checksum;
  return same(a.meta, b.meta) && same(a.payload, b.payload);
}

export type LocalDownloadPart = "meta" | "payload";
