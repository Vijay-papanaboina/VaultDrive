import type { DriveFolder, DriveMetaFile, BreadcrumbItem, DriveListResponse } from "@/types";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

export class DriveApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "DriveApiError";
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const VAULTDRIVE_META_NAME = /^([0-9]+)\.meta$/;
const VAULTDRIVE_PAYLOAD_NAME = /^([0-9]+)\.uploading$/;
const VAULTDRIVE_OPAQUE_ID = /^\d{1,32}$/;
const VAULTDRIVE_UPLOAD_STATE_PROPERTY = "vaultdriveUploadState";
const VAULTDRIVE_META_ID_PROPERTY = "vaultdriveMetaFileId";
const VAULTDRIVE_PAYLOAD_ID_PROPERTY = "vaultdrivePayloadFileId";
const VAULTDRIVE_UPLOAD_CLAIM_PROPERTY = "vaultdriveUploadClaim";
const VAULTDRIVE_EXPECTED_PAYLOAD_SIZE_PROPERTY = "vaultdriveExpectedPayloadSize";
const VAULTDRIVE_EXPECTED_META_SIZE_PROPERTY = "vaultdriveExpectedMetaSize";
const VAULTDRIVE_UPLOADING_META = "uploading-meta";
const VAULTDRIVE_AWAITING_PAYLOAD = "awaiting-payload";
const VAULTDRIVE_CREATING_PAYLOAD = "creating-payload";
const VAULTDRIVE_PENDING = "pending";
const VAULTDRIVE_COMPLETED = "completed";
const MAX_META_BYTES = 25 * 1024 * 1024;
const activePayloadSessionCreations = new Map<string, Map<string, Promise<PayloadUploadSession>>>();

async function driveGet(
  accessToken: string,
  path: string,
  params: Record<string, string> = {},
  requestHeaders: Record<string, string> = {},
  signal?: AbortSignal
): Promise<Response> {
  const url = new URL(`${DRIVE_API}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { ...authHeaders(accessToken), ...requestHeaders },
    // Next.js: don't cache Drive responses by default
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new DriveApiError(`Drive API error ${res.status}: ${body}`, res.status);
  }
  return res;
}

// ── paginated list helper ─────────────────────────────────────────────────────

async function listAll(
  accessToken: string,
  q: string,
  fields: string,
  signal?: AbortSignal,
  supportsAllDrives = false
): Promise<DriveListResponse["files"]> {
  const all: DriveListResponse["files"] = [];
  let pageToken: string | undefined;

  do {
    const params: Record<string, string> = {
      q,
      fields: `nextPageToken,files(${fields})`,
      pageSize: "1000",
      orderBy: "name",
    };
    if (supportsAllDrives) {
      params.supportsAllDrives = "true";
      params.includeItemsFromAllDrives = "true";
    }
    if (pageToken) params.pageToken = pageToken;

    const res = await driveGet(accessToken, "/files", params, {}, signal);
    const data: DriveListResponse = await res.json();
    all.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return all;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * List subfolders inside a given parent.
 * Pass parentId = "root" for the user's Drive root.
 */
export async function listFolders(
  accessToken: string,
  parentId: string = "root"
): Promise<DriveFolder[]> {
  const q = `'${escapeDriveQueryValue(parentId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const files = await listAll(accessToken, q, "id,name,modifiedTime,parents");
  return files as DriveFolder[];
}

/**
 * List all .meta files inside a given folder.
 */
export async function listMetaFiles(
  accessToken: string,
  folderId: string
): Promise<DriveMetaFile[]> {
  const q = `'${escapeDriveQueryValue(folderId)}' in parents and fileExtension = 'meta' and trashed = false`;
  const files = await listAll(accessToken, q, "id,name,size,modifiedTime,createdTime,appProperties") as Array<DriveMetaFile & {
    appProperties?: Record<string, string>;
  }>;
  return files
    .filter((file) => file.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY] !== VAULTDRIVE_UPLOADING_META)
    .map((file) => {
      delete file.appProperties;
      return file;
    });
}

function parseMetaByteLength(
  size: string | null | undefined,
  source: "metadata" | "content length"
): number {
  if (!size || !/^\d+$/.test(size)) {
    throw new DriveApiError(`Drive did not provide a valid metadata ${source}`, 502);
  }
  const byteLength = Number(size);
  if (!Number.isSafeInteger(byteLength) || byteLength > MAX_META_BYTES) {
    throw new DriveApiError("Encrypted metadata is too large", 413);
  }
  return byteLength;
}

/**
 * Return an encrypted .meta file as a bounded stream. Metadata is checked
 * before content is requested, and the stream count protects unknown or
 * incorrect upstream content lengths without buffering the file in memory.
 */
export async function getMetaFileStream(
  accessToken: string,
  fileId: string
): Promise<Response> {
  const fileRes = await driveGet(
    accessToken,
    `/files/${encodeURIComponent(fileId)}`,
    { fields: "id,name,size" }
  );
  const file = await fileRes.json() as { name?: string; size?: string };
  if (!file.name || !/\.meta$/i.test(file.name)) {
    throw new DriveApiError("The requested file is not a metadata file", 400);
  }
  const expectedByteLength = parseMetaByteLength(file.size, "metadata");

  const contentRes = await driveGet(
    accessToken,
    `/files/${encodeURIComponent(fileId)}`,
    { alt: "media" }
  );
  // Drive can legitimately send this response chunked, without a
  // Content-Length header. When it is present, use it as an early consistency
  // check; the bounded stream below remains the authoritative verification.
  const contentLength = contentRes.headers.get("content-length");
  if (contentLength !== null) {
    const contentByteLength = parseMetaByteLength(contentLength, "content length");
    if (contentByteLength !== expectedByteLength) {
      throw new DriveApiError("Drive metadata size changed during download", 502);
    }
  }
  if (!contentRes.body) {
    throw new DriveApiError("Drive returned an empty metadata response", 502);
  }

  let streamedBytes = 0;
  const boundedBody = contentRes.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      streamedBytes += chunk.byteLength;
      if (streamedBytes > expectedByteLength) {
        controller.error(new DriveApiError("Drive metadata size changed during download", 502));
        return;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (streamedBytes !== expectedByteLength) {
        controller.error(new DriveApiError("Drive metadata response ended early", 502));
      }
    },
  }));

  return new Response(boundedBody, { headers: contentRes.headers });
}

