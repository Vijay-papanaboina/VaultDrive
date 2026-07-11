import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { listFolders, listMetaFiles, getFolderPath } from "@/lib/google-drive";
import { FolderView } from "@/components/folder-view";

interface PageProps {
  params: Promise<{ folderId: string }>;
}

export default async function FolderPage({ params }: PageProps) {
  const { folderId } = await params;

  // Full server-side session check
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/");

  const tokenResult = await auth.api.getAccessToken({
    headers: await headers(),
    body: { providerId: "google" },
  });

  if (!tokenResult?.accessToken) redirect("/");

  const { accessToken } = tokenResult;

  // Fetch folder data in parallel
  const [subFolders, metaFiles, breadcrumbs] = await Promise.all([
    listFolders(accessToken, folderId).catch(() => []),
    listMetaFiles(accessToken, folderId).catch(() => []),
    getFolderPath(accessToken, folderId).catch(() => []),
  ]);

  // If both are empty and no breadcrumbs, folder probably doesn't exist
  if (breadcrumbs.length === 0 && subFolders.length === 0 && metaFiles.length === 0) {
    // Could be an empty folder — don't 404, just show empty state
  }

  const firstMetaFileId = metaFiles[0]?.id ?? null;

  return (
    <FolderView
      folderId={folderId}
      initialFolders={subFolders}
      breadcrumbs={breadcrumbs}
      firstMetaFileId={firstMetaFileId}
    />
  );
}

export async function generateMetadata({ params }: PageProps) {
  const { folderId } = await params;
  return {
    title: `VaultDrive — Folder`,
    description: `Encrypted metadata viewer for folder ${folderId}`,
  };
}
