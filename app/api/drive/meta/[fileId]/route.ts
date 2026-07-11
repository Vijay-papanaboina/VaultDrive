import { auth } from "@/lib/auth";
import { getFileContent } from "@/lib/google-drive";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const tokenResult = await auth.api.getAccessToken({
      headers: await headers(),
      body: { providerId: "google" },
    });
    if (!tokenResult?.accessToken) {
      return new NextResponse("No access token", { status: 401 });
    }

    const { fileId } = await params;
    if (!fileId) {
      return new NextResponse("fileId is required", { status: 400 });
    }

    const bytes = await getFileContent(tokenResult.accessToken, fileId);

    // Return raw bytes — client will decrypt with age-encryption
    // Pass the underlying ArrayBuffer (valid BodyInit), not Uint8Array
    return new NextResponse(bytes.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "private, max-age=300", // 5 min client cache — .meta files are small & stable
      },
    });
  } catch (err) {
    console.error("[/api/drive/meta/[fileId]]", err);
    return new NextResponse("Failed to fetch file", { status: 500 });
  }
}
