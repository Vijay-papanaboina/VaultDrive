"use client";

import { Decrypter } from "age-encryption";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { EncryptedPreviewCache } from "@/lib/encrypted-preview-cache";

export const AGE_PLAINTEXT_RECORD_BYTES = 64 * 1024;
export const AGE_CIPHERTEXT_RECORD_BYTES = AGE_PLAINTEXT_RECORD_BYTES + 16;

const AGE_PAYLOAD_NONCE_BYTES = 16;
const HEADER_PROBE_BYTES = 64 * 1024;
const MAX_FILENAME_BYTES = 1024 * 1024;
const MAX_ENCRYPTED_RANGE_BYTES = 4 * 1024 * 1024;
const MAX_CACHED_RECORDS = 64;
const PAYLOAD_INFO = new TextEncoder().encode("payload");

type EncryptedRange = {
  bytes: Uint8Array;
  start: number;
  end: number;
  total: number;
};

export type RandomAccessAgeReader = {
  readonly filename: string;
  readonly originalSize: number;
  read(start: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  close(): void;
};

type OpenReaderOptions = {
  identity: string;
  metaFileId: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  encryptedCache?: EncryptedPreviewCache | null;
};

function asError(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback);
}

function abortError() {
  return new DOMException("Preview request was cancelled", "AbortError");
}

function assertSafeInteger(value: number, message: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(message);
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) throw new Error("Payload range response is missing a valid Content-Range header.");
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  assertSafeInteger(start, "Payload range start is invalid.");
  assertSafeInteger(end, "Payload range end is invalid.");
  assertSafeInteger(total, "Payload range size is invalid.");
  if (end < start || total === 0 || end >= total) throw new Error("Payload range response is inconsistent.");
  return { start, end, total };
}

function findAgeHeaderEnd(bytes: Uint8Array): number {
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
  throw new Error("The age header is incomplete or invalid.");
}

