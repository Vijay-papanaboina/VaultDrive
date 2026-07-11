"use client";

import { Decrypter } from "age-encryption";
import { unzipSync } from "fflate";
import type { MetaDetails } from "@/types";

const IMAGE_EXTS = /\.(webp|jpg|jpeg|png|gif|avif|bmp|svg)$/i;

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

export interface DecryptedZipResult {
  details: MetaDetails;
  thumbnailUrl: string | null; // null when zip contains no image
}

/**
 * Decrypt an age-encrypted zip .meta file.
 *
 * Flow:
 *  1. age decrypt (scrypt key derivation + ChaCha20-Poly1305)
 *  2. fflate unzip — zip is used as a container, not for compression
 *  3. Extract details.json → parse as MetaDetails
 *  4. Find thumbnail.* → create blob URL
 */
export async function decryptMetaZip(
  passphrase: string,
  encryptedData: Uint8Array
): Promise<DecryptedZipResult> {
  // Step 1: age decrypt
  const d = new Decrypter();
  d.addPassphrase(passphrase);
  const zipBytes = await d.decrypt(encryptedData);

  // Step 2: unzip
  const files = unzipSync(zipBytes);

  // Step 3: parse details.json
  const detailsBytes = files["details.json"];
  if (!detailsBytes) {
    throw new Error("details.json not found in meta zip");
  }
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
  let thumbnailUrl: string | null = null;
  if (thumbEntry) {
    const [thumbName, thumbBytes] = thumbEntry;
    const blob = new Blob([thumbBytes], { type: getMimeType(thumbName) });
    thumbnailUrl = URL.createObjectURL(blob);
  }

  return { details, thumbnailUrl };
}

/**
 * Validate a passphrase by attempting to decrypt a test file.
 * Returns true on success, false on wrong passphrase.
 */
export async function validatePassphrase(
  passphrase: string,
  testFileId: string
): Promise<boolean> {
  try {
    const res = await fetch(`/api/drive/meta/${testFileId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const result = await decryptMetaZip(passphrase, bytes);
    // Revoke blob URL if present — not needed for validation
    if (result.thumbnailUrl) URL.revokeObjectURL(result.thumbnailUrl);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : "";
    if (
      msg.includes("passphrase") ||
      msg.includes("decrypt") ||
      msg.includes("header") ||
      msg.includes("mac") ||
      msg.includes("invalid") ||
      msg.includes("details.json") ||
      msg.includes("thumbnail")
    ) {
      return false;
    }
    throw err;
  }
}
