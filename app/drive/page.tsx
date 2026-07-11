import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { listFolders } from "@/lib/google-drive";
import { FolderList } from "@/components/folder-list";
import { Folder } from "lucide-react";

export default async function DriveRootPage() {
  // Full server-side session check
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/");

  const tokenResult = await auth.api.getAccessToken({
    headers: await headers(),
    body: { providerId: "google" },
  });

  if (!tokenResult?.accessToken) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-destructive">
          Could not get Drive access. Please sign in again.
        </p>
      </div>
    );
  }

  const folders = await listFolders(tokenResult.accessToken, "root");

  return (
    <div className="flex flex-col gap-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/5">
          <Folder className="h-4.5 w-4.5 text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">My Drive</h1>
          <p className="text-sm text-muted-foreground">
            {folders.length} folder{folders.length !== 1 ? "s" : ""} · Click a
            folder to browse encrypted metadata
          </p>
        </div>
      </div>

      {/* Folder grid */}
      <FolderList folders={folders} />

      {folders.length === 0 && (
        <div className="rounded-xl border border-white/8 bg-white/3 py-16 text-center">
          <p className="text-muted-foreground">
            No folders found in your Drive root.
          </p>
        </div>
      )}
    </div>
  );
}
