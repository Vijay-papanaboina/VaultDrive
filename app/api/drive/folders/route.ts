import { auth } from "@/lib/auth";
import { listFolders } from "@/lib/google-drive";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    // Validate session server-side
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get a fresh (auto-refreshed) access token
    const tokenResult = await auth.api.getAccessToken({
      headers: await headers(),
      body: { providerId: "google" },
    });
    if (!tokenResult?.accessToken) {
      return NextResponse.json({ error: "No access token" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const parentId = searchParams.get("parentId") ?? "root";

    const folders = await listFolders(tokenResult.accessToken, parentId);
    return NextResponse.json({ folders });
  } catch (err) {
    console.error("[/api/drive/folders]", err);
    return NextResponse.json(
      { error: "Failed to list folders" },
      { status: 500 }
    );
  }
}
