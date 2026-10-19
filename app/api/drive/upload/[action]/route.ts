import { auth } from "@/lib/auth";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "@/lib/bounded-request-body";
import {
  completeMetaUpload,
  completePayloadUpload,
  createMetaUploadSession,
  createPayloadUploadSession,
  deleteUploadPair,
  DriveApiError,
} from "@/lib/google-drive";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const MAX_CONTROL_BODY_BYTES = 8 * 1024;
const MAX_META_BYTES = 25 * 1024 * 1024;
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
  Vary: "Cookie",
};

export const runtime = "nodejs";

function textResponse(message: string, status: number): NextResponse {
  return new NextResponse(message, { status, headers: NO_STORE_HEADERS });
}

function jsonResponse(value: unknown, status = 200): NextResponse {
  return NextResponse.json(value, { status, headers: NO_STORE_HEADERS });
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

async function readJsonObject(request: NextRequest): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new DriveApiError("Upload control requests must use JSON", 415);
  }
  const bytes = await readBoundedRequestBody(request, MAX_CONTROL_BODY_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DriveApiError("Upload control request is invalid", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DriveApiError("Upload control request is invalid", 400);
  }
  return value as Record<string, unknown>;
}

async function accessToken(): Promise<string | null> {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const token = await auth.api.getAccessToken({ headers: requestHeaders, body: { providerId: "google" } });
  return token?.accessToken ?? null;
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof RequestBodyTooLargeError) return textResponse("Upload control request is too large", 413);
  if (error instanceof DriveApiError) {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 500;
    const message = status === 400 ? "Invalid upload request"
      : status === 401 ? "Unauthorized"
        : status === 403 ? "Drive access denied"
          : status === 404 ? "Upload target was not found"
            : status === 409 ? "Upload state conflict"
              : status === 413 ? "Upload request is too large"
                : status === 415 ? "Upload control requests must use JSON"
                  : "Drive upload failed";
    return textResponse(message, status);
  }
  return textResponse("Drive upload failed", 500);
}

export async function POST(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  if (isCrossOrigin(request)) return textResponse("Cross-origin requests are not allowed", 403);
  if (action === "chunk") return textResponse("Upload chunks are sent directly to Google Drive", 410);

  try {
    const token = await accessToken();
    if (!token) return textResponse("Unauthorized", 401);

    const data = await readJsonObject(request);
    if (action === "meta") {
      if (
        typeof data.folderId !== "string" ||
        typeof data.encryptedMetaSize !== "number" ||
        !Number.isSafeInteger(data.encryptedMetaSize) ||
        data.encryptedMetaSize <= 0 ||
        data.encryptedMetaSize > MAX_META_BYTES ||
        (data.opaqueId !== undefined && typeof data.opaqueId !== "string")
      ) {
        return textResponse("folderId and encryptedMetaSize are required", 400);
      }
      return jsonResponse(await createMetaUploadSession(
        token,
        data.folderId,
        data.encryptedMetaSize,
        typeof data.opaqueId === "string" ? data.opaqueId : undefined
      ));
    }
    if (action === "meta-complete") {
      if (typeof data.metaFileId !== "string") return textResponse("metaFileId is required", 400);
      return jsonResponse({ file: await completeMetaUpload(token, data.metaFileId) });
    }
    if (action === "session") {
      const encryptedSize = data.encryptedSize;
      if (typeof data.metaFileId !== "string" || typeof encryptedSize !== "number" || !Number.isSafeInteger(encryptedSize) || encryptedSize <= 0) {
        return textResponse("metaFileId and encryptedSize are required", 400);
      }
      return jsonResponse(await createPayloadUploadSession(token, data.metaFileId, encryptedSize));
    }
    if (action === "complete") {
      if (typeof data.metaFileId !== "string" || typeof data.payloadFileId !== "string") {
        return textResponse("metaFileId and payloadFileId are required", 400);
      }
      return jsonResponse({ file: await completePayloadUpload(token, data.metaFileId, data.payloadFileId) });
    }
    return textResponse("Unknown upload action", 404);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  if (isCrossOrigin(request)) return textResponse("Cross-origin requests are not allowed", 403);
  if (action !== "cleanup") return textResponse("Unknown upload action", 404);

  try {
    const token = await accessToken();
    if (!token) return textResponse("Unauthorized", 401);
    const data = await readJsonObject(request);
    if (
      typeof data.metaFileId !== "string" ||
      (data.payloadFileId !== undefined && typeof data.payloadFileId !== "string")
    ) {
      return textResponse("metaFileId is required and payloadFileId must be a string when provided", 400);
    }
    await deleteUploadPair(token, data.metaFileId, data.payloadFileId as string | undefined);
    return new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}
