import { decryptOAuthToken } from "better-auth/oauth2";
import { auth } from "@/lib/auth";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

export class DriveDownloadTokenError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "DriveDownloadTokenError";
  }
}

export interface ReadOnlyDriveToken {
  accessToken: string;
  expiresAt: number;
  scope: string;
}

interface GoogleTokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

/** Issue a short-lived, strictly read-only Google Drive access token. */
export async function issueReadOnlyDriveToken(
  userId: string,
  signal?: AbortSignal
): Promise<ReadOnlyDriveToken> {
  const context = await auth.$context;
  const accounts = await context.internalAdapter.findAccounts(userId);
  const googleAccount = accounts.find((account) => account.providerId === "google");
  if (!googleAccount?.refreshToken) {
    throw new DriveDownloadTokenError("A Google connection is required", 401);
  }

  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) {
    throw new DriveDownloadTokenError("Google download authentication is unavailable", 500);
  }

  let refreshToken: string;
  try {
    refreshToken = await decryptOAuthToken(
      googleAccount.refreshToken,
      context as unknown as Parameters<typeof decryptOAuthToken>[1]
    );
  } catch {
    throw new DriveDownloadTokenError("Google download authentication is unavailable", 500);
  }
  if (!refreshToken) {
    throw new DriveDownloadTokenError("A Google connection is required", 401);
  }

  const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    scope: DRIVE_READONLY_SCOPE,
  });

  let response: Response;
  const requestStartedAt = Date.now();
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      cache: "no-store",
      signal: requestSignal,
    });
  } catch {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    if (timeoutSignal.aborted) {
      throw new DriveDownloadTokenError("Google download authentication timed out", 504);
    }
    throw new DriveDownloadTokenError("Google download authentication failed", 502);
  }

  if (!response.ok) {
    throw new DriveDownloadTokenError("Google download authentication failed", 502);
  }

  let tokenResponse: GoogleTokenResponse;
  try {
    tokenResponse = await response.json() as GoogleTokenResponse;
  } catch {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    if (timeoutSignal.aborted) {
      throw new DriveDownloadTokenError("Google download authentication timed out", 504);
    }
    throw new DriveDownloadTokenError("Google returned an invalid download token", 502);
  }

  const accessToken = tokenResponse.access_token;
  const expiresIn = tokenResponse.expires_in;
  const returnedScope = tokenResponse.scope;
  const scopes = typeof returnedScope === "string" ? returnedScope.trim().split(/\s+/) : [];
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    accessToken.length > 16_384 ||
    /\s/.test(accessToken) ||
    typeof tokenResponse.token_type !== "string" ||
    tokenResponse.token_type.toLowerCase() !== "bearer" ||
    typeof expiresIn !== "number" ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > 86_400 ||
    scopes.length !== 1 ||
    scopes[0] !== DRIVE_READONLY_SCOPE
  ) {
    throw new DriveDownloadTokenError("Google returned an invalid download token", 502);
  }

  const requestLatencyMs = Math.max(0, Date.now() - requestStartedAt);
  const expiresAt = Date.now() + expiresIn * 1000 - requestLatencyMs;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new DriveDownloadTokenError("Google returned an expired download token", 502);
  }

  return {
    accessToken,
    expiresAt,
    scope: DRIVE_READONLY_SCOPE,
  };
}
