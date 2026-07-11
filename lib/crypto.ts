"use client";

import { Decrypter } from "age-encryption";
import type { MetaFileContent } from "@/types";

/**
 * Decrypt an age-encrypted .meta file using a passphrase.
 *
 * The age-encryption library handles the entire age format:
 *  - Parses the age header (version line + scrypt recipient stanza)
 *  - Derives the key using scrypt (parameters read from the header)
 *  - Decrypts the payload using ChaCha20-Poly1305
 *  - Verifies the authentication tag
 *
 * Throws if the passphrase is wrong or the data is corrupt.
 */
export async function decryptMetaFile(
  passphrase: string,
  encryptedData: Uint8Array
): Promise<MetaFileContent> {
  const d = new Decrypter();
  d.addPassphrase(passphrase);

  // decrypt() returns plaintext as string when second arg is "text"
  const plaintext = await d.decrypt(encryptedData, "text");

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("Decrypted content is not valid JSON");
  }

  // Basic shape validation
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Unexpected decrypted format");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== "string") {
    throw new Error('Missing required field "name" in meta content');
  }
  if (typeof obj.thumbnail !== "string") {
    throw new Error('Missing required field "thumbnail" in meta content');
  }

  return parsed as MetaFileContent;
}

/**
 * Validate passphrase by attempting to decrypt the first file in a list.
 * Returns true on success, false on wrong passphrase, throws on other errors.
 */
export async function validatePassphrase(
  passphrase: string,
  testFileId: string
): Promise<boolean> {
  try {
    const res = await fetch(`/api/drive/meta/${testFileId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await decryptMetaFile(passphrase, bytes);
    return true;
  } catch (err) {
    // age-encryption throws a generic Error with message like "incorrect passphrase"
    const msg = err instanceof Error ? err.message.toLowerCase() : "";
    if (
      msg.includes("passphrase") ||
      msg.includes("decrypt") ||
      msg.includes("header") ||
      msg.includes("mac") ||
      msg.includes("invalid")
    ) {
      return false;
    }
    throw err; // re-throw unexpected errors (network, JSON parse, etc.)
  }
}
