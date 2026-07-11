import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { FolderView } from "@/components/folder-view";

interface PageProps {
  params: Promise<{ folderId: string }>;
}

export default async function FolderPage({ params }: PageProps) {
  const { folderId } = await params;

  // Full server-side session check
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/");

  return (
    <FolderView folderId={folderId} />
  );
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { folderId } = await params;
  return {
    title: `VaultDrive — Folder`,
    description: `Encrypted metadata viewer for folder ${folderId}`,
  };
}
