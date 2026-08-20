import { auth } from "@/lib/auth";
import { getPayloadStream } from "@/lib/google-drive";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ metaFileId: string }> }
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

    const { metaFileId } = await params;
    if (!metaFileId) {
      return new NextResponse("metaFileId is required", { status: 400 });
    }

    const upstream = await getPayloadStream(tokenResult.accessToken, metaFileId);
    if (!upstream.body) {
      throw new Error("Google Drive returned an empty payload stream");
    }

    const responseHeaders = new Headers({
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, no-store",
    });
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) responseHeaders.set("Content-Length", contentLength);

    return new NextResponse(upstream.body, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error("[/api/drive/payload/[metaFileId]]", err);
    return new NextResponse(
      err instanceof Error ? err.message : "Failed to fetch payload",
      { status: 500 }
    );
  }
}
