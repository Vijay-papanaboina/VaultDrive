import type { BreadcrumbItem, DriveFolder, DriveMetaFile } from "@/types";

export async function fetchSubfolders(parentId: string, bypassCache = false): Promise<DriveFolder[]> {
  const params = new URLSearchParams({ parentId });
  const res = await fetch(
    `/api/drive/folders?${params.toString()}`,
    bypassCache ? { cache: "no-store" } : undefined
  );
  if (!res.ok) throw new Error("Failed to fetch folders");
  const data = await res.json();
  return data.folders as DriveFolder[];
}

export async function fetchBreadcrumbs(folderId: string, bypassCache = false): Promise<BreadcrumbItem[]> {
  const params = new URLSearchParams({ folderId });
  const res = await fetch(
    `/api/drive/path?${params.toString()}`,
    bypassCache ? { cache: "no-store" } : undefined
  );
  if (!res.ok) throw new Error("Failed to fetch breadcrumbs");
  const data = await res.json();
  return data.path as BreadcrumbItem[];
}

export async function fetchMetaList(folderId: string, bypassCache = false): Promise<DriveMetaFile[]> {
  const res = await fetch(
    `/api/drive/meta?folderId=${folderId}`,
    bypassCache ? { cache: "no-store" } : undefined
  );
  if (!res.ok) throw new Error(`Failed to list meta files: HTTP ${res.status}`);
  const data = await res.json();
  return data.files as DriveMetaFile[];
}

export async function updateMetaFile(
  fileId: string,
  encryptedBytes: Uint8Array,
  expectedModifiedTime?: string
): Promise<DriveMetaFile> {
  const headers: HeadersInit = {
    "Content-Type": "application/octet-stream",
  };
  if (expectedModifiedTime) {
    headers["If-Unmodified-Since"] = expectedModifiedTime;
  }

  const res = await fetch(`/api/drive/meta/${encodeURIComponent(fileId)}`, {
    method: "PUT",
    headers,
    body: encryptedBytes.buffer as ArrayBuffer,
    cache: "no-store",
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(message || `Failed to update metadata file: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.file as DriveMetaFile;
}
