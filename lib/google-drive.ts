import type { DriveFolder, DriveMetaFile, BreadcrumbItem, DriveListResponse } from "@/types";

const DRIVE_API = "https://www.googleapis.com/drive/v3";

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
