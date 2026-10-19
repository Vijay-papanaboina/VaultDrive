"use client";

const READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const META_FILE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const PAYLOAD_FILE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_RANGE_BYTES = 4 * 1024 * 1024;
const MAX_RESOURCE_KEY_LENGTH = 2048;
const SESSION_RENEWAL_WINDOW_MS = 30_000;
const AUTH_RETRY_STATUSES = new Set([401, 403, 404, 410]);

export interface DirectPayloadRange {
  start: number;
  end: number;
}

export interface DirectPayloadSession {
  downloadUri: string;
  partialDownloadAllowed: boolean;
  payloadFileId: string;
  encryptedSize: number;
  resourceKey?: string;
  accessToken: string;
  scope: string;
  expiresAt: number;
}

export interface DirectPayloadSourceOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface DirectPayloadSource {
  fetch(range?: DirectPayloadRange, signal?: AbortSignal): Promise<Response>;
  close(): void;
}

export class PayloadTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTransportError";
  }
}

function abortError(): DOMException {
  return new DOMException("Download cancelled", "AbortError");
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is being discarded already.
  }
}

function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      cleanup();
      if (signal.aborted) reject(abortError());
      else resolve(value);
    }, (error: unknown) => {
      cleanup();
      reject(error);
    });
    if (signal.aborted) onAbort();
  });
}

function validateDownloadUri(value: unknown, payloadFileId: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) {
    throw new Error("The direct download session is invalid.");
  }

  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error("The direct download session is invalid.");
  }

  const hostname = uri.hostname.toLowerCase();
  const isGoogleApiHost = hostname === "www.googleapis.com";
  const isGoogleUserContentHost = hostname === "googleusercontent.com" || hostname.endsWith(".googleusercontent.com");
  const expectedFilePath = `/drive/v3/files/${encodeURIComponent(payloadFileId)}`;
  const hasOAuthQuery = Array.from(uri.searchParams.keys()).some((key) =>
    /^(access_token|oauth_token|refresh_token|id_token)$/i.test(key)
  );

  if (
    uri.protocol !== "https:" ||
    (!isGoogleApiHost && !isGoogleUserContentHost) ||
    (isGoogleApiHost && uri.pathname !== expectedFilePath) ||
    uri.username !== "" ||
    uri.password !== "" ||
    uri.port !== "" ||
    uri.hash !== "" ||
    hasOAuthQuery
  ) {
    throw new Error("The direct download session is invalid.");
  }

  return uri.toString();
}

function parseSession(value: unknown): DirectPayloadSession {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The direct download session is invalid.");
  }
  const session = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "downloadUri",
    "partialDownloadAllowed",
    "payloadFileId",
    "encryptedSize",
    "resourceKey",
    "accessToken",
    "scope",
    "expiresAt",
  ]);
  const keys = Object.keys(session);
  if (keys.some((key) => !allowedKeys.has(key))) {
    throw new Error("The direct download session is invalid.");
  }

  const payloadFileId = session.payloadFileId;
  const encryptedSize = session.encryptedSize;
  const accessToken = session.accessToken;
  const expiresAt = session.expiresAt;
  if (
    typeof payloadFileId !== "string" ||
    !PAYLOAD_FILE_ID.test(payloadFileId) ||
    typeof encryptedSize !== "number" ||
    !Number.isSafeInteger(encryptedSize) ||
    encryptedSize <= 0 ||
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    accessToken.length > 16_384 ||
    /\s/.test(accessToken) ||
    session.scope !== READONLY_SCOPE ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    typeof session.partialDownloadAllowed !== "boolean"
  ) {
    throw new Error("The direct download session is invalid.");
  }

  if (
    session.resourceKey !== undefined &&
    (typeof session.resourceKey !== "string" ||
      session.resourceKey.length === 0 ||
      session.resourceKey.length > MAX_RESOURCE_KEY_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(session.resourceKey))
  ) {
    throw new Error("The direct download session is invalid.");
  }

  if (typeof session.downloadUri !== "string") {
    throw new Error("The direct download session is invalid.");
  }

  return {
    downloadUri: validateDownloadUri(session.downloadUri, payloadFileId),
    partialDownloadAllowed: session.partialDownloadAllowed,
    payloadFileId,
    encryptedSize,
    ...(session.resourceKey ? { resourceKey: session.resourceKey } : {}),
    accessToken,
    scope: READONLY_SCOPE,
    expiresAt,
  };
}

function validateRange(range: DirectPayloadRange | undefined): DirectPayloadRange | undefined {
  if (range === undefined) return undefined;
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end - range.start + 1 > MAX_RANGE_BYTES
  ) {
    throw new Error("The requested payload range is invalid.");
  }
  return range;
}

