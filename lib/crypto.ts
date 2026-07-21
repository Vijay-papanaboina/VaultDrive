"use client";

import { Decrypter } from "age-encryption";
import { unzipSync } from "fflate";
import { bech32 } from "@scure/base";
import type { MetaDetails } from "@/types";
import { argon2id } from "hash-wasm";

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
  thumbnailBytes: Uint8Array | null;
  thumbnailMimeType: string | null;
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
  let thumbnailBytes: Uint8Array | null = null;
  let thumbnailMimeType: string | null = null;
  if (thumbEntry) {
    const [thumbName, thumbBytes] = thumbEntry;
    thumbnailBytes = thumbBytes;
    thumbnailMimeType = getMimeType(thumbName);
  }

  return { details, thumbnailBytes, thumbnailMimeType };
}

