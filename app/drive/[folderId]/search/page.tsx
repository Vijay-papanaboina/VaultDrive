import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SearchView } from "@/components/search-view";

interface PageProps {
  params: Promise<{ folderId: string }>;
}

export default async function SearchPage({ params }: PageProps) {
  const { folderId } = await params;

  // Full server-side session check
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/");

  return (
    <SearchView folderId={folderId} />
  );
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { folderId } = await params;
  return {
    title: `VaultDrive — Search`,
    description: `Recursive metadata search viewer for folder ${folderId}`,
  };
}