/**
 * Replace only the binary content of an existing Drive file. Drive metadata
 * such as its name and parents is intentionally not sent in this request.
 */
export async function updateFileContent(
  accessToken: string,
  fileId: string,
  content: Uint8Array,
  expectedModifiedTime?: string
): Promise<DriveMetaFile> {
  const currentRes = await driveGet(
    accessToken,
    `/files/${encodeURIComponent(fileId)}`,
    { fields: "id,name,size,modifiedTime,createdTime" }
  );
  const current = (await currentRes.json()) as DriveMetaFile;

  if (!/\.meta$/i.test(current.name)) {
    throw new DriveApiError("The requested file is not a metadata file", 400);
  }

  if (
    expectedModifiedTime &&
    current.modifiedTime &&
    current.modifiedTime !== expectedModifiedTime
  ) {
    throw new DriveApiError(
      "This metadata file changed in Drive while it was being edited",
      409
    );
  }

  const url = new URL(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("fields", "id,name,size,modifiedTime,createdTime");

  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      ...authHeaders(accessToken),
      "Content-Type": "application/octet-stream",
      "Content-Length": String(content.byteLength),
    },
    body: content.buffer as ArrayBuffer,
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new DriveApiError(
      `Drive content update failed (${response.status}): ${body}`,
      response.status
    );
  }

  return (await response.json()) as DriveMetaFile;
}

function driveUploadUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(`${DRIVE_UPLOAD_API}${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function randomOpaqueNumericId(): string {
  // Keep the CLI's numeric-looking pairing convention without leaking a real name.
  const bytes = crypto.getRandomValues(new Uint32Array(2));
  const high = 1000000 + (bytes[0] % 9000000);
  const low = String(bytes[1] % 100000000).padStart(8, "0");
  return `${high}${low}`;
}

async function createDriveFile(
  accessToken: string,
  metadata: Record<string, unknown>
): Promise<{ id: string; name: string; parents?: string[] }> {
  const response = await fetch(`${DRIVE_API}/files?fields=id,name,parents`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new DriveApiError(`Drive file creation failed (${response.status}): ${await response.text()}`, response.status);
  }
  return response.json();
}

async function updateDriveFileAppProperties(
  accessToken: string,
  fileId: string,
  appProperties: Record<string, string>
): Promise<void> {
  const response = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
    method: "PATCH",
    headers: {
      ...authHeaders(accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ appProperties }),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new DriveApiError(`Drive upload state update failed (${response.status}): ${await response.text()}`, response.status);
  }
}

async function deleteDriveFile(accessToken: string, fileId: string): Promise<void> {
  const response = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
    cache: "no-store",
  });
  if (!response.ok && response.status !== 404) {
    throw new DriveApiError(`Drive upload cleanup failed (${response.status})`, response.status);
  }
}

export interface CreatedUploadMetaSession {
  metaFile: { id: string };
  opaqueId: string;
  sessionUrl: string;
}

function isValidMetaUploadSessionUrl(value: string, fileId: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const uploadTypes = url.searchParams.getAll("uploadType");
  const uploadIds = url.searchParams.getAll("upload_id");
  return url.protocol === "https:" &&
    url.hostname === "www.googleapis.com" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    url.pathname === `/upload/drive/v3/files/${encodeURIComponent(fileId)}` &&
    uploadTypes.length === 1 &&
    uploadTypes[0] === "resumable" &&
    uploadIds.length === 1 &&
    /^[A-Za-z0-9_-]+$/.test(uploadIds[0]);
}

/** Allocate an opaque .meta sidecar and its direct resumable upload session. */
export async function createMetaUploadSession(
  accessToken: string,
  folderId: string,
  encryptedMetaSize: number,
  requestedOpaqueId?: string
): Promise<CreatedUploadMetaSession> {
  if (!Number.isSafeInteger(encryptedMetaSize) || encryptedMetaSize <= 0 || encryptedMetaSize > MAX_META_BYTES) {
    throw new DriveApiError("Encrypted metadata size is invalid", encryptedMetaSize > MAX_META_BYTES ? 413 : 400);
  }
  if (requestedOpaqueId && !VAULTDRIVE_OPAQUE_ID.test(requestedOpaqueId)) {
    throw new DriveApiError("File ID must contain only 1 to 32 digits", 400);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const opaqueId = requestedOpaqueId ?? randomOpaqueNumericId();
    const metaName = `${opaqueId}.meta`;
    const existing = await listAll(
      accessToken,
      `'${escapeDriveQueryValue(folderId)}' in parents and name = '${metaName}' and trashed = false`,
      "id"
    );
    if (existing.length) {
      if (requestedOpaqueId) throw new DriveApiError("That file ID already exists in this folder", 409);
      continue;
    }

    const metaFile = await createDriveFile(accessToken, {
      name: metaName,
      parents: [folderId],
      mimeType: "application/octet-stream",
      appProperties: {
        [VAULTDRIVE_UPLOAD_STATE_PROPERTY]: VAULTDRIVE_UPLOADING_META,
        [VAULTDRIVE_EXPECTED_META_SIZE_PROPERTY]: String(encryptedMetaSize),
      },
    });
    try {
      const response = await fetch(driveUploadUrl(`/files/${encodeURIComponent(metaFile.id)}`, { uploadType: "resumable" }), {
        method: "PATCH",
        headers: {
          ...authHeaders(accessToken),
          "X-Upload-Content-Type": "application/octet-stream",
          "X-Upload-Content-Length": String(encryptedMetaSize),
          "Content-Length": "0",
        },
        cache: "no-store",
      });
      if (!response.ok) {
        throw new DriveApiError(`Drive resumable upload setup failed (${response.status})`, response.status);
      }
      const sessionUrl = response.headers.get("location");
      if (!sessionUrl || !isValidMetaUploadSessionUrl(sessionUrl, metaFile.id)) {
        throw new DriveApiError("Drive returned an invalid resumable upload URL", 502);
      }
      return { metaFile: { id: metaFile.id }, opaqueId, sessionUrl };
    } catch (error) {
      try {
        await deleteDriveFile(accessToken, metaFile.id);
      } catch {
        // Keep the original setup error. Cleanup only targets this new file.
      }
      throw error;
    }
  }
  throw new DriveApiError("Could not allocate a unique opaque file ID", 409);
}

export interface PayloadUploadSession {
  payloadFileId: string;
  sessionUrl: string;
  finalizationRequired: false;
}

type UploadMeta = {
  id?: string;
  name: string;
  parents?: string[];
  size?: string;
  appProperties?: Record<string, string>;
};

async function getUploadMeta(
  accessToken: string,
  metaFileId: string
): Promise<{ meta: UploadMeta }> {
  const response = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(metaFileId)}?fields=id,name,parents,size,appProperties`,
    { headers: authHeaders(accessToken), cache: "no-store" }
  );
  if (!response.ok) {
    throw new DriveApiError(`Drive upload state lookup failed (${response.status}): ${await response.text()}`, response.status);
  }
  return { meta: await response.json() as UploadMeta };
}

