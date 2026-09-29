import { auth } from "@/lib/auth";
import { DriveApiError, getPayloadStream } from "@/lib/google-drive";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

const MAX_RANGE_BYTES = 4 * 1024 * 1024;

function parsePayloadRange(rangeHeader: string | null): string | null | undefined {
  if (rangeHeader === null) return undefined;

  const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
  if (!match) return null;

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    end - start + 1 > MAX_RANGE_BYTES
  ) {
    return null;
  }

  return rangeHeader;
}

export async function GET(
  request: Request,
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

    const range = parsePayloadRange(request.headers.get("range"));
    if (range === null) {
      return new NextResponse("Invalid payload byte range", {
        status: 416,
        headers: { "Accept-Ranges": "bytes" },
      });
    }

    const upstream = await getPayloadStream(tokenResult.accessToken, metaFileId, range);
    if (!upstream.body) {
      throw new Error("Google Drive returned an empty payload stream");
    }

    const responseHeaders = new Headers({
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, no-store",
      "Accept-Ranges": "bytes",
    });
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) responseHeaders.set("Content-Length", contentLength);

    if (range) {
      const contentRange = upstream.headers.get("content-range");
      if (upstream.status !== 206 || !contentRange || !contentLength) {
        return new NextResponse("Drive did not provide a valid byte-range response", {
          status: 502,
        });
      }
      responseHeaders.set("Content-Range", contentRange);
    }

    return new NextResponse(upstream.body, {
      status: range ? 206 : 200,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error("[/api/drive/payload/[metaFileId]]", err);
    if (err instanceof DriveApiError && err.status === 416) {
      return new NextResponse("Payload byte range is outside the encrypted file", {
        status: 416,
        headers: { "Accept-Ranges": "bytes" },
      });
    }
    return new NextResponse(
      err instanceof Error ? err.message : "Failed to fetch payload",
      { status: 500 }
    );
  }
}
