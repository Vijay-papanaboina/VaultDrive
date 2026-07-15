import type { BreadcrumbItem, DriveFolder, DriveMetaFile } from "@/types";

export async function fetchSubfolders(parentId: string): Promise<DriveFolder[]> {
  const params = new URLSearchParams({ parentId });
  const res = await fetch(`/api/drive/folders?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch folders");
  const data = await res.json();
  return data.folders as DriveFolder[];
}

export async function fetchBreadcrumbs(folderId: string): Promise<BreadcrumbItem[]> {
  const params = new URLSearchParams({ folderId });
  const res = await fetch(`/api/drive/path?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch breadcrumbs");
  const data = await res.json();
  return data.path as BreadcrumbItem[];
}

export async function fetchMetaList(folderId: string): Promise<DriveMetaFile[]> {
  const res = await fetch(`/api/drive/meta?folderId=${folderId}`);
  if (!res.ok) throw new Error(`Failed to list meta files: HTTP ${res.status}`);
  const data = await res.json();
  return data.files as DriveMetaFile[];
}
