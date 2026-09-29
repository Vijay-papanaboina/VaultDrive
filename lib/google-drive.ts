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
  requestHeaders: Record<string, string> = {}
): Promise<Response> {
  const url = new URL(`${DRIVE_API}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { ...authHeaders(accessToken), ...requestHeaders },
    // Next.js: don't cache Drive responses by default
    cache: "no-store",
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
  fields: string
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
    if (pageToken) params.pageToken = pageToken;

    const res = await driveGet(accessToken, "/files", params);
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
  const files = await listAll(accessToken, q, "id,name,size,modifiedTime,createdTime");
  return files as DriveMetaFile[];
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

export interface CreatedUploadMeta {
  metaFile: DriveMetaFile;
  opaqueId: string;
}

/** Create the encrypted .meta sidecar first, under an opaque numeric name. */
export async function createMetaUpload(
  accessToken: string,
  folderId: string,
  encryptedMeta: Uint8Array,
  requestedOpaqueId?: string
): Promise<CreatedUploadMeta> {
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

    const boundary = `vaultdrive-${crypto.randomUUID()}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify({
        name: metaName,
        parents: [folderId],
        mimeType: "application/octet-stream",
        appProperties: { [VAULTDRIVE_UPLOAD_STATE_PROPERTY]: VAULTDRIVE_AWAITING_PAYLOAD },
      }),
      `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      encryptedMeta.buffer.slice(encryptedMeta.byteOffset, encryptedMeta.byteOffset + encryptedMeta.byteLength) as ArrayBuffer,
      `\r\n--${boundary}--`,
    ]);
    const response = await fetch(driveUploadUrl("/files", {
      uploadType: "multipart", fields: "id,name,size,modifiedTime,createdTime",
    }), {
      method: "POST",
      headers: { ...authHeaders(accessToken), "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
      cache: "no-store",
    });
    if (!response.ok) {
      throw new DriveApiError(`Drive metadata upload failed (${response.status}): ${await response.text()}`, response.status);
    }
    return { metaFile: await response.json() as DriveMetaFile, opaqueId };
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
  appProperties?: Record<string, string>;
};

async function getUploadMeta(
  accessToken: string,
  metaFileId: string
): Promise<{ meta: UploadMeta }> {
  const response = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(metaFileId)}?fields=id,name,parents,appProperties`,
    { headers: authHeaders(accessToken), cache: "no-store" }
  );
  if (!response.ok) {
    throw new DriveApiError(`Drive upload state lookup failed (${response.status}): ${await response.text()}`, response.status);
  }
  return { meta: await response.json() as UploadMeta };
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
  if (!payloadFileId) {
    // A session can fail before a payload ID exists. This narrow recovery is
    // limited to the server-created pre-pair state; a pending or completed
    // sidecar still requires its exact, bidirectionally-bound peer.
    if (!meta) return;
    if (
      VAULTDRIVE_META_NAME.test(meta.name ?? "") &&
      (meta.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY] === VAULTDRIVE_AWAITING_PAYLOAD ||
        meta.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY] === VAULTDRIVE_CREATING_PAYLOAD) &&
      !meta.appProperties?.[VAULTDRIVE_PAYLOAD_ID_PROPERTY]
    ) {
      await deleteDriveFile(accessToken, metaFileId);
      return;
    }
    throw new DriveApiError("Upload metadata is not awaiting a payload", 409);
  }
  const payload = await fetchUploadFile(payloadFileId);
  const isPendingMeta = (file: UploadFile) =>
    VAULTDRIVE_META_NAME.test(file.name ?? "") &&
    file.appProperties?.[VAULTDRIVE_UPLOAD_STATE_PROPERTY] === VAULTDRIVE_PENDING &&
    file.appProperties?.[VAULTDRIVE_PAYLOAD_ID_PROPERTY] === payloadFileId;
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
      await deleteDriveFile(accessToken, payloadFileId);
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

  await Promise.all([metaFileId, payloadFileId].map(async (id) => {
    await deleteDriveFile(accessToken, id);
  }));
}

async function resolvePayloadFile(
  accessToken: string,
  metaFileId: string
): Promise<{ id: string; name: string }> {
  const metaRes = await driveGet(
    accessToken,
    `/files/${encodeURIComponent(metaFileId)}`,
    { fields: "id,name,parents,appProperties" }
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
  const payloads = await listAll(accessToken, q, "id,name,size,appProperties") as Array<{
    id: string;
    name: string;
    size?: string;
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
 * Return the upstream encrypted payload response without buffering it.
 * Payloads live beside their metadata file and use the metadata filename
 * without the final `.meta` suffix (for example, `42.meta` -> `42`).
 */
export async function getPayloadStream(
  accessToken: string,
  metaFileId: string,
  range?: string
): Promise<Response> {
  const payloadFile = await resolvePayloadFile(accessToken, metaFileId);
  return driveGet(
    accessToken,
    `/files/${encodeURIComponent(payloadFile.id)}`,
    { alt: "media" },
    range ? { Range: range } : {}
  );
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