export async function completeMetaUpload(accessToken: string, metaFileId: string): Promise<{ id: string }> {
  const { meta } = await getUploadMeta(accessToken, metaFileId);
  const expectedSizeValue = meta.appProperties?.[VAULTDRIVE_EXPECTED_META_SIZE_PROPERTY];
  const expectedSize = expectedSizeValue && /^\d+$/.test(expectedSizeValue) ? Number(expectedSizeValue) : NaN;
  const actualSize = meta.size && /^\d+$/.test(meta.size) ? Number(meta.size) : NaN;
  if (
    !VAULTDRIVE_META_NAME.test(meta.name) ||
    !Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_META_BYTES ||
    !Number.isSafeInteger(actualSize) || actualSize !== expectedSize
  ) {
    throw new DriveApiError("Encrypted metadata upload is incomplete or invalid", 409);
  }
  const state = meta.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY];
  if (state !== VAULTDRIVE_UPLOADING_META && state !== VAULTDRIVE_AWAITING_PAYLOAD) {
    throw new DriveApiError("Encrypted metadata is not awaiting completion", 409);
  }
  if (state === VAULTDRIVE_UPLOADING_META) {
    await updateDriveFileAppProperties(accessToken, metaFileId, {
      ...meta.appProperties,
      [VAULTDRIVE_UPLOAD_STATE_PROPERTY]: VAULTDRIVE_AWAITING_PAYLOAD,
    });
  }
  return { id: metaFileId };
}

async function deleteClaimedMeta(
  accessToken: string,
  metaFileId: string,
  claim: string
): Promise<void> {
  try {
    const { meta } = await getUploadMeta(accessToken, metaFileId);
    if (
      VAULTDRIVE_META_NAME.test(meta.name) &&
      meta.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY] === VAULTDRIVE_CREATING_PAYLOAD &&
      meta.appProperties?.[VAULTDRIVE_UPLOAD_CLAIM_PROPERTY] === claim
    ) {
      await deleteDriveFile(accessToken, metaFileId);
    }
  } catch (error) {
    if (!(error instanceof DriveApiError && error.status === 404)) {
      console.error("Failed to remove unfinished upload metadata", error);
    }
  }
}

/**
 * Create an opaque temporary payload and its Drive resumable-upload session.
 * The final name is applied only after all ciphertext is present.
 */
export async function createPayloadUploadSession(
  accessToken: string,
  metaFileId: string,
  encryptedSize: number
): Promise<PayloadUploadSession> {
  let creations = activePayloadSessionCreations.get(metaFileId);
  if (!creations) {
    creations = new Map();
    activePayloadSessionCreations.set(metaFileId, creations);
  }
  const existing = creations.get(accessToken);
  if (existing) return existing;

  const creation = createPayloadUploadSessionLocked(accessToken, metaFileId, encryptedSize);
  creations.set(accessToken, creation);
  try {
    return await creation;
  } finally {
    if (activePayloadSessionCreations.get(metaFileId) === creations && creations.get(accessToken) === creation) {
      creations.delete(accessToken);
      if (creations.size === 0) activePayloadSessionCreations.delete(metaFileId);
    }
  }
}

