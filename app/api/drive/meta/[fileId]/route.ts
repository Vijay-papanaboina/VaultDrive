import { auth } from "@/lib/auth";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "@/lib/bounded-request-body";
import { DriveApiError, getMetaFileStream, trashVaultFilePair, updateFileContent } from "@/lib/google-drive";
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

    const file = await getMetaFileStream(tokenResult.accessToken, fileId);

    // Return raw encrypted bytes without buffering; the client decrypts them with age-encryption.
    return new NextResponse(file.body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "private, max-age=300", // 5 min client cache; .meta files are small and stable
      },
    });
  } catch (err) {
    console.error("[/api/drive/meta/[fileId]]", err);
    if (err instanceof DriveApiError) return new NextResponse(err.message, { status: err.status });
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

    const content = await readBoundedRequestBody(request, 25 * 1024 * 1024);
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
    if (err instanceof RequestBodyTooLargeError) {
      return new NextResponse("Encrypted metadata content is too large", { status: 413 });
    }
    if (err instanceof DriveApiError) {
      const message = err.status === 403
        ? "Google Drive write permission is required. Reconnect your Google account."
        : err.message;
      return new NextResponse(message, { status: err.status });
    }
    return new NextResponse("Failed to update metadata file", { status: 500 });
  }
}

const DELETE_BODY_LIMIT_BYTES = 4 * 1024;
const DELETE_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
  Vary: "Cookie",
};

function deleteTextResponse(message: string, status: number): NextResponse {
  return new NextResponse(message, { status, headers: DELETE_NO_STORE_HEADERS });
}

function isCrossOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    try {
      if (new URL(origin).origin !== new URL(request.url).origin) return true;
    } catch {
      return true;
    }
  }
  return request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site";
}

function deleteErrorResponse(error: unknown): NextResponse {
  if (error instanceof RequestBodyTooLargeError) {
    return deleteTextResponse("Delete request is too large", 413);
  }
  if (error instanceof DriveApiError) {
    const status = [400, 401, 403, 404, 409, 413, 415, 502].includes(error.status)
      ? error.status
      : 500;
    const message = status === 400 ? "Invalid file deletion request"
      : status === 401 ? "Unauthorized"
        : status === 403 ? "Google Drive write permission is required"
          : status === 404 ? "File pair was not found"
            : status === 409 ? "File pair changed or is ambiguous. Refresh and try again"
              : status === 413 ? "Delete request is too large"
                : status === 415 ? "Delete requests must use JSON"
                  : status === 502 ? "Could not move both files to Trash. Retry; any files already moved can be restored from Google Drive Trash."
                    : "Unable to move file pair to Trash";
    return deleteTextResponse(message, status);
  }
  return deleteTextResponse("Unable to move file pair to Trash", 500);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  if (isCrossOrigin(request)) {
    return deleteTextResponse("Cross-origin requests are not allowed", 403);
  }

  try {
    const { fileId } = await params;
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(fileId)) {
      return deleteTextResponse("Invalid file deletion request", 400);
    }

    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session) return deleteTextResponse("Unauthorized", 401);
    const tokenResult = await auth.api.getAccessToken({
      headers: requestHeaders,
      body: { providerId: "google" },
    });
    if (!tokenResult?.accessToken) return deleteTextResponse("Unauthorized", 401);

    const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return deleteTextResponse("Delete requests must use JSON", 415);
    }
    const bodyBytes = await readBoundedRequestBody(request, DELETE_BODY_LIMIT_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return deleteTextResponse("Invalid file deletion request", 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return deleteTextResponse("Invalid file deletion request", 400);
    }
    const data = body as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(data, "payloadFileId")) {
      return deleteTextResponse("Payload IDs are resolved by the server", 400);
    }
    if (
      typeof data.expectedMetaName !== "string" ||
      data.expectedMetaName.length < 1 ||
      data.expectedMetaName.length > 1024 ||
      typeof data.expectedModifiedTime !== "string" ||
      data.expectedModifiedTime.length < 1 ||
      data.expectedModifiedTime.length > 64 ||
      !Number.isFinite(Date.parse(data.expectedModifiedTime))
    ) {
      return deleteTextResponse("Invalid file deletion request", 400);
    }

    const result = await trashVaultFilePair(tokenResult.accessToken, fileId, {
      expectedMetaName: data.expectedMetaName,
      expectedModifiedTime: data.expectedModifiedTime,
    });
    return NextResponse.json(result, { status: 200, headers: DELETE_NO_STORE_HEADERS });
  } catch (error) {
    return deleteErrorResponse(error);
  }
}
