import { auth } from "@/lib/auth";
import { createPayloadDownloadSession, DriveApiError } from "@/lib/google-drive";
import { DriveDownloadTokenError, issueReadOnlyDriveToken } from "@/lib/drive-download-token";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const META_FILE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const NO_CACHE_HEADERS = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
  Vary: "Cookie",
};

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, {
    status,
    headers: NO_CACHE_HEADERS,
  });
}

function isSameOriginRequest(request: Request): boolean {
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function safeErrorStatus(error: unknown): number {
  const status = error instanceof DriveApiError || error instanceof DriveDownloadTokenError
    ? error.status
    : 500;
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function safeErrorMessage(status: number): string {
  if (status === 400) return "Invalid download request.";
  if (status === 401) return "Authentication required.";
  if (status === 403) return "Download session request is not allowed.";
  if (status === 404) return "Download target was not found.";
  if (status === 504) return "Download session timed out.";
  return "Failed to create download session.";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ metaFileId: string }> }
) {
  if (!isSameOriginRequest(request)) {
    return errorResponse("Download session request is not allowed.", 403);
  }

  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return errorResponse("Authentication required.", 401);

    const { metaFileId } = await params;
    if (!META_FILE_ID.test(metaFileId)) {
      return errorResponse("Invalid download request.", 400);
    }

    const token = await issueReadOnlyDriveToken(session.user.id, request.signal);
    const downloadSession = await createPayloadDownloadSession(
      token.accessToken,
      metaFileId,
      request.signal
    );

    return NextResponse.json({
      ...downloadSession,
      accessToken: token.accessToken,
      scope: token.scope,
      expiresAt: token.expiresAt,
    }, {
      headers: NO_CACHE_HEADERS,
    });
  } catch (error) {
    if (request.signal.aborted) {
      return errorResponse("Request aborted.", 499);
    }
    const status = safeErrorStatus(error);
    return errorResponse(safeErrorMessage(status), status);
  }
}

export async function GET() {
  return new NextResponse("Use POST to create a direct download session.", {
    status: 405,
    headers: {
      ...NO_CACHE_HEADERS,
      Allow: "POST",
    },
  });
}
