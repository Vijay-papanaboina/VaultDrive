import { auth } from "@/lib/auth";
import {
  completePayloadUpload,
  createMetaUpload,
  createPayloadUploadSession,
  deleteUploadPair,
  DriveApiError,
} from "@/lib/google-drive";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "@/lib/bounded-request-body";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const MAX_META_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const UPLOAD_SESSION_HEADER = "x-vault-upload-session";

export const runtime = "nodejs";

type UploadRange =
  | { kind: "status"; total: number }
  | { kind: "chunk"; start: number; end: number; total: number };

function safeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseUploadRange(value: string | null): UploadRange | null {
  if (!value) return null;
  const status = /^bytes \*\/(\d+)$/.exec(value);
  if (status) {
    const total = safeInteger(status[1]);
    return total && total > 0 ? { kind: "status", total } : null;
  }
  const chunk = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!chunk) return null;
  const start = safeInteger(chunk[1]);
  const end = safeInteger(chunk[2]);
  const total = safeInteger(chunk[3]);
  if (start === null || end === null || total === null || total <= 0 || start > end || end >= total) return null;
  return { kind: "chunk", start, end, total };
}

function validatedSessionUrl(value: string | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const pathIsValid = /^\/upload\/drive\/v3\/files(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname);
  const uploadTypes = url.searchParams.getAll("uploadType");
  const uploadIds = url.searchParams.getAll("upload_id");
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.googleapis.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !pathIsValid ||
    uploadTypes.length !== 1 ||
    uploadTypes[0] !== "resumable" ||
    uploadIds.length !== 1 ||
    !/^[A-Za-z0-9_-]+$/.test(uploadIds[0])
  ) {
    return null;
  }
  return url.toString();
}

function validReceivedRange(value: string | null, total: number): string | null {
  if (!value) return null;
  const match = /^bytes=0-(\d+)$/.exec(value);
  const end = match ? safeInteger(match[1]) : null;
  return end !== null && end < total ? value : null;
}

function contentLengthFor(request: NextRequest, range: UploadRange): number | null {
  const raw = request.headers.get("content-length");
  if (range.kind === "status") return raw === null || raw === "0" ? 0 : null;
  if (raw === null) return null;
  const length = safeInteger(raw);
  const expected = range.end - range.start + 1;
  if (length === null || length !== expected || length > MAX_UPLOAD_CHUNK_BYTES) return null;
  return length;
}

async function proxyResumableChunk(request: NextRequest, accessToken: string): Promise<NextResponse> {
  const sessionUrl = validatedSessionUrl(request.headers.get(UPLOAD_SESSION_HEADER));
  const range = parseUploadRange(request.headers.get("content-range"));
  if (!sessionUrl || !range) return new NextResponse("Invalid upload chunk", { status: 400 });

  const contentLength = contentLengthFor(request, range);
  if (contentLength === null) return new NextResponse("Invalid upload chunk", { status: 400 });
  if (range.kind === "chunk" && !request.body) return new NextResponse("Invalid upload chunk", { status: 400 });

  const contentRange = range.kind === "status"
    ? `bytes */${range.total}`
    : `bytes ${range.start}-${range.end}/${range.total}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Range": contentRange,
    "Content-Length": String(contentLength),
  };
  if (range.kind === "chunk") headers["Content-Type"] = "application/octet-stream";

  const upstream = await fetch(sessionUrl, {
    method: "PUT",
    headers,
    ...(range.kind === "chunk" ? { body: request.body!, duplex: "half" } : {}),
    cache: "no-store",
  } as RequestInit & { duplex?: "half" });
  const replacementValue = upstream.headers.get("location");
  const replacement = replacementValue === null ? null : validatedSessionUrl(replacementValue);
  if (replacementValue !== null && !replacement) {
    void upstream.body?.cancel().catch(() => undefined);
    return new NextResponse("Drive upload session response was invalid", { status: 502 });
  }

  const responseHeaders = new Headers();
  const receivedRange = validReceivedRange(upstream.headers.get("range"), range.total);
  if (receivedRange) responseHeaders.set("Range", receivedRange);
  if (replacement) responseHeaders.set("Location", replacement);
  void upstream.body?.cancel().catch(() => undefined);
  return new NextResponse(null, { status: upstream.status, headers: responseHeaders });
}

async function accessToken() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const token = await auth.api.getAccessToken({ headers: requestHeaders, body: { providerId: "google" } });
  return token?.accessToken ?? null;
}

function errorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) return new NextResponse("Encrypted metadata is too large", { status: 413 });
  if (error instanceof DriveApiError) return new NextResponse(error.message, { status: error.status });
  console.error("[/api/drive/upload]", error);
  return new NextResponse("Drive upload failed", { status: 500 });
}

export async function POST(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  const token = await accessToken();
  if (!token) return new NextResponse("Unauthorized", { status: 401 });
  const { action } = await context.params;

  try {
    if (action === "chunk") {
      try {
        return await proxyResumableChunk(request, token);
      } catch {
        return new NextResponse("Drive upload relay failed", { status: 502 });
      }
    }
    if (action === "meta") {
      const folderId = request.headers.get("x-vault-folder-id");
      if (!folderId) return new NextResponse("folderId is required", { status: 400 });
      const requestedOpaqueId = request.headers.get("x-vault-opaque-id")?.trim() || undefined;
      const bytes = await readBoundedRequestBody(request, MAX_META_BYTES);
      if (!bytes.byteLength) return new NextResponse("Encrypted metadata is empty", { status: 400 });
      if (bytes.byteLength > MAX_META_BYTES) return new NextResponse("Encrypted metadata is too large", { status: 413 });
      const result = await createMetaUpload(token, folderId, bytes, requestedOpaqueId);
      return NextResponse.json(result);
    }

    const data = await request.json() as Record<string, unknown>;
    if (action === "session") {
      const encryptedSize = data.encryptedSize;
      if (typeof data.metaFileId !== "string" || typeof encryptedSize !== "number" || !Number.isSafeInteger(encryptedSize) || encryptedSize <= 0) {
        return new NextResponse("metaFileId and encryptedSize are required", { status: 400 });
      }
      return NextResponse.json(await createPayloadUploadSession(token, data.metaFileId, encryptedSize));
    }
    if (action === "complete") {
      if (typeof data.metaFileId !== "string" || typeof data.payloadFileId !== "string") {
        return new NextResponse("metaFileId and payloadFileId are required", { status: 400 });
      }
      return NextResponse.json({ file: await completePayloadUpload(token, data.metaFileId, data.payloadFileId) });
    }
    return new NextResponse("Unknown upload action", { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  const token = await accessToken();
  if (!token) return new NextResponse("Unauthorized", { status: 401 });
  const { action } = await context.params;
  if (action !== "cleanup") return new NextResponse("Unknown upload action", { status: 404 });
  try {
    const data = await request.json() as Record<string, unknown>;
    if (
      typeof data.metaFileId !== "string" ||
      (data.payloadFileId !== undefined && typeof data.payloadFileId !== "string")
    ) {
      return new NextResponse("metaFileId is required and payloadFileId must be a string when provided", { status: 400 });
    }
    await deleteUploadPair(token, data.metaFileId, data.payloadFileId as string | undefined);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