async function createPayloadUploadSessionLocked(
  accessToken: string,
  metaFileId: string,
  encryptedSize: number
): Promise<PayloadUploadSession> {
  const { meta } = await getUploadMeta(accessToken, metaFileId);
  if (
    !VAULTDRIVE_META_NAME.test(meta.name) ||
    !meta.parents?.[0] ||
    meta.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY] !== VAULTDRIVE_AWAITING_PAYLOAD
  ) {
    throw new DriveApiError("The metadata file is not ready to create an upload session", 409);
  }
  const expectedMetaSize = meta.appProperties[VAULTDRIVE_EXPECTED_META_SIZE_PROPERTY];
  if (expectedMetaSize !== undefined && (
    !/^\d+$/.test(expectedMetaSize) ||
    !Number.isSafeInteger(Number(expectedMetaSize)) ||
    Number(expectedMetaSize) <= 0 ||
    Number(expectedMetaSize) > MAX_META_BYTES ||
    meta.size !== expectedMetaSize
  )) {
    throw new DriveApiError("Encrypted metadata upload is incomplete", 409);
  }

  // Drive v3 does not reliably expose an ETag header for files.get. The
  // process-local lock above coalesces retries handled by this server; reading
  // the claim back prevents work from continuing if another writer won it.
  const claim = crypto.randomUUID();
  await updateDriveFileAppProperties(accessToken, metaFileId, {
    ...meta.appProperties,
    [VAULTDRIVE_UPLOAD_STATE_PROPERTY]: VAULTDRIVE_CREATING_PAYLOAD,
    [VAULTDRIVE_UPLOAD_CLAIM_PROPERTY]: claim,
  });
  const { meta: claimedMeta } = await getUploadMeta(accessToken, metaFileId);
  if (
    claimedMeta.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY] !== VAULTDRIVE_CREATING_PAYLOAD ||
    claimedMeta.appProperties?.[VAULTDRIVE_UPLOAD_CLAIM_PROPERTY] !== claim
  ) {
    throw new DriveApiError("An upload session is already being created for this metadata file", 409);
  }

  const opaqueId = claimedMeta.name.replace(/\.meta$/, "");
  let payload: { id: string } | undefined;
  try {
    payload = await createDriveFile(accessToken, {
      // The payload has its final opaque name from the start. The resolver
      // refuses this bound pair until Drive reports the exact expected size,
      // so incomplete ciphertext cannot be downloaded before the final PUT.
      name: opaqueId,
      parents: [claimedMeta.parents![0]],
      mimeType: "application/octet-stream",
      appProperties: {
        [VAULTDRIVE_UPLOAD_STATE_PROPERTY]: VAULTDRIVE_CREATING_PAYLOAD,
        [VAULTDRIVE_META_ID_PROPERTY]: metaFileId,
        [VAULTDRIVE_UPLOAD_CLAIM_PROPERTY]: claim,
        [VAULTDRIVE_EXPECTED_PAYLOAD_SIZE_PROPERTY]: String(encryptedSize),
      },
    });

    const response = await fetch(driveUploadUrl(`/files/${encodeURIComponent(payload.id)}`, { uploadType: "resumable" }), {
      method: "PATCH",
      headers: {
        ...authHeaders(accessToken),
        "X-Upload-Content-Type": "application/octet-stream",
        "X-Upload-Content-Length": String(encryptedSize),
        "Content-Length": "0",
      },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new DriveApiError(`Drive resumable upload setup failed (${response.status}): ${await response.text()}`, response.status);
    }
    const sessionUrl = response.headers.get("location");
    if (!sessionUrl) throw new DriveApiError("Drive did not return a resumable upload URL", 502);

    // The session URL is only returned after both sides are bound. Cleanup
    // deliberately ignores the transient creating-payload state.
    await updateDriveFileAppProperties(accessToken, payload.id, {
      [VAULTDRIVE_UPLOAD_STATE_PROPERTY]: VAULTDRIVE_PENDING,
      [VAULTDRIVE_META_ID_PROPERTY]: metaFileId,
      [VAULTDRIVE_UPLOAD_CLAIM_PROPERTY]: claim,
      [VAULTDRIVE_EXPECTED_PAYLOAD_SIZE_PROPERTY]: String(encryptedSize),
    });
    await updateDriveFileAppProperties(accessToken, metaFileId, {
      ...claimedMeta.appProperties,
      [VAULTDRIVE_UPLOAD_STATE_PROPERTY]: VAULTDRIVE_PENDING,
      [VAULTDRIVE_PAYLOAD_ID_PROPERTY]: payload.id,
      [VAULTDRIVE_UPLOAD_CLAIM_PROPERTY]: claim,
      [VAULTDRIVE_EXPECTED_PAYLOAD_SIZE_PROPERTY]: String(encryptedSize),
    });
    return { payloadFileId: payload.id, sessionUrl, finalizationRequired: false };
  } catch (error) {
    // Nothing has been returned to the browser yet, so it is safe to remove
    // the locally-created payload and its claimed sidecar on setup/binding
    // failure. This avoids inaccessible pending pairs after a failed setup.
    if (payload) {
      try {
        await deleteDriveFile(accessToken, payload.id);
      } catch (cleanupError) {
        console.error("Failed to remove unbound upload payload", cleanupError);
      }
    }
    await deleteClaimedMeta(accessToken, metaFileId, claim);
    throw error;
  }
}

