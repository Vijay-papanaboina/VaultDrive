import { auth } from "@/lib/auth";
import { getFolderPath } from "@/lib/google-drive";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const tokenResult = await auth.api.getAccessToken({
      headers: await headers(),
      body: { providerId: "google" },
    });
    if (!tokenResult?.accessToken) {
      return NextResponse.json({ error: "No access token" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const folderId = searchParams.get("folderId");
    if (!folderId) {
      return NextResponse.json({ error: "folderId is required" }, { status: 400 });
    }

    const path = await getFolderPath(tokenResult.accessToken, folderId);
    return NextResponse.json({ path });
  } catch (err) {
    console.error("[/api/drive/path]", err);
    return NextResponse.json(
      { error: "Failed to resolve folder path" },
      { status: 500 }
    );
  }
}
