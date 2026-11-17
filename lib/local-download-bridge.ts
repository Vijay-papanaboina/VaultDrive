"use client";

const BRIDGE_URL = "http://127.0.0.1:47653";
const PAIR_KEY = "vaultdrive.local-helper.v1";
const FOLDER_PATH_KEY = "vaultdrive.vlc-folder.v1";
const PLAY_CONTEXT = "VaultDrive VLC control v2";
const SHA256 = /^[a-f0-9]{64}$/;
const RANDOM_ID = /^[a-f0-9]{32}$/;
const encoder = new TextEncoder();

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function binary(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/../g) ?? [], (part) => parseInt(part, 16));
}

export function randomLocalId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

export function savedPairingCode(): string | null {
  try { return localStorage.getItem(PAIR_KEY); } catch { return null; }
}

export function savePairingCode(code: string): void {
  localStorage.setItem(PAIR_KEY, code);
}

export function forgetPairingCode(): void {
  localStorage.removeItem(PAIR_KEY);
}

export function savedPlaybackDirectory(folderKey: string): string | null {
  try {
    const item = JSON.parse(localStorage.getItem(FOLDER_PATH_KEY) ?? "null");
    return item?.folderKey === folderKey && typeof item.directory === "string" ? item.directory : null;
  } catch { return null; }
}

export function savePlaybackDirectory(folderKey: string, directory: string): void {
  localStorage.setItem(FOLDER_PATH_KEY, JSON.stringify({ folderKey, directory }));
}

export class LocalHelperError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class LocalDownloadBridge {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly key: Promise<CryptoKey>;

  constructor(code: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis), origin = location.origin) {
    if (!SHA256.test(code)) throw new Error("Enter the 64-character pairing code printed by VaultDrive VLC.");
    if (!crypto.subtle) throw new Error("Use HTTPS or localhost to connect to the helper.");
    this.origin = origin;
    this.fetchImpl = fetchImpl;
    this.key = (async () => {
      const bytes = binary(code);
      try {
        const mac = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const derived = new Uint8Array(await crypto.subtle.sign("HMAC", mac, encoder.encode(PLAY_CONTEXT)));
        try {
          return await crypto.subtle.importKey("raw", derived, "AES-GCM", false, ["encrypt"]);
        } finally { derived.fill(0); }
      } finally { bytes.fill(0); }
    })();
  }

  private async send(path: "/v1/play" | "/v1/play/stop", data: unknown, timeout = 15_000) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const clear = encoder.encode(JSON.stringify({ sentAt: Date.now(), data }));
    let ciphertext: string;
    try {
      ciphertext = hex(new Uint8Array(await crypto.subtle.encrypt({
        name: "AES-GCM", iv: nonce, additionalData: encoder.encode(`${this.origin}\nPOST\n${path}`),
      }, await this.key, clear)));
    } finally { clear.fill(0); }
    const signal = AbortSignal.timeout(timeout);
    let response: Response;
    try {
      const init: RequestInit & { targetAddressSpace: "loopback" } = {
        method: "POST",
        // A CORS-safelisted body type avoids an application-level preflight.
        headers: { "Content-Type": "text/plain; charset=UTF-8" },
        body: JSON.stringify({ nonce: hex(nonce), ciphertext }),
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        redirect: "error",
        referrerPolicy: "no-referrer",
        targetAddressSpace: "loopback",
        signal,
      };
      response = await this.fetchImpl(`${BRIDGE_URL}${path}`, init);
    } catch {
      if (signal.aborted) throw new LocalHelperError("The local helper did not respond in time.", 408);
      throw new LocalHelperError("Cannot connect to VaultDrive VLC. Start the helper, check its configured site, and allow loopback access in browser site settings.", 0);
    }
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new LocalHelperError(typeof error?.error === "string" ? error.error : "Local helper request failed.", response.status);
    }
    return response;
  }

  async play(
    identity: string, ids: string[], selected: string, playbackId: string,
    location: { directory?: string; folderKey: string; folderName?: string },
  ): Promise<{ count: number; directory: string }> {
    if (!RANDOM_ID.test(playbackId)) throw new Error("Invalid VLC playback ID.");
    const result = await (await this.send("/v1/play", { identity, ids, selected, playbackId, ...location }, 120_000)).json();
    if (result.playbackId !== playbackId || !Number.isSafeInteger(result.count) || result.count < 1 ||
      typeof result.directory !== "string" || !result.directory.startsWith("/") || result.directory.length > 4096) {
      throw new Error("The helper returned an invalid VLC session.");
    }
    return { count: result.count, directory: result.directory };
  }

  async stopPlayback(playbackId: string): Promise<void> {
    await this.send("/v1/play/stop", { playbackId });
  }
}