export async function completePayloadUpload(
  accessToken: string,
  metaFileId: string,
  payloadFileId: string
): Promise<DriveMetaFile> {
  const metaRes = await driveGet(accessToken, `/files/${encodeURIComponent(metaFileId)}`, { fields: "name,parents,appProperties" });
  const meta = await metaRes.json() as { name: string; parents?: string[]; appProperties?: Record<string, string> };
  const payloadRes = await driveGet(accessToken, `/files/${encodeURIComponent(payloadFileId)}`, { fields: "id,name,parents,size,modifiedTime,createdTime,appProperties" });
  const payload = await payloadRes.json() as DriveMetaFile & { parents?: string[]; appProperties?: Record<string, string> };
  const finalName = meta.name.replace(/\.meta$/, "");
  const hasBinding =
    VAULTDRIVE_META_NAME.test(meta.name) &&
    payload.parents?.includes(meta.parents?.[0] ?? "") &&
    meta.appProperties?.[VAULTDRIVE_PAYLOAD_ID_PROPERTY] === payloadFileId &&
    payload.appProperties?.[VAULTDRIVE_META_ID_PROPERTY] === metaFileId;
  const metaState = meta.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY];
  const payloadState = payload.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY];
  if (!hasBinding) {
    throw new DriveApiError("Payload does not belong to this metadata sidecar", 400);
  }
  if (metaState === VAULTDRIVE_COMPLETED && payloadState === VAULTDRIVE_COMPLETED && payload.name === finalName) {
    return payload;
  }
  if (payloadState === VAULTDRIVE_COMPLETED && payload.name === finalName && metaState === VAULTDRIVE_PENDING) {
    await updateDriveFileAppProperties(accessToken, metaFileId, {
      ...meta.appProperties,
      [VAULTDRIVE_UPLOAD_STATE_PROPERTY]: VAULTDRIVE_COMPLETED,
    });
    return payload;
  }
  const expectedPayloadSize = payload.appProperties?.[VAULTDRIVE_EXPECTED_PAYLOAD_SIZE_PROPERTY];
  const isReadyFinalNamePayload =
    payload.name === finalName &&
    typeof expectedPayloadSize === "string" &&
    /^\d+$/.test(expectedPayloadSize) &&
    payload.size === expectedPayloadSize;
  if (metaState === VAULTDRIVE_PENDING && payloadState === VAULTDRIVE_PENDING && isReadyFinalNamePayload) {
    // New clients can safely finish without this request because resolution
    // gates on the exact Drive-reported size. Retain this branch for older
    // cached clients that still call /complete after receiving the final PUT.
    await updateDriveFileAppProperties(accessToken, payloadFileId, {
      ...payload.appProperties,
      [VAULTDRIVE_UPLOAD_STATE_PROPERTY]: VAULTDRIVE_COMPLETED,
    });
    await updateDriveFileAppProperties(accessToken, metaFileId, {
      ...meta.appProperties,
      [VAULTDRIVE_UPLOAD_STATE_PROPERTY]: VAULTDRIVE_COMPLETED,
    });
    return payload;
  }
  if (metaState !== VAULTDRIVE_PENDING || payloadState !== VAULTDRIVE_PENDING || payload.name !== `${finalName}.uploading`) {
    throw new DriveApiError("Payload upload is not pending", 409);
  }
  const response = await fetch(`${DRIVE_API}/files/${encodeURIComponent(payloadFileId)}?fields=id,name,size,modifiedTime,createdTime`, {
    method: "PATCH",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({
      name: finalName,
      appProperties: {
        ...payload.appProperties,
        [VAULTDRIVE_UPLOAD_STATE_PROPERTY]: VAULTDRIVE_COMPLETED,
      },
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new DriveApiError(`Drive payload finalization failed (${response.status}): ${await response.text()}`, response.status);
  const completedPayload = await response.json() as DriveMetaFile;
  await updateDriveFileAppProperties(accessToken, metaFileId, {
    ...meta.appProperties,
    [VAULTDRIVE_UPLOAD_STATE_PROPERTY]: VAULTDRIVE_COMPLETED,
  });
  return completedPayload;
}

export async function deleteUploadPair(
  accessToken: string,
  metaFileId: string,
  payloadFileId?: string
): Promise<void> {
  type UploadFile = {
    name?: string;
    parents?: string[];
    size?: string;
    appProperties?: Record<string, string>;
  };
  const fetchUploadFile = async (fileId: string): Promise<UploadFile | null> => {
    const response = await fetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=name,parents,size,appProperties`,
      { headers: authHeaders(accessToken), cache: "no-store" }
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new DriveApiError(`Drive upload cleanup failed (${response.status})`, response.status);
    }
    return response.json() as Promise<UploadFile>;
  };

  const meta = await fetchUploadFile(metaFileId);
  let resolvedPayloadFileId = payloadFileId;
  if (!resolvedPayloadFileId && meta) {
    const boundPayloadId = meta.appProperties?.[VAULTDRIVE_PAYLOAD_ID_PROPERTY];
    if (
      VAULTDRIVE_META_NAME.test(meta.name ?? "") &&
      meta.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY] === VAULTDRIVE_PENDING &&
      typeof boundPayloadId === "string" &&
      /^[A-Za-z0-9_-]{1,256}$/.test(boundPayloadId)
    ) {
      // If the browser missed the session response, recover only the exact
      // pending peer named by the numeric sidecar, then run normal pair checks.
      resolvedPayloadFileId = boundPayloadId;
    }
  }
  if (!resolvedPayloadFileId) {
    // A session can fail before a payload ID exists. Only server-created
    // pre-pair states without a bound peer can be removed directly.
    if (!meta) return;
    if (
      VAULTDRIVE_META_NAME.test(meta.name ?? "") &&
      (meta.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY] === VAULTDRIVE_UPLOADING_META ||
        meta.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY] === VAULTDRIVE_AWAITING_PAYLOAD ||
        meta.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY] === VAULTDRIVE_CREATING_PAYLOAD) &&
      !meta.appProperties?.[VAULTDRIVE_PAYLOAD_ID_PROPERTY]
    ) {
      await deleteDriveFile(accessToken, metaFileId);
      return;
    }
    throw new DriveApiError("Upload metadata is not awaiting a payload", 409);
  }
  const payload = await fetchUploadFile(resolvedPayloadFileId);
  const isPendingMeta = (file: UploadFile) =>
    VAULTDRIVE_META_NAME.test(file.name ?? "") &&
    file.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY] === VAULTDRIVE_PENDING &&
    file.appProperties?.[VAULTDRIVE_PAYLOAD_ID_PROPERTY] === resolvedPayloadFileId;
  const isPendingPayload = (file: UploadFile) => {
    if (
      file.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY] !== VAULTDRIVE_PENDING ||
      file.appProperties?.[VAULTDRIVE_META_ID_PROPERTY] !== metaFileId
    ) {
      return false;
    }
    if (VAULTDRIVE_PAYLOAD_NAME.test(file.name ?? "")) return true;

    // New-format uploads have their final opaque name from session creation.
    // They may be cleaned up only while Drive has not committed the declared
    // ciphertext length; a completed payload must remain recoverable.
    const expectedSize = file.appProperties?.[VAULTDRIVE_EXPECTED_PAYLOAD_SIZE_PROPERTY];
    return (
      VAULTDRIVE_OPAQUE_ID.test(file.name ?? "") &&
      typeof expectedSize === "string" &&
      /^\d+$/.test(expectedSize) &&
      file.size !== expectedSize
    );
  };

  // Both files already being absent is a safe retry of an earlier cleanup.
  if (!meta && !payload) return;
  if (!meta || !payload) {
    if (meta && isPendingMeta(meta)) {
      await deleteDriveFile(accessToken, metaFileId);
      return;
    }
    if (payload && isPendingPayload(payload)) {
      await deleteDriveFile(accessToken, resolvedPayloadFileId);
      return;
    }
    throw new DriveApiError("Upload cleanup pair is incomplete", 409);
  }

  const sharedParent = meta.parents?.find((parent) => payload.parents?.includes(parent));
  if (
    !isPendingMeta(meta) ||
    !isPendingPayload(payload) ||
    !sharedParent
  ) {
    throw new DriveApiError("Upload cleanup pair is invalid", 400);
  }

  await Promise.all([metaFileId, resolvedPayloadFileId].map(async (id) => {
    await deleteDriveFile(accessToken, id);
  }));
}

interface TrashPairFile {
  id: string;
  name: string;
  parents?: string[];
  mimeType?: string;
  trashed: boolean;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
  capabilities?: { canTrash?: boolean };
}

const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const TRASH_PAIR_RETRY_MESSAGE = "Could not move both files to Trash. Retry; any files already moved can be restored from Google Drive Trash.";

function safeTrashLookupError(error: unknown): DriveApiError {
  if (error instanceof DriveApiError) {
    const status = error.status === 401 || error.status === 403 || error.status === 404
      ? error.status
      : 502;
    return new DriveApiError("Could not resolve the Drive file pair", status);
  }
  return new DriveApiError("Could not resolve the Drive file pair", 502);
}

async function getTrashPairFile(accessToken: string, fileId: string): Promise<TrashPairFile | null> {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "id,name,parents,mimeType,trashed,modifiedTime,appProperties,capabilities(canTrash)");
  url.searchParams.set("supportsAllDrives", "true");
  try {
    const response = await fetch(url.toString(), {
      headers: authHeaders(accessToken),
      cache: "no-store",
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403 ? response.status : 502;
      throw new DriveApiError("Could not inspect a Drive file", status);
    }
    const file = await response.json() as TrashPairFile;
    if (
      !file ||
      file.id !== fileId ||
      typeof file.name !== "string" ||
      typeof file.mimeType !== "string" ||
      typeof file.trashed !== "boolean"
    ) {
      throw new DriveApiError("Drive returned invalid file metadata", 502);
    }
    if (file.parents !== undefined && (!Array.isArray(file.parents) || file.parents.some((parent) => typeof parent !== "string"))) {
      throw new DriveApiError("Drive returned invalid file metadata", 502);
    }
    return file;
  } catch (error) {
    if (error instanceof DriveApiError) throw error;
    throw new DriveApiError("Could not inspect a Drive file", 502);
  }
}

async function trashDriveFile(accessToken: string, fileId: string): Promise<void> {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id,trashed");
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "PATCH",
      headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
      cache: "no-store",
    });
  } catch {
    throw new DriveApiError(TRASH_PAIR_RETRY_MESSAGE, 502);
  }
  if (!response.ok) throw new DriveApiError(TRASH_PAIR_RETRY_MESSAGE, 502);
  try {
    const updated = await response.json() as { id?: unknown; trashed?: unknown };
    if (updated.id !== fileId || updated.trashed !== true) {
      throw new DriveApiError(TRASH_PAIR_RETRY_MESSAGE, 502);
    }
  } catch (error) {
    if (error instanceof DriveApiError) throw error;
    throw new DriveApiError(TRASH_PAIR_RETRY_MESSAGE, 502);
  }
}

export async function trashVaultFilePair(
  accessToken: string,
  metaFileId: string,
  options: { expectedMetaName: string; expectedModifiedTime: string }
): Promise<{ metaFileId: string; payloadFileId: string }> {
  const { expectedMetaName, expectedModifiedTime } = options;
  if (
    typeof expectedMetaName !== "string" ||
    expectedMetaName.length < 1 ||
    expectedMetaName.length > 1024 ||
    !expectedMetaName.endsWith(".meta") ||
    typeof expectedModifiedTime !== "string" ||
    expectedModifiedTime.length < 1 ||
    expectedModifiedTime.length > 64 ||
    !Number.isFinite(Date.parse(expectedModifiedTime))
  ) {
    throw new DriveApiError("Invalid file deletion request", 400);
  }

  const meta = await getTrashPairFile(accessToken, metaFileId);
  if (!meta) throw new DriveApiError("Drive metadata file was not found", 404);
  if (meta.mimeType === DRIVE_FOLDER_MIME_TYPE) {
    throw new DriveApiError("Folders cannot be moved as file pairs", 400);
  }
  if (!meta.name.endsWith(".meta")) {
    throw new DriveApiError("The requested file is not a metadata file", 400);
  }
  if (meta.name !== expectedMetaName) {
    throw new DriveApiError("The metadata file changed; refresh and try again", 409);
  }
  if (!meta.parents?.[0]) throw new DriveApiError("The metadata file has no parent folder", 400);
  if (!meta.trashed && meta.modifiedTime !== expectedModifiedTime) {
    throw new DriveApiError("The metadata file changed; refresh and try again", 409);
  }

  const payloadName = meta.name.slice(0, -".meta".length);
  const metaProperties = meta.appProperties ?? {};
  const metaHasPayloadBinding = Object.prototype.hasOwnProperty.call(metaProperties, VAULTDRIVE_PAYLOAD_ID_PROPERTY);
  let payload: TrashPairFile;

  if (metaHasPayloadBinding) {
    const boundPayloadId = metaProperties[VAULTDRIVE_PAYLOAD_ID_PROPERTY];
    if (typeof boundPayloadId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(boundPayloadId)) {
      throw new DriveApiError("The metadata and payload binding is invalid", 409);
    }
    const bound = await getTrashPairFile(accessToken, boundPayloadId);
    if (!bound) throw new DriveApiError("The paired payload was not found", 404);
    if (bound.mimeType === DRIVE_FOLDER_MIME_TYPE) {
      throw new DriveApiError("Folders cannot be moved as file pairs", 400);
    }
    if (
      bound.name !== payloadName ||
      !bound.parents?.includes(meta.parents[0]) ||
      bound.appProperties?.[VAULTDRIVE_META_ID_PROPERTY] !== metaFileId
    ) {
      throw new DriveApiError("The metadata and payload do not match", 409);
    }
    payload = bound;
  } else {
    const query = `'${escapeDriveQueryValue(meta.parents[0])}' in parents and name = '${escapeDriveQueryValue(payloadName)}'`;
    let listed: unknown;
    try {
      listed = await listAll(
        accessToken,
        query,
        "id,name,parents,mimeType,trashed,appProperties,capabilities(canTrash)",
        undefined,
        true
      );
    } catch (error) {
      throw safeTrashLookupError(error);
    }
    if (!Array.isArray(listed) || listed.some((candidate: unknown) => {
      if (!candidate || typeof candidate !== "object") return true;
      const file = candidate as Record<string, unknown>;
      return typeof file.id !== "string" ||
        typeof file.name !== "string" ||
        typeof file.mimeType !== "string" ||
        typeof file.trashed !== "boolean" ||
        (file.parents !== undefined && (!Array.isArray(file.parents) || file.parents.some((parent) => typeof parent !== "string")));
    })) {
      throw new DriveApiError("Drive returned invalid file metadata", 502);
    }
    let candidates = listed as TrashPairFile[];
    candidates = candidates.filter((candidate) => candidate.name === payloadName && candidate.parents?.includes(meta.parents![0]));
    if (candidates.some((candidate) =>
      Object.prototype.hasOwnProperty.call(candidate.appProperties ?? {}, VAULTDRIVE_META_ID_PROPERTY)
    )) {
      throw new DriveApiError("The metadata and payload do not match", 409);
    }
    if (candidates.some((candidate) => candidate.mimeType === DRIVE_FOLDER_MIME_TYPE)) {
      throw new DriveApiError("Folders cannot be moved as file pairs", 400);
    }
    const liveCandidates = candidates.filter((candidate) => candidate.trashed === false);
    const trashedCandidates = candidates.filter((candidate) => candidate.trashed === true);
    if (meta.trashed) {
      if (trashedCandidates.length === 0) throw new DriveApiError("The paired payload was not found", 404);
      if (trashedCandidates.length !== 1) throw new DriveApiError("The paired payload is ambiguous", 409);
      payload = trashedCandidates[0];
    } else if (liveCandidates.length === 1) {
      payload = liveCandidates[0];
    } else if (liveCandidates.length > 1) {
      throw new DriveApiError("The paired payload is ambiguous", 409);
    } else if (trashedCandidates.length === 0) {
      throw new DriveApiError("The paired payload was not found", 404);
    } else if (trashedCandidates.length !== 1) {
      throw new DriveApiError("The paired payload is ambiguous", 409);
    } else {
      payload = trashedCandidates[0];
    }
  }

  if (!meta.trashed && meta.capabilities?.canTrash !== true) {
    throw new DriveApiError("Google Drive does not allow this file to be moved to Trash", 403);
  }
  if (!payload.trashed && payload.capabilities?.canTrash !== true) {
    throw new DriveApiError("Google Drive does not allow this file to be moved to Trash", 403);
  }

  if (!payload.trashed) await trashDriveFile(accessToken, payload.id);
  if (!meta.trashed) await trashDriveFile(accessToken, meta.id);
  return { metaFileId: meta.id, payloadFileId: payload.id };
}

async function resolvePayloadFile(
  accessToken: string,
  metaFileId: string,
  signal?: AbortSignal
): Promise<{ id: string; name: string; size?: string; resourceKey?: string }> {
  const metaRes = await driveGet(
    accessToken,
    `/files/${encodeURIComponent(metaFileId)}`,
    { fields: "id,name,parents,appProperties" },
    {},
    signal
  );
  const metaFile: { id: string; name: string; parents?: string[]; appProperties?: Record<string, string> } =
    await metaRes.json();

  if (!/\.meta$/i.test(metaFile.name)) {
    throw new Error("The requested file is not a metadata file");
  }

  const parentId = metaFile.parents?.[0];
  if (!parentId) {
    throw new Error("Metadata file has no parent folder");
  }

  const payloadName = metaFile.name.replace(/\.meta$/i, "");
  const q = `'${escapeDriveQueryValue(parentId)}' in parents and name = '${escapeDriveQueryValue(payloadName)}' and trashed = false`;
  const payloads = await listAll(accessToken, q, "id,name,size,resourceKey,appProperties", signal) as Array<{
    id: string;
    name: string;
    size?: string;
    resourceKey?: string;
    appProperties?: Record<string, string>;
  }>;

  if (payloads.length === 0) {
    throw new Error(`No payload found beside ${metaFile.name}`);
  }
  if (payloads.length > 1) {
    throw new Error(`Multiple payloads found beside ${metaFile.name}`);
  }

  const payload = payloads[0];
  const expectedSize = payload.appProperties?.[VAULTDRIVE_EXPECTED_PAYLOAD_SIZE_PROPERTY];
  if (expectedSize !== undefined) {
    const hasExpectedSize = /^\d+$/.test(expectedSize) && payload.size === expectedSize;
    const hasBinding =
      payload.appProperties?.[VAULTDRIVE_META_ID_PROPERTY] === metaFileId &&
      metaFile.appProperties?.[VAULTDRIVE_PAYLOAD_ID_PROPERTY] === payload.id;
    if (!hasExpectedSize || !hasBinding) {
      throw new Error("Encrypted payload is still uploading");
    }
  }

  return payload;
}

/**
 * Create a direct download session for the securely paired encrypted payload.
 * Payloads live beside their metadata file and use the metadata filename
 * without the final `.meta` suffix (for example, `42.meta` -> `42`).
 */
export interface PayloadDownloadSession {
  downloadUri: string;
  partialDownloadAllowed: boolean;
  payloadFileId: string;
  encryptedSize: number;
  resourceKey?: string;
}

interface DriveDownloadOperation {
  name?: unknown;
  done?: unknown;
  metadata?: { resourceKey?: unknown } | null;
  response?: { downloadUri?: unknown; partialDownloadAllowed?: unknown } | null;
  error?: unknown;
}

const MAX_DOWNLOAD_SESSION_MS = 45_000;
const MAX_RESOURCE_KEY_LENGTH = 2048;

function validResourceKey(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_RESOURCE_KEY_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function downloadOperationId(name: unknown): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 1024) {
    throw new DriveApiError("Download operation response is invalid", 502);
  }
  const operationId = name.startsWith("operations/") ? name.slice("operations/".length) : name;
  if (!/^[A-Za-z0-9._~-]{1,512}$/.test(operationId) || operationId === "." || operationId === "..") {
    throw new DriveApiError("Download operation response is invalid", 502);
  }
  return operationId;
}

function assertNoOperationError(operation: DriveDownloadOperation): void {
  if (Object.prototype.hasOwnProperty.call(operation, "error") && operation.error != null) {
    throw new DriveApiError("Google Drive could not create a download session", 502);
  }
}

function validateDownloadUri(value: unknown, payloadFileId: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) {
    throw new DriveApiError("Google Drive returned an invalid download session", 502);
  }

  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new DriveApiError("Google Drive returned an invalid download session", 502);
  }

  const hostname = uri.hostname.toLowerCase();
  const isGoogleApiHost = hostname === "www.googleapis.com";
  const isGoogleUserContentHost = hostname === "googleusercontent.com" || hostname.endsWith(".googleusercontent.com");
  const expectedFilePath = `/drive/v3/files/${encodeURIComponent(payloadFileId)}`;
  const invalidOAuthQuery = Array.from(uri.searchParams.keys()).some((key) =>
    /^(access_token|oauth_token|refresh_token|id_token)$/i.test(key)
  );

  if (
    uri.protocol !== "https:" ||
    (!isGoogleApiHost && !isGoogleUserContentHost) ||
    (isGoogleApiHost && uri.pathname !== expectedFilePath) ||
    uri.username !== "" ||
    uri.password !== "" ||
    uri.port !== "" ||
    uri.hash !== "" ||
    invalidOAuthQuery
  ) {
    throw new DriveApiError("Google Drive returned an invalid download session", 502);
  }

  return uri.toString();
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function toDownloadSession(
  operation: DriveDownloadOperation,
  payloadFile: { id: string; resourceKey?: string },
  encryptedSize: number,
  operationResourceKey?: string
): PayloadDownloadSession {
  assertNoOperationError(operation);
  if (operation.done !== true || !operation.response || typeof operation.response.partialDownloadAllowed !== "boolean") {
    throw new DriveApiError("Google Drive returned an incomplete download session", 502);
  }

  const resourceKey = operationResourceKey ?? payloadFile.resourceKey;
  if (resourceKey !== undefined && !validResourceKey(resourceKey)) {
    throw new DriveApiError("Google Drive returned an invalid download session", 502);
  }

  return {
    downloadUri: validateDownloadUri(operation.response.downloadUri, payloadFile.id),
    partialDownloadAllowed: operation.response.partialDownloadAllowed,
    payloadFileId: payloadFile.id,
    encryptedSize,
    ...(resourceKey ? { resourceKey } : {}),
  };
}

export async function createPayloadDownloadSession(
  accessToken: string,
  metaFileId: string,
  signal?: AbortSignal
): Promise<PayloadDownloadSession> {
  const deadlineSignal = AbortSignal.timeout(MAX_DOWNLOAD_SESSION_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;

  try {
    const payloadFile = await resolvePayloadFile(accessToken, metaFileId, combinedSignal);
    if (!payloadFile.size || !/^\d+$/.test(payloadFile.size)) {
      throw new DriveApiError("Encrypted payload size is invalid", 502);
    }
    const encryptedSize = Number(payloadFile.size);
    if (!Number.isSafeInteger(encryptedSize) || encryptedSize <= 0) {
      throw new DriveApiError("Encrypted payload size is invalid", 502);
    }
    if (payloadFile.resourceKey !== undefined && !validResourceKey(payloadFile.resourceKey)) {
      throw new DriveApiError("Encrypted payload metadata is invalid", 502);
    }

    const headers: Record<string, string> = authHeaders(accessToken);
    if (payloadFile.resourceKey) {
      headers["X-Goog-Drive-Resource-Keys"] = `${payloadFile.id}/${payloadFile.resourceKey}`;
    }
    const createResponse = await fetch(
      `${DRIVE_API}/files/${encodeURIComponent(payloadFile.id)}/download`,
      { method: "POST", headers, cache: "no-store", signal: combinedSignal }
    );
    if (!createResponse.ok) {
      throw new DriveApiError("Google Drive could not create a download session", createResponse.status);
    }

    let operation = await createResponse.json() as DriveDownloadOperation;
    let operationResourceKey: string | undefined;
    let backoffMs = 1_000;

    while (operation.done !== true) {
      assertNoOperationError(operation);
      if (operation.done !== false && operation.done !== null && operation.done !== undefined) {
        throw new DriveApiError("Google Drive returned an invalid download session", 502);
      }
      if (operation.metadata?.resourceKey !== undefined) {
        if (!validResourceKey(operation.metadata.resourceKey)) {
          throw new DriveApiError("Google Drive returned an invalid download session", 502);
        }
        operationResourceKey = operation.metadata.resourceKey;
      }

      const operationId = downloadOperationId(operation.name);
      await abortableDelay(backoffMs, combinedSignal);
      const operationUrl = `${DRIVE_API}/operations/${encodeURIComponent(operationId)}`;
      const pollHeaders: Record<string, string> = authHeaders(accessToken);
      const pollResourceKey = operationResourceKey ?? payloadFile.resourceKey;
      if (pollResourceKey) {
        pollHeaders["X-Goog-Drive-Resource-Keys"] = `${payloadFile.id}/${pollResourceKey}`;
      }
      const pollResponse = await fetch(operationUrl, {
        headers: pollHeaders,
        cache: "no-store",
        signal: combinedSignal,
      });
      if (!pollResponse.ok) {
        throw new DriveApiError("Google Drive could not complete a download session", pollResponse.status);
      }
      operation = await pollResponse.json() as DriveDownloadOperation;
      backoffMs = Math.min(backoffMs * 2, 8_000);
    }

    if (operation.metadata?.resourceKey !== undefined) {
      if (!validResourceKey(operation.metadata.resourceKey)) {
        throw new DriveApiError("Google Drive returned an invalid download session", 502);
      }
      operationResourceKey = operation.metadata.resourceKey;
    }
    return toDownloadSession(operation, payloadFile, encryptedSize, operationResourceKey);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (deadlineSignal.aborted) {
      throw new DriveApiError("Download session creation timed out", 504);
    }
    if (error instanceof DriveApiError) throw error;
    throw new DriveApiError("Unable to create download session", 502);
  }
}

/**
 * Resolve a folderId to a breadcrumb path array.
 * Walks the parents chain up to Drive root and stops if Drive returns a cycle.
 */
export async function getFolderPath(
  accessToken: string,
  folderId: string
): Promise<BreadcrumbItem[]> {
  const crumbs: BreadcrumbItem[] = [];
  let currentId = folderId;
  const visited = new Set<string>();

  while (currentId !== "root" && !visited.has(currentId)) {
    visited.add(currentId);

    const res = await driveGet(accessToken, `/files/${encodeURIComponent(currentId)}`, {
      fields: "id,name,parents",
    });
    const file: { id: string; name: string; parents?: string[] } =
      await res.json();

    crumbs.unshift({ id: file.id, name: file.name });

    const parent = file.parents?.[0];
    if (!parent) break;
    currentId = parent;
  }

  return crumbs;
}
