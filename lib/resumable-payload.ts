"use client";

import { Decrypter, Encrypter, identityToRecipient } from "age-encryption";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const AGE_PLAIN_CHUNK = 64 * 1024;
const AGE_CIPHER_CHUNK = AGE_PLAIN_CHUNK + 16;
const SOURCE_CHUNK = 1024 * 1024;

export interface ResumablePayloadContext {
  header: Uint8Array;
  nonce: Uint8Array;
  fileKey: Uint8Array;
}

export interface PayloadDescriptor {
  filename: string;
  size: number;
  lastModified: number;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function payloadHeader(filename: string): Uint8Array {
  const encoded = new TextEncoder().encode(filename);
  if (!encoded.byteLength || encoded.byteLength > 1024 * 1024) {
    throw new Error("Original filename is invalid or too long.");
  }
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, encoded.byteLength, false);
  return concat(length, encoded);
}

function ciphertextPayloadSize(plaintextSize: number): number {
  return plaintextSize + 16 * Math.max(1, Math.ceil(plaintextSize / AGE_PLAIN_CHUNK));
}

function findHeaderEnd(bytes: Uint8Array): number {
  const marker = new TextEncoder().encode("\n--- ");
  for (let index = 0; index <= bytes.byteLength - marker.byteLength; index++) {
    let matches = true;
    for (let markerIndex = 0; markerIndex < marker.byteLength; markerIndex++) {
      if (bytes[index + markerIndex] !== marker[markerIndex]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    for (let end = index + marker.byteLength; end < bytes.byteLength; end++) {
      if (bytes[end] === 10) return end + 1;
    }
  }
  throw new Error("Could not parse the generated age header.");
}

function nonceForRecord(record: number, isLast: boolean): Uint8Array {
  const nonce = new Uint8Array(12);
  if (!Number.isSafeInteger(record) || record < 0) throw new Error("File is too large for age stream encryption.");
  let remaining = record;
  for (let index = 10; index >= 0; index--) {
    nonce[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  if (remaining !== 0) throw new Error("File is too large for age stream encryption.");
  if (isLast) nonce[11] = 1;
  return nonce;
}

function streamKey(context: ResumablePayloadContext): Uint8Array {
  return hkdf(sha256, context.fileKey, context.nonce, new TextEncoder().encode("payload"), 32);
}

async function* plaintextFrom(
  file: File,
  header: Uint8Array,
  offset: number
): AsyncGenerator<Uint8Array> {
  if (offset < header.byteLength) {
    yield header.subarray(offset);
    offset = header.byteLength;
  }

  let fileOffset = offset - header.byteLength;
  while (fileOffset < file.size) {
    const end = Math.min(fileOffset + SOURCE_CHUNK, file.size);
    yield new Uint8Array(await file.slice(fileOffset, end).arrayBuffer());
    fileOffset = end;
  }
}

/**
 * Create one age v1 payload context. The public Encrypter creates the normal
 * random recipient header; decryptHeader gives us its matching file key so we
 * can later recreate the exact stream at any record boundary.
 */
export async function createResumablePayloadContext(
  identity: string
): Promise<ResumablePayloadContext> {
  const recipient = await identityToRecipient(identity);
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const seed = await encrypter.encrypt(new Uint8Array(0));
  const headerEnd = findHeaderEnd(seed);
  const header = seed.subarray(0, headerEnd);
  const nonce = seed.subarray(headerEnd, headerEnd + 16);
  if (nonce.byteLength !== 16) throw new Error("Generated age payload is incomplete.");

  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  const fileKey = await decrypter.decryptHeader(header);
  return { header: header.slice(), nonce: nonce.slice(), fileKey: fileKey.slice() };
}

export function encryptedPayloadSize(file: File, filename: string, context: ResumablePayloadContext): number {
  return context.header.byteLength + context.nonce.byteLength + ciphertextPayloadSize(
    payloadHeader(filename).byteLength + file.size
  );
}

/**
 * Rebuild a CLI-compatible age stream from any ciphertext byte offset. It only
 * reads the selected File from the needed 64 KiB age record onward.
 */
export function createResumableEncryptedPayloadStream(
  file: File,
  filename: string,
  context: ResumablePayloadContext,
  startCipherOffset = 0
): ReadableStream<Uint8Array> {
  const header = payloadHeader(filename);
  const prefix = concat(context.header, context.nonce);
  const plaintextSize = header.byteLength + file.size;
  const totalSize = prefix.byteLength + ciphertextPayloadSize(plaintextSize);
  if (startCipherOffset < 0 || startCipherOffset > totalSize) {
    throw new Error("Upload resume offset is outside the encrypted payload.");
  }

  const cipherPayloadOffset = Math.max(0, startCipherOffset - prefix.byteLength);
  const record = Math.floor(cipherPayloadOffset / AGE_CIPHER_CHUNK);
  const recordCipherOffset = cipherPayloadOffset % AGE_CIPHER_CHUNK;
  const plainOffset = record * AGE_PLAIN_CHUNK;
  const key = streamKey(context);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (startCipherOffset < prefix.byteLength) {
          controller.enqueue(prefix.subarray(startCipherOffset));
        }

        let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
        let position = plainOffset;
        let currentRecord = record;
        let skip = recordCipherOffset;

        for await (const source of plaintextFrom(file, header, plainOffset)) {
          pending = pending.byteLength ? concat(pending, source) : source;
          while (pending.byteLength >= AGE_PLAIN_CHUNK || position + pending.byteLength === plaintextSize) {
            const take = Math.min(AGE_PLAIN_CHUNK, pending.byteLength);
            if (take === 0) break;
            const plain = pending.subarray(0, take);
            pending = pending.subarray(take);
            const isLast = position + plain.byteLength === plaintextSize;
            const encrypted = chacha20poly1305(key, nonceForRecord(currentRecord, isLast)).encrypt(plain);
            if (skip < encrypted.byteLength) controller.enqueue(encrypted.subarray(skip));
            skip = 0;
            position += plain.byteLength;
            currentRecord++;
          }
        }
        if (position !== plaintextSize) throw new Error("Selected file changed while uploading.");
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function stateKey(identity: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`VaultDrive upload state v1\0${identity}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealUploadContext(identity: string, context: ResumablePayloadContext): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify({
    header: toBase64(context.header), nonce: toBase64(context.nonce), fileKey: toBase64(context.fileKey),
  }));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: asArrayBuffer(iv) }, await stateKey(identity), asArrayBuffer(data));
  return `${toBase64(iv)}.${toBase64(new Uint8Array(encrypted))}`;
}

export async function unsealUploadContext(identity: string, sealed: string): Promise<ResumablePayloadContext> {
  const [ivValue, encryptedValue] = sealed.split(".");
  if (!ivValue || !encryptedValue) throw new Error("Stored upload state is invalid.");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(fromBase64(ivValue)) },
    await stateKey(identity),
    asArrayBuffer(fromBase64(encryptedValue))
  );
  const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as Record<string, string>;
  return { header: fromBase64(parsed.header), nonce: fromBase64(parsed.nonce), fileKey: fromBase64(parsed.fileKey) };
}

export async function sealUploadState(identity: string, state: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(iv) },
    await stateKey(identity),
    asArrayBuffer(new TextEncoder().encode(JSON.stringify(state)))
  );
  return `${toBase64(iv)}.${toBase64(new Uint8Array(encrypted))}`;
}

export async function unsealUploadState<T>(identity: string, sealed: string): Promise<T> {
  const [ivValue, encryptedValue] = sealed.split(".");
  if (!ivValue || !encryptedValue) throw new Error("Stored upload state is invalid.");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(fromBase64(ivValue)) },
    await stateKey(identity),
    asArrayBuffer(fromBase64(encryptedValue))
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}