function rangeLengthHeader(response: Response): number {
  const value = response.headers.get("Content-Length");
  if (!value || !/^\d+$/.test(value)) {
    throw new Error("Google Drive returned an invalid payload range.");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new Error("Google Drive returned an invalid payload range.");
  }
  return length;
}

function validateReadableContentRange(
  value: string,
  range: DirectPayloadRange,
  expectedEnd: number,
  total: number
): void {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!match) throw new Error("Google Drive returned an invalid payload range.");
  const start = Number(match[1]);
  const end = Number(match[2]);
  const contentTotal = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(contentTotal) ||
    start !== range.start ||
    end !== expectedEnd ||
    contentTotal !== total
  ) {
    throw new Error("Google Drive returned an invalid payload range.");
  }
}

function abortAwareSignal(lifetimeSignal: AbortSignal, callerSignal?: AbortSignal): AbortSignal {
  return callerSignal ? AbortSignal.any([lifetimeSignal, callerSignal]) : lifetimeSignal;
}

function sessionError(status: number): Error {
  if (status === 401) return new Error("Sign in again to create a direct download session.");
  if (status === 403) return new Error("Google Drive access is required to download this file.");
  if (status === 408 || status === 429 || status >= 500) {
    return new PayloadTransportError(status === 504 ? "Creating the direct download session timed out." : "Could not create a direct download session.");
  }
  return new Error("Could not create a direct download session.");
}

function googleResponseError(status: number): Error {
  if (status === 408 || status === 429 || status >= 500) {
    return new PayloadTransportError(`Google Drive download failed (HTTP ${status}).`);
  }
  if (AUTH_RETRY_STATUSES.has(status)) {
    return new Error("Direct Drive authorization failed. Reconnect your Google account and try again.");
  }
  return new Error(`Google Drive download failed (HTTP ${status}).`);
}

