import { decryptMetaZip } from "./crypto";
import { createPendingMetaFile, createResolvedMetaFile } from "./meta-decryption";
import type { LocalDownload } from "./local-download-types";
import { openRandomAccessAgeReader } from "./random-access-age-reader";

export function pendingLocalMetadata(entry: LocalDownload) {
  return {
    ...createPendingMetaFile({
      id: entry.id,
      name: "Encrypted download.meta",
      size: String(entry.pair.payload.size),
      modifiedTime: entry.pair.modifiedTime || new Date(entry.addedAt).toISOString(),
    }),
    originalFileName: "Encrypted download",
  };
}

export async function decryptLocalMetadata(
  entry: LocalDownload, encrypted: Uint8Array, identity: string,
  readPrefix?: () => Promise<Uint8Array>, signal?: AbortSignal,
) {
  const result = await decryptMetaZip(identity, encrypted);
  const { driveFile } = pendingLocalMetadata(entry);
  let filename = result.details.name;
  if (entry.status === "complete" && readPrefix) {
    try {
      const bytes = await readPrefix();
      const total = entry.pair.payload.size;
      // Only the ciphertext header and first record are needed for a native filename.
      // Slice the bounded local probe without teaching the Drive reader a new transport.
      const reader = await openRandomAccessAgeReader({
        identity, signal, metaFileId: entry.pair.meta.id,
        source: {
          async fetch(range) {
            if (!range) throw new Error("A local header range is required.");
            const end = Math.min(range.end, total - 1);
            if (end >= bytes.length || end < range.start) throw new Error("The local filename header is out of range.");
            return new Response(bytes.slice(range.start, end + 1), {
              status: 206, headers: { "Content-Range": `bytes ${range.start}-${end}/${total}` },
            });
          },
          close() {},
        },
      });
      try {
        filename = reader.filename;
        driveFile.size = String(reader.originalSize);
      } finally { reader.close(); }
    } catch { /* A missing or damaged payload prefix must not hide readable metadata. */ }
  }
  const file = createResolvedMetaFile(driveFile, { success: true, result });
  // Only the display data and thumbnail URL are needed in the local listing.
  result.thumbnailBytes?.fill(0);
  return { ...file, originalFileName: filename, thumbnailBytes: null };
}
