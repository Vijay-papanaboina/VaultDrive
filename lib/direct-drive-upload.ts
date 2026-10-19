"use client";

export const DRIVE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

type ParsedContentRange =
  | { kind: "status"; total: number }
  | { kind: "chunk"; start: number; end: number; total: number };

function safeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function validateDriveUploadSessionUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Drive returned an invalid resumable upload URL.");
  }

  const pathIsValid = /^\/upload\/drive\/v3\/files(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname);
  const uploadTypes = url.searchParams.getAll("uploadType");
  const uploadIds = url.searchParams.getAll("upload_id");
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.googleapis.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !pathIsValid ||
    uploadTypes.length !== 1 ||
    uploadTypes[0] !== "resumable" ||
    uploadIds.length !== 1 ||
    !/^[A-Za-z0-9_-]+$/.test(uploadIds[0])
  ) {
    throw new Error("Drive returned an invalid resumable upload URL.");
  }

  return url.toString();
}

function parseContentRange(value: string, body: ArrayBuffer | undefined): ParsedContentRange {
  const status = /^bytes \*\/(\d+)$/.exec(value);
  if (status) {
    const total = safeInteger(status[1]);
    if (total === null || total <= 0 || !(body instanceof ArrayBuffer) || body.byteLength !== 0) {
      throw new Error("The Drive upload status request is invalid.");
    }
    return { kind: "status", total };
  }

  const chunk = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!chunk || !(body instanceof ArrayBuffer)) {
    throw new Error("The Drive upload chunk is invalid.");
  }
  const start = safeInteger(chunk[1]);
  const end = safeInteger(chunk[2]);
  const total = safeInteger(chunk[3]);
  if (
    start === null ||
    end === null ||
    total === null ||
    total <= 0 ||
    start > end ||
    end >= total ||
    end - start + 1 > DRIVE_UPLOAD_CHUNK_BYTES ||
    body.byteLength !== end - start + 1
  ) {
    throw new Error("The Drive upload chunk is invalid.");
  }
  return { kind: "chunk", start, end, total };
}

export async function directResumableUpload(
  sessionUrl: string,
  contentRange: string,
  body: ArrayBuffer | undefined,
  signal: AbortSignal
): Promise<Response> {
  const validatedUrl = validateDriveUploadSessionUrl(sessionUrl);
  const parsedRange = parseContentRange(
    contentRange,
    contentRange.startsWith("bytes */") ? body ?? new ArrayBuffer(0) : body
  );
  const requestBody = parsedRange.kind === "status" ? new ArrayBuffer(0) : body;

  const response = await fetch(validatedUrl, {
    method: "PUT",
    headers: {
      "Content-Range": contentRange,
      "Content-Type": "application/octet-stream",
      // Google otherwise uses a redirect status for incomplete uploads.
      "X-GUploader-No-308": "yes",
    },
    ...(requestBody === undefined ? {} : { body: requestBody }),
    credentials: "omit",
    mode: "cors",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    redirect: "error",
    signal,
  });
  const override = response.headers.get("X-HTTP-Status-Code-Override");
  if (override !== null) {
    if (response.status !== 200 || override !== "308") {
      await response.body?.cancel();
      throw new Error("Google Drive returned an invalid upload status.");
    }
    return new Response(response.body, {
      status: 308,
      headers: response.headers,
    });
  }
  return response;
}
