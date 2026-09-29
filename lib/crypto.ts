"use client";

import { Decrypter, Encrypter, identityToRecipient } from "age-encryption";
import { unzipSync, zipSync, type UnzipFileInfo } from "fflate";
import { bech32 } from "@scure/base";
import type { MetaDetails } from "@/types";
import { argon2id } from "hash-wasm";

export const IMAGE_EXTS = /\.(webp|jpg|jpeg|png|gif|avif|bmp|svg)$/i;
const MAX_META_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_META_ARCHIVE_ENTRIES = 2;
const MAX_META_DETAILS_BYTES = 1024 * 1024;
const MAX_META_THUMBNAIL_BYTES = MAX_META_ARCHIVE_BYTES - MAX_META_DETAILS_BYTES;
const UNSAFE_ARCHIVE_ENTRY_NAME = /[\\/\u0000-\u001f\u007f]/;
export function inferMimeType(filename: string): string | undefined {
  const ext = filename.toLowerCase().split(".").pop() || "";
  return ({ mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", weba: "audio/webm" } as Record<string, string>)[ext];
}

function getMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    webp: "image/webp",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    avif: "image/avif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
  };
  return map[ext] ?? "image/jpeg";
}

function validateMetaArchiveEntry(
  file: UnzipFileInfo,
  seenNames: Set<string>,
  state: { entries: number; totalBytes: number; hasDetails: boolean; hasThumbnail: boolean },
) {
  const { name, size, originalSize, compression } = file;
  state.entries += 1;
  if (state.entries > MAX_META_ARCHIVE_ENTRIES) {
    throw new Error("Meta archive has too many entries");
  }
  if (!name || name === "." || name === ".." || UNSAFE_ARCHIVE_ENTRY_NAME.test(name)) {
    throw new Error("Meta archive has an unsafe entry name");
  }
  if (seenNames.has(name)) throw new Error("Meta archive contains duplicate entries");
  seenNames.add(name);
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(originalSize) || size < 0 || originalSize < 0 || size > MAX_META_ARCHIVE_BYTES) {
    throw new Error("Meta archive has invalid entry sizes");
  }
  // Current uploads use stored entries (0); accept Deflate (8) for archives
  // created by compatible older clients, but reject every other decoder.
  if (compression !== 0 && compression !== 8) {
    throw new Error("Meta archive uses an unsupported compression method");
  }
  if (compression === 0 && size !== originalSize) {
    throw new Error("Meta archive has inconsistent stored entry sizes");
  }

  const isDetails = name === "details.json";
  if (!isDetails && !IMAGE_EXTS.test(name)) {
    throw new Error("Meta archive contains an unexpected entry");
  }
  if (isDetails) {
    if (state.hasDetails || originalSize > MAX_META_DETAILS_BYTES) {
      throw new Error("Meta archive has an invalid details.json entry");
    }
    state.hasDetails = true;
  } else {
    if (state.hasThumbnail || originalSize > MAX_META_THUMBNAIL_BYTES) {
      throw new Error("Meta archive has an invalid thumbnail entry");
    }
    state.hasThumbnail = true;
  }
  state.totalBytes += originalSize;
  if (state.totalBytes > MAX_META_ARCHIVE_BYTES) {
    throw new Error("Meta archive expands beyond the allowed size");
  }
}

function unzipMetaArchive(zipBytes: Uint8Array) {
  if (zipBytes.byteLength > MAX_META_ARCHIVE_BYTES) {
    throw new Error("Meta archive exceeds the allowed size");
  }
  const seenNames = new Set<string>();
  const state = { entries: 0, totalBytes: 0, hasDetails: false, hasThumbnail: false };
  const files = unzipSync(zipBytes, {
    // fflate invokes this before allocating an entry's output buffer.
    filter: (file) => {
      validateMetaArchiveEntry(file, seenNames, state);
      return true;
    },
  });
  if (!state.hasDetails) throw new Error("details.json not found in meta zip");
  return files;
}

export interface DecryptedZipResult {
  details: MetaDetails;
  thumbnailBytes: Uint8Array | null;
  thumbnailFilename: string | null;
  thumbnailMimeType: string | null;
}

export interface MetaArchiveInput {
  details: MetaDetails;
  thumbnailBytes: Uint8Array | null;
  thumbnailFilename: string | null;
}

export interface DecryptedPayloadStreamResult {
  filename: string;
  content: ReadableStream<Uint8Array>;
}

function appendBytes(
  first: Uint8Array<ArrayBufferLike>,
  second: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(first.byteLength + second.byteLength);
  result.set(first);
  result.set(second, first.byteLength);
  return result;
}

function decodePayloadFilename(filenameBytes: Uint8Array): string {
  let filename: string;
  try {
    filename = new TextDecoder("utf-8", { fatal: true }).decode(filenameBytes);
  } catch {
    throw new Error("Decrypted payload filename is not valid UTF-8");
  }

  filename = filename
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim();

  if (!filename || filename === "." || filename === "..") {
    throw new Error("Decrypted payload has an invalid filename");
  }

  return filename;
}