function nonceForRecord(record: number, isLast: boolean): Uint8Array {
  assertSafeInteger(record, "Encrypted payload is too large for age stream encryption.");
  const nonce = new Uint8Array(12);
  let remaining = record;
  for (let index = 10; index >= 0; index--) {
    nonce[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  if (remaining !== 0) throw new Error("Encrypted payload is too large for age stream encryption.");
  if (isLast) nonce[11] = 1;
  return nonce;
}

function plaintextSizeFromEncryptedPayload(ciphertextBytes: number): { plaintextSize: number; recordCount: number } {
  if (!Number.isSafeInteger(ciphertextBytes) || ciphertextBytes < 16) {
    throw new Error("Encrypted payload does not contain a complete age record.");
  }
  const completeRecords = Math.floor(ciphertextBytes / AGE_CIPHERTEXT_RECORD_BYTES);
  const finalCiphertextBytes = ciphertextBytes % AGE_CIPHERTEXT_RECORD_BYTES;
  if (finalCiphertextBytes > 0 && finalCiphertextBytes <= 16) {
    throw new Error("Encrypted payload has an invalid final age record.");
  }
  const recordCount = completeRecords + (finalCiphertextBytes ? 1 : 0);
  const plaintextSize = completeRecords * AGE_PLAINTEXT_RECORD_BYTES + Math.max(0, finalCiphertextBytes - 16);
  if (!recordCount || !Number.isSafeInteger(plaintextSize)) {
    throw new Error("Encrypted payload has an invalid age stream size.");
  }
  return { plaintextSize, recordCount };
}

class AgePayloadReader implements RandomAccessAgeReader {
  private readonly payloadOffset: number;
  private readonly plaintextSize: number;
  private readonly recordCount: number;
  private readonly payloadKey: Uint8Array;
  private readonly fetchRange: (start: number, end: number, signal?: AbortSignal) => Promise<EncryptedRange>;
  private readonly cache = new Map<number, Uint8Array>();
  private readonly pins = new Map<number, number>();
  private closed = false;

  filename: string;
  originalSize: number;

  constructor(
    filename: string,
    originalSize: number,
    payloadOffset: number,
    plaintextSize: number,
    recordCount: number,
    payloadKey: Uint8Array,
    fetchRange: (start: number, end: number, signal?: AbortSignal) => Promise<EncryptedRange>,
  ) {
    this.filename = filename;
    this.originalSize = originalSize;
    this.payloadOffset = payloadOffset;
    this.plaintextSize = plaintextSize;
    this.recordCount = recordCount;
    this.payloadKey = payloadKey;
    this.fetchRange = fetchRange;
  }

  private assertOpen(signal?: AbortSignal) {
    if (this.closed) throw new Error("Preview reader is closed.");
    if (signal?.aborted) throw abortError();
  }

  private cipherLength(record: number): number {
    if (record < 0 || record >= this.recordCount) throw new Error("Age record is outside the encrypted payload.");
    const plainLength = record === this.recordCount - 1
      ? this.plaintextSize - record * AGE_PLAINTEXT_RECORD_BYTES
      : AGE_PLAINTEXT_RECORD_BYTES;
    return plainLength + 16;
  }

  private remember(record: number, plain: Uint8Array) {
    this.cache.delete(record);
    this.cache.set(record, plain);
    this.trimCache();
  }

  private trimCache() {
    while (this.cache.size > MAX_CACHED_RECORDS) {
      let oldest: number | undefined;
      for (const candidate of this.cache.keys()) {
        if (!this.pins.has(candidate)) {
          oldest = candidate;
          break;
        }
      }
      if (oldest === undefined) break;
      const bytes = this.cache.get(oldest);
      bytes?.fill(0);
      this.cache.delete(oldest);
    }
  }

  private pinRange(first: number, last: number) {
    for (let record = first; record <= last; record++) {
      this.pins.set(record, (this.pins.get(record) || 0) + 1);
    }
  }

  private unpinRange(first: number, last: number) {
    for (let record = first; record <= last; record++) {
      const count = this.pins.get(record);
      if (count === undefined || count <= 1) this.pins.delete(record);
      else this.pins.set(record, count - 1);
    }
    this.trimCache();
  }

  private async fetchRecords(first: number, last: number, signal?: AbortSignal) {
    this.assertOpen(signal);
    const start = this.payloadOffset + first * AGE_CIPHERTEXT_RECORD_BYTES;
    let end = start - 1;
    for (let record = first; record <= last; record++) end += this.cipherLength(record);
    if (end - start + 1 > MAX_ENCRYPTED_RANGE_BYTES) throw new Error("Requested preview range exceeds the encrypted range limit.");
    const response = await this.fetchRange(start, end, signal);
    this.assertOpen(signal);
    if (response.start !== start || response.end !== end || response.bytes.byteLength !== end - start + 1) {
      throw new Error("Payload range response did not include complete age records.");
    }

    let offset = 0;
    for (let record = first; record <= last; record++) {
      const cipherLength = this.cipherLength(record);
      const cipher = response.bytes.subarray(offset, offset + cipherLength);
      let plain: Uint8Array;
      try {
        plain = chacha20poly1305(this.payloadKey, nonceForRecord(record, record === this.recordCount - 1)).decrypt(cipher);
      } catch (error) {
        throw new Error(`Encrypted payload record ${record} failed authentication: ${asError(error, "authentication failed").message}`);
      }
      if (plain.byteLength !== cipherLength - 16) throw new Error("Encrypted payload record has an unexpected plaintext length.");
      this.remember(record, plain.slice());
      offset += cipherLength;
    }
  }

  private async getRecords(first: number, last: number, signal?: AbortSignal) {
    let record = first;
    const maxRecordsPerRequest = Math.floor(MAX_ENCRYPTED_RANGE_BYTES / AGE_CIPHERTEXT_RECORD_BYTES);
    while (record <= last) {
      this.assertOpen(signal);
      if (this.cache.has(record)) {
        record++;
        continue;
      }
      const missingStart = record;
      let missingEnd = record;
      while (missingEnd + 1 <= last && missingEnd - missingStart + 1 < maxRecordsPerRequest && !this.cache.has(missingEnd + 1)) {
        missingEnd++;
      }
      await this.fetchRecords(missingStart, missingEnd, signal);
      record = missingEnd + 1;
    }
  }

  async readPayloadPrefix(length: number, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertOpen(signal);
    assertSafeInteger(length, "Payload prefix length is invalid.");
    if (length > this.plaintextSize) throw new Error("Payload prefix is outside the encrypted file.");
    if (length === 0) return new Uint8Array(0);
    const lastRecord = Math.floor((length - 1) / AGE_PLAINTEXT_RECORD_BYTES);
    await this.getRecords(0, lastRecord, signal);
    const prefix = new Uint8Array(length);
    let outputOffset = 0;
    for (let record = 0; record <= lastRecord; record++) {
      const plain = this.cache.get(record);
      if (!plain) throw new Error("Decrypted payload prefix record is unavailable.");
      const take = Math.min(plain.byteLength, length - outputOffset);
      prefix.set(plain.subarray(0, take), outputOffset);
      outputOffset += take;
    }
    return prefix;
  }

  setPayloadDetails(filename: string, originalSize: number) {
    if (!filename || !Number.isSafeInteger(originalSize) || originalSize < 0) {
      throw new Error("Decrypted payload details are invalid.");
    }
    this.filename = filename;
    this.originalSize = originalSize;
  }

  async read(start: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertOpen(signal);
    assertSafeInteger(start, "Preview byte offset is invalid.");
    assertSafeInteger(length, "Preview byte length is invalid.");
    if (start > this.originalSize || length > this.originalSize - start) {
      throw new Error("Preview byte range is outside the original file.");
    }
    if (length === 0) return new Uint8Array(0);

    const prefixLength = this.plaintextSize - this.originalSize;
    const firstPlainOffset = prefixLength + start;
    const endPlainOffset = firstPlainOffset + length;
    const firstRecord = Math.floor(firstPlainOffset / AGE_PLAINTEXT_RECORD_BYTES);
    const lastRecord = Math.floor((endPlainOffset - 1) / AGE_PLAINTEXT_RECORD_BYTES);

    const output = new Uint8Array(length);
    let outputOffset = 0;
    let plainOffset = firstPlainOffset;
    for (let batchStart = firstRecord; batchStart <= lastRecord; batchStart += MAX_CACHED_RECORDS) {
      const batchEnd = Math.min(lastRecord, batchStart + MAX_CACHED_RECORDS - 1);
      this.pinRange(batchStart, batchEnd);
      try {
        await this.getRecords(batchStart, batchEnd, signal);
        this.assertOpen(signal);
        for (let record = batchStart; record <= batchEnd; record++) {
          const current = this.cache.get(record);
          if (!current) throw new Error("Decrypted age record was unavailable for the requested preview range.");
          this.cache.delete(record);
          this.cache.set(record, current);
          const recordStart = record * AGE_PLAINTEXT_RECORD_BYTES;
          const take = Math.min(current.byteLength - (plainOffset - recordStart), length - outputOffset);
          output.set(current.subarray(plainOffset - recordStart, plainOffset - recordStart + take), outputOffset);
          plainOffset += take;
          outputOffset += take;
        }
      } finally {
        this.unpinRange(batchStart, batchEnd);
      }
    }
    return output;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.payloadKey.fill(0);
    for (const bytes of this.cache.values()) bytes.fill(0);
    this.cache.clear();
    this.pins.clear();
  }
}

export async function openRandomAccessAgeReader({ identity, metaFileId, signal, fetchImpl = fetch, encryptedCache = null }: OpenReaderOptions): Promise<RandomAccessAgeReader> {
  if (signal?.aborted) throw abortError();
  let encryptedPayloadSize: number | null = null;
  const fetchNetworkRange = async (start: number, end: number, requestSignal?: AbortSignal): Promise<EncryptedRange> => {
    let response: Response;
    try {
      response = await fetchImpl(`/api/drive/payload/${encodeURIComponent(metaFileId)}`, {
        cache: "no-store",
        headers: { Range: `bytes=${start}-${end}` },
        signal: requestSignal,
      });
    } catch (error) {
      if (requestSignal?.aborted) throw abortError();
      throw new Error(`Could not read encrypted payload range: ${asError(error, "request failed").message}`);
    }
    if (response.status !== 206) throw new Error(`Payload range request failed (HTTP ${response.status}).`);
    const range = parseContentRange(response.headers.get("Content-Range"));
    const expectedEnd = Math.min(end, range.total - 1);
    if (range.start !== start || range.end !== expectedEnd) throw new Error("Payload range response does not match the requested bytes.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== range.end - range.start + 1) throw new Error("Payload range response ended early.");
    return { bytes, ...range };
  };

  const fetchRange = async (start: number, end: number, requestSignal?: AbortSignal): Promise<EncryptedRange> => {
    assertSafeInteger(start, "Payload range start is invalid.");
    assertSafeInteger(end, "Payload range end is invalid.");
    if (end < start || end - start + 1 > MAX_ENCRYPTED_RANGE_BYTES) throw new Error("Payload range request is invalid.");
    const expectedEnd = encryptedPayloadSize === null ? end : Math.min(end, encryptedPayloadSize - 1);
    if (encryptedPayloadSize !== null) {
      const cachedSegments = await encryptedCache?.readSegments(start, expectedEnd) || [];
      if (cachedSegments.length) {
        const bytes = new Uint8Array(expectedEnd - start + 1);
        let outputOffset = 0;
        let nextMissingStart = start;
        for (const cached of cachedSegments) {
          if (cached.start > nextMissingStart) {
            const missing = await fetchNetworkRange(nextMissingStart, cached.start - 1, requestSignal);
            if (missing.total !== encryptedPayloadSize || missing.start !== nextMissingStart || missing.end !== cached.start - 1) {
              throw new Error("Payload range response does not match the missing bytes.");
            }
            bytes.set(missing.bytes, outputOffset);
            outputOffset += missing.bytes.byteLength;
            encryptedCache?.write(missing.start, missing.bytes);
          }
          bytes.set(cached.bytes, outputOffset);
          outputOffset += cached.bytes.byteLength;
          nextMissingStart = cached.end + 1;
        }
        if (nextMissingStart <= expectedEnd) {
          const missing = await fetchNetworkRange(nextMissingStart, expectedEnd, requestSignal);
          if (missing.total !== encryptedPayloadSize || missing.start !== nextMissingStart || missing.end !== expectedEnd) {
            throw new Error("Payload range response does not match the missing bytes.");
          }
          bytes.set(missing.bytes, outputOffset);
          encryptedCache?.write(missing.start, missing.bytes);
        }
        return { bytes, start, end: expectedEnd, total: encryptedPayloadSize };
      }
    }
    const range = await fetchNetworkRange(start, end, requestSignal);
    encryptedPayloadSize = range.total;
    encryptedCache?.write(range.start, range.bytes);
    return range;
  };

  const headerProbe = await fetchRange(0, HEADER_PROBE_BYTES - 1, signal);
  const headerEnd = findAgeHeaderEnd(headerProbe.bytes);
  const payloadOffset = headerEnd + AGE_PAYLOAD_NONCE_BYTES;
  if (payloadOffset >= headerProbe.total || headerEnd + AGE_PAYLOAD_NONCE_BYTES > headerProbe.bytes.byteLength) {
    throw new Error("Encrypted payload is missing its age stream nonce.");
  }
  const nonce = headerProbe.bytes.subarray(headerEnd, payloadOffset);
  const { plaintextSize, recordCount } = plaintextSizeFromEncryptedPayload(headerProbe.total - payloadOffset);

  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  let fileKey: Uint8Array | null = null;
  let reader: AgePayloadReader | null = null;
  let opened = false;
  try {
    fileKey = await decrypter.decryptHeader(headerProbe.bytes.subarray(0, headerEnd));
    const payloadKey = hkdf(sha256, fileKey, nonce, PAYLOAD_INFO, 32);
    reader = new AgePayloadReader("", 0, payloadOffset, plaintextSize, recordCount, payloadKey, fetchRange);
    const filenameHeader = await reader.readPayloadPrefix(4, signal);
    const filenameLength = new DataView(filenameHeader.buffer, filenameHeader.byteOffset, filenameHeader.byteLength).getUint32(0, false);
    if (filenameLength === 0 || filenameLength > MAX_FILENAME_BYTES) throw new Error("Decrypted payload has an invalid filename header.");
    const prefixLength = 4 + filenameLength;
    if (prefixLength > plaintextSize) throw new Error("Decrypted payload ended inside its filename header.");
    const prefix = await reader.readPayloadPrefix(prefixLength, signal);
    let filename: string;
    try {
      filename = new TextDecoder("utf-8", { fatal: true }).decode(prefix.subarray(4));
    } catch {
      throw new Error("Decrypted payload filename is not valid UTF-8.");
    }
    if (!filename) throw new Error("Decrypted payload filename is empty.");

    reader.setPayloadDetails(filename, plaintextSize - prefixLength);
    opened = true;
    return reader;
  } finally {
    fileKey?.fill(0);
    nonce.fill(0);
    if (!opened) reader?.close();
  }
}
