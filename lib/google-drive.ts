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

async function driveGet(
  accessToken: string,
  path: string,
  params: Record<string, string> = {}
): Promise<Response> {
  const url = new URL(`${DRIVE_API}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: authHeaders(accessToken),
    // Next.js: don't cache Drive responses by default
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drive API error ${res.status}: ${body}`);
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
  const q = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
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
  const q = `'${folderId}' in parents and fileExtension = 'meta' and trashed = false`;
  const files = await listAll(accessToken, q, "id,name,size,modifiedTime,createdTime");
  return files as DriveMetaFile[];
}

/**
 * Download a file's raw content as Uint8Array.
 * Used to fetch encrypted .meta file bytes.
 */
export async function getFileContent(
  accessToken: string,
  fileId: string
): Promise<Uint8Array> {
  const res = await driveGet(accessToken, `/files/${encodeURIComponent(fileId)}`, { alt: "media" });
  const buffer = await res.arrayBuffer();
  return new Uint8Array(buffer);
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

export interface CreatedUploadMeta {
  metaFile: DriveMetaFile;
  opaqueId: string;
}

/** Create the encrypted .meta sidecar first, under an opaque numeric name. */
export async function createMetaUpload(
  accessToken: string,
  folderId: string,
  encryptedMeta: Uint8Array
): Promise<CreatedUploadMeta> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const opaqueId = randomOpaqueNumericId();
    const metaName = `${opaqueId}.meta`;
    const existing = await listAll(
      accessToken,
      `'${escapeDriveQueryValue(folderId)}' in parents and name = '${metaName}' and trashed = false`,
      "id"
    );
    if (existing.length) continue;

    const boundary = `vaultdrive-${crypto.randomUUID()}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify({ name: metaName, parents: [folderId], mimeType: "application/octet-stream" }),
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
  const metaRes = await driveGet(accessToken, `/files/${encodeURIComponent(metaFileId)}`, { fields: "id,name,parents" });
  const meta = await metaRes.json() as { name: string; parents?: string[] };
  if (!/^[0-9]+\.meta$/i.test(meta.name) || !meta.parents?.[0]) {
    throw new DriveApiError("The metadata file is not a VaultDrive upload sidecar", 400);
  }
  const opaqueId = meta.name.replace(/\.meta$/i, "");
  const payload = await createDriveFile(accessToken, {
    name: `${opaqueId}.uploading`, parents: [meta.parents[0]], mimeType: "application/octet-stream",
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
  return { payloadFileId: payload.id, sessionUrl };
}

export async function completePayloadUpload(
  accessToken: string,
  metaFileId: string,
  payloadFileId: string
): Promise<DriveMetaFile> {
  const metaRes = await driveGet(accessToken, `/files/${encodeURIComponent(metaFileId)}`, { fields: "name,parents" });
  const meta = await metaRes.json() as { name: string; parents?: string[] };
  const payloadRes = await driveGet(accessToken, `/files/${encodeURIComponent(payloadFileId)}`, { fields: "id,name,parents,size,modifiedTime,createdTime" });
  const payload = await payloadRes.json() as DriveMetaFile & { parents?: string[] };
  const finalName = meta.name.replace(/\.meta$/i, "");
  if (!/^[0-9]+\.meta$/i.test(meta.name) || payload.name !== `${finalName}.uploading` || payload.parents?.[0] !== meta.parents?.[0]) {
    throw new DriveApiError("Payload does not belong to this metadata sidecar", 400);
  }
  const response = await fetch(`${DRIVE_API}/files/${encodeURIComponent(payloadFileId)}?fields=id,name,size,modifiedTime,createdTime`, {
    method: "PATCH",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ name: finalName }),
    cache: "no-store",
  });
  if (!response.ok) throw new DriveApiError(`Drive payload finalization failed (${response.status}): ${await response.text()}`, response.status);
  return response.json();
}

export async function deleteUploadPair(
  accessToken: string,
  metaFileId: string,
  payloadFileId?: string
): Promise<void> {
  const ids = [metaFileId, payloadFileId].filter((id): id is string => Boolean(id));
  await Promise.all(ids.map(async (id) => {
    const response = await fetch(`${DRIVE_API}/files/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders(accessToken), cache: "no-store" });
    if (!response.ok && response.status !== 404) throw new DriveApiError(`Drive upload cleanup failed (${response.status})`, response.status);
  }));
}

async function resolvePayloadFile(
  accessToken: string,
  metaFileId: string
): Promise<{ id: string; name: string }> {
  const metaRes = await driveGet(
    accessToken,
    `/files/${encodeURIComponent(metaFileId)}`,
    { fields: "id,name,parents" }
  );
  const metaFile: { id: string; name: string; parents?: string[] } =
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
  const payloads = await listAll(accessToken, q, "id,name");

  if (payloads.length === 0) {
    throw new Error(`No payload found beside ${metaFile.name}`);
  }
  if (payloads.length > 1) {
    throw new Error(`Multiple payloads found beside ${metaFile.name}`);
  }

  return payloads[0];
}

/**
 * Return the upstream encrypted payload response without buffering it.
 * Payloads live beside their metadata file and use the metadata filename
 * without the final `.meta` suffix (for example, `42.meta` -> `42`).
 */
export async function getPayloadStream(
  accessToken: string,
  metaFileId: string
): Promise<Response> {
  const payloadFile = await resolvePayloadFile(accessToken, metaFileId);
  return driveGet(
    accessToken,
    `/files/${encodeURIComponent(payloadFile.id)}`,
    { alt: "media" }
  );
}

/**
 * Resolve a folderId to a breadcrumb path array.
 * Walks the parents chain up to Drive root (max 10 levels to avoid loops).
 */
export async function getFolderPath(
  accessToken: string,
  folderId: string
): Promise<BreadcrumbItem[]> {
  const crumbs: BreadcrumbItem[] = [];
  let currentId = folderId;
  const MAX_DEPTH = 10;

  for (let i = 0; i < MAX_DEPTH; i++) {
    if (currentId === "root") break;

    const res = await driveGet(accessToken, `/files/${currentId}`, {
      fields: "id,name,parents",
    });
    const file: { id: string; name: string; parents?: string[] } =
      await res.json();

    crumbs.unshift({ id: file.id, name: file.name });

    const parent = file.parents?.[0];
    if (!parent || parent === currentId) break;
    currentId = parent;
  }

  return crumbs;
}