/**
 * Derive deterministic X25519 identity keypair matching the browser implementation.
 */
export async function deriveAgeIdentity(passphrase: string, email: string): Promise<string> {
  const privateKeyBytes = await argon2id({
    password: passphrase,
    salt: email,
    iterations: 3,
    memorySize: 65536,
    hashLength: 32,
    parallelism: 1,
    outputType: "binary",
  });

  return bech32.encodeFromBytes("AGE-SECRET-KEY-", privateKeyBytes).toUpperCase();
}

/**
 * Decrypt an age-encrypted zip .meta file.
 *
 * Flow:
 *  1. age decrypt (X25519 identity decryption)
 *  2. fflate unzip — zip is used as a container, not for compression
 *  3. Extract details.json → parse as MetaDetails
 *  4. Find thumbnail.* → create blob URL
 */
export async function decryptMetaZip(
  identity: string,
  encryptedData: Uint8Array
): Promise<DecryptedZipResult> {
  // Step 1: age decrypt
  const d = new Decrypter();
  d.addIdentity(identity);
  const zipBytes = await d.decrypt(encryptedData);

  // Step 2: unzip
  const files = unzipMetaArchive(zipBytes);

  // Step 3: parse details.json
  const detailsBytes = files["details.json"];
  if (!detailsBytes) throw new Error("details.json not found in meta zip");
  const details: MetaDetails = JSON.parse(
    new TextDecoder().decode(detailsBytes)
  );
  if (typeof details.name !== "string") {
    throw new Error('details.json missing required "name" field');
  }

  // Step 4: find thumbnail (optional — any image file that isn't details.json)
  const thumbEntry = Object.entries(files).find(
    ([name]) => name !== "details.json" && IMAGE_EXTS.test(name)
  );
  let thumbnailBytes: Uint8Array | null = null;
  let thumbnailFilename: string | null = null;
  let thumbnailMimeType: string | null = null;
  if (thumbEntry) {
    const [thumbName, thumbBytes] = thumbEntry;
    thumbnailBytes = thumbBytes;
    thumbnailFilename = thumbName;
    thumbnailMimeType = getMimeType(thumbName);
  }

  return { details, thumbnailBytes, thumbnailFilename, thumbnailMimeType };
}

function safeArchiveFilename(filename: string): string {
  const normalized = filename
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim();
  if (!normalized || normalized === "." || normalized === ".." || !IMAGE_EXTS.test(normalized)) {
    return "thumbnail.webp";
  }
  return normalized;
}

/** Build and age-encrypt the metadata ZIP in the browser. */
export async function encryptMetaZip(
  identity: string,
  input: MetaArchiveInput
): Promise<Uint8Array> {
  const archive: Record<string, Uint8Array> = {
    "details.json": new TextEncoder().encode(JSON.stringify(input.details, null, 2)),
  };

  if (input.thumbnailBytes && input.thumbnailFilename) {
    archive[safeArchiveFilename(input.thumbnailFilename)] = input.thumbnailBytes;
  }

  const zipBytes = zipSync(archive, { level: 0 });
  const recipient = await identityToRecipient(identity);
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return encrypter.encrypt(zipBytes);
}

/**
 * Stream-decrypt a CLI payload. Only the filename header is read before the
 * returned content stream is exposed; file bytes remain chunked end-to-end.
 */
export async function decryptPayloadStream(
  identity: string,
  encryptedStream: ReadableStream<Uint8Array>
): Promise<DecryptedPayloadStreamResult> {
  const d = new Decrypter();
  d.addIdentity(identity);
  const decryptedStream = await d.decrypt(encryptedStream);
  const reader = decryptedStream.getReader();
  let pending = new Uint8Array(0);

  try {
    while (pending.byteLength < 4) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Decrypted payload is missing its filename header");
      pending = appendBytes(pending, value);
    }

    const filenameLength = new DataView(
      pending.buffer,
      pending.byteOffset,
      pending.byteLength
    ).getUint32(0, false);
    const contentStart = 4 + filenameLength;

    if (filenameLength === 0 || filenameLength > 1024 * 1024) {
      throw new Error("Decrypted payload has an invalid filename header");
    }

    while (pending.byteLength < contentStart) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Decrypted payload ended inside its filename header");
      pending = appendBytes(pending, value);
    }

    const filename = decodePayloadFilename(
      pending.subarray(4, contentStart)
    );
    let firstContentChunk = pending.subarray(contentStart);

    const content = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (firstContentChunk.byteLength > 0) {
          controller.enqueue(firstContentChunk);
          firstContentChunk = new Uint8Array(0);
          return;
        }

        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
          } else if (value && value.byteLength > 0) {
            controller.enqueue(value);
          }
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        void reader.cancel(reason);
      },
    });

    return { filename, content };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
}