export function createDirectPayloadSource(
  metaFileId: string,
  { signal: parentSignal, fetchImpl = fetch }: DirectPayloadSourceOptions = {}
): DirectPayloadSource {
  if (!META_FILE_ID.test(metaFileId)) {
    throw new Error("The requested payload is invalid.");
  }

  const lifetimeController = new AbortController();
  const lifetimeSignal = parentSignal
    ? AbortSignal.any([lifetimeController.signal, parentSignal])
    : lifetimeController.signal;
  let closed = false;
  let session: DirectPayloadSession | null = null;
  let pendingSession: Promise<DirectPayloadSession> | null = null;
  let pinnedPayloadFileId: string | null = null;
  let pinnedEncryptedSize: number | null = null;

  const clear = () => {
    session = null;
    pendingSession = null;
    pinnedPayloadFileId = null;
    pinnedEncryptedSize = null;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    lifetimeController.abort();
    parentSignal?.removeEventListener("abort", close);
    clear();
  };

  const assertOpen = () => {
    if (closed || lifetimeSignal.aborted) throw abortError();
  };

  const startSessionRequest = (): Promise<DirectPayloadSession> => {
    assertOpen();
    if (pendingSession) return pendingSession;

    const pending = (async () => {
      let response: Response;
      try {
        response = await fetchImpl(`/api/drive/payload/${encodeURIComponent(metaFileId)}`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          signal: lifetimeSignal,
        });
      } catch {
        if (closed || lifetimeSignal.aborted) throw abortError();
        throw new PayloadTransportError("Could not create a direct download session.");
      }
      if (closed || lifetimeSignal.aborted) {
        await discardBody(response);
        throw abortError();
      }
      if (!response.ok) {
        await discardBody(response);
        throw sessionError(response.status);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        if (closed || lifetimeSignal.aborted) throw abortError();
        throw new Error("The direct download session response is invalid.");
      }
      const nextSession = parseSession(body);
      if (closed || lifetimeSignal.aborted) throw abortError();
      if (
        (pinnedPayloadFileId !== null && nextSession.payloadFileId !== pinnedPayloadFileId) ||
        (pinnedEncryptedSize !== null && nextSession.encryptedSize !== pinnedEncryptedSize)
      ) {
        throw new Error("The encrypted payload changed while downloading. Start the download again.");
      }

      pinnedPayloadFileId ??= nextSession.payloadFileId;
      pinnedEncryptedSize ??= nextSession.encryptedSize;
      session = nextSession;
      return nextSession;
    })();

    pendingSession = pending;
    const clearPending = () => {
      if (pendingSession === pending) pendingSession = null;
    };
    void pending.then(clearPending, clearPending);
    return pending;
  };

  const getSession = (callerSignal?: AbortSignal): Promise<DirectPayloadSession> => {
    assertOpen();
    if (pendingSession) return waitForCaller(pendingSession, callerSignal);
    if (session && session.expiresAt - Date.now() > SESSION_RENEWAL_WINDOW_MS) {
      return waitForCaller(Promise.resolve(session), callerSignal);
    }
    return waitForCaller(startSessionRequest(), callerSignal);
  };

  const refreshAfterAuthorizationFailure = (
    staleSession: DirectPayloadSession,
    callerSignal?: AbortSignal
  ): Promise<DirectPayloadSession> => {
    assertOpen();
    if (session && session !== staleSession && session.expiresAt > Date.now()) {
      return waitForCaller(Promise.resolve(session), callerSignal);
    }
    return waitForCaller(startSessionRequest(), callerSignal);
  };

  const performFetch = async (
    currentSession: DirectPayloadSession,
    range: DirectPayloadRange | undefined,
    callerSignal?: AbortSignal
  ): Promise<Response> => {
    assertOpen();
    if (callerSignal?.aborted) throw abortError();
    if (range) {
      if (!currentSession.partialDownloadAllowed) {
        throw new Error("Google Drive does not allow partial downloads for this file.");
      }
      if (range.start >= currentSession.encryptedSize) {
        throw new Error("The requested payload range is outside the encrypted file.");
      }
    }

    const headers = new Headers({ Authorization: `Bearer ${currentSession.accessToken}` });
    if (currentSession.resourceKey) {
      headers.set("X-Goog-Drive-Resource-Keys", `${currentSession.payloadFileId}/${currentSession.resourceKey}`);
    }
    if (range) headers.set("Range", `bytes=${range.start}-${range.end}`);

    let response: Response;
    try {
      response = await fetchImpl(currentSession.downloadUri, {
        headers,
        credentials: "omit",
        mode: "cors",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        redirect: "error",
        signal: abortAwareSignal(lifetimeSignal, callerSignal),
      });
    } catch {
      if (callerSignal?.aborted || closed || lifetimeSignal.aborted) throw abortError();
      throw new PayloadTransportError("Could not connect to Google Drive to download this file.");
    }

    if (callerSignal?.aborted || closed || lifetimeSignal.aborted) {
      await discardBody(response);
      throw abortError();
    }
    return response;
  };

  const fetchPayload = async (
    requestedRange?: DirectPayloadRange,
    callerSignal?: AbortSignal
  ): Promise<Response> => {
    const range = validateRange(requestedRange);
    assertOpen();
    if (callerSignal?.aborted) throw abortError();

    let currentSession = await getSession(callerSignal);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (callerSignal?.aborted) throw abortError();
      let response = await performFetch(currentSession, range, callerSignal);
      if (AUTH_RETRY_STATUSES.has(response.status)) {
        await discardBody(response);
        if (attempt > 0) throw googleResponseError(response.status);
        currentSession = await refreshAfterAuthorizationFailure(currentSession, callerSignal);
        continue;
      }

      if (range) {
        const expectedEnd = Math.min(range.end, currentSession.encryptedSize - 1);
        const expectedLength = expectedEnd - range.start + 1;
        if (response.status !== 206 || !response.body) {
          const status = response.status;
          await discardBody(response);
          throw response.status !== 206
            ? googleResponseError(status)
            : new Error("Google Drive returned an empty payload range.");
        }

        let contentLength: number;
        try {
          contentLength = rangeLengthHeader(response);
          if (contentLength !== expectedLength) throw new Error("Google Drive returned an invalid payload range.");
          const contentRange = response.headers.get("Content-Range");
          if (contentRange !== null) {
            validateReadableContentRange(contentRange, range, expectedEnd, currentSession.encryptedSize);
          }
        } catch (error) {
          await discardBody(response);
          throw error;
        }

        if (response.headers.get("Content-Range") === null) {
          const headers = new Headers(response.headers);
          headers.set("Content-Range", `bytes ${range.start}-${expectedEnd}/${currentSession.encryptedSize}`);
          response = new Response(response.body, {
            status: 206,
            statusText: response.statusText,
            headers,
          });
        }
        return response;
      }

      if (response.status !== 200 || !response.body) {
        const status = response.status;
        await discardBody(response);
        throw response.status !== 200
          ? googleResponseError(status)
          : new Error("Google Drive returned an empty payload.");
      }
      const contentLength = response.headers.get("Content-Length");
      if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== currentSession.encryptedSize)) {
        await discardBody(response);
        throw new Error("Google Drive returned an invalid encrypted payload size.");
      }
      return response;
    }

    throw new Error("Direct Drive authorization failed. Reconnect your Google account and try again.");
  };

  if (parentSignal?.aborted) close();
  else parentSignal?.addEventListener("abort", close, { once: true });

  return {
    fetch: fetchPayload,
    close,
  };
}
