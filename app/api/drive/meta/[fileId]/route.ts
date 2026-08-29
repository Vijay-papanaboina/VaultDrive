import { auth } from "@/lib/auth";
import { DriveApiError, getFileContent, updateFileContent } from "@/lib/google-drive";
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

export async function PUT(
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

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/octet-stream")) {
      return new NextResponse("Content-Type must be application/octet-stream", {
        status: 415,
      });
    }

    const content = new Uint8Array(await request.arrayBuffer());
    if (content.byteLength === 0) {
      return new NextResponse("Encrypted metadata content is empty", { status: 400 });
    }
    if (content.byteLength > 25 * 1024 * 1024) {
      return new NextResponse("Encrypted metadata content is too large", { status: 413 });
    }

    const expectedModifiedTime = request.headers.get("if-unmodified-since") ?? undefined;
    const updated = await updateFileContent(
      tokenResult.accessToken,
      fileId,
      content,
      expectedModifiedTime
    );

    return NextResponse.json(
      { file: updated },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[/api/drive/meta/[fileId]] PUT", err);
    if (err instanceof DriveApiError) {
      const message = err.status === 403
        ? "Google Drive write permission is required. Reconnect your Google account."
        : err.message;
      return new NextResponse(message, { status: err.status });
    }
    return new NextResponse("Failed to update metadata file", { status: 500 });
  }
}
