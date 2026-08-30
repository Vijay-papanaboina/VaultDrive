import { auth } from "@/lib/auth";
import {
  completePayloadUpload,
  createMetaUpload,
  createPayloadUploadSession,
  deleteUploadPair,
  DriveApiError,
} from "@/lib/google-drive";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const MAX_META_BYTES = 25 * 1024 * 1024;

async function accessToken() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const token = await auth.api.getAccessToken({ headers: requestHeaders, body: { providerId: "google" } });
  return token?.accessToken ?? null;
}

function errorResponse(error: unknown) {
  if (error instanceof DriveApiError) return new NextResponse(error.message, { status: error.status });
  console.error("[/api/drive/upload]", error);
  return new NextResponse("Drive upload failed", { status: 500 });
}

export async function POST(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  const token = await accessToken();
  if (!token) return new NextResponse("Unauthorized", { status: 401 });
  const { action } = await context.params;

  try {
    if (action === "meta") {
      const folderId = request.headers.get("x-vault-folder-id");
      if (!folderId) return new NextResponse("folderId is required", { status: 400 });
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.byteLength) return new NextResponse("Encrypted metadata is empty", { status: 400 });
      if (bytes.byteLength > MAX_META_BYTES) return new NextResponse("Encrypted metadata is too large", { status: 413 });
      const result = await createMetaUpload(token, folderId, bytes);
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
    if (typeof data.metaFileId !== "string") return new NextResponse("metaFileId is required", { status: 400 });
    await deleteUploadPair(token, data.metaFileId, typeof data.payloadFileId === "string" ? data.payloadFileId : undefined);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
