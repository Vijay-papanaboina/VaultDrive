export interface DownloadSettings {
  parallelDownloads: number;
  requestsPerDownload: number;
}

export const DOWNLOAD_SETTINGS_STORAGE_KEY = "vaultdrive.download-settings.v1";
export const DOWNLOAD_SETTINGS_CHANGED_EVENT = "vaultdrive:download-settings-changed";
export const DOWNLOAD_SETTINGS_MIN_VALUE = 1;
export const DOWNLOAD_SETTINGS_MAX_VALUE = 6;

export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = {
  parallelDownloads: 3,
  requestsPerDownload: 4,
};

export function isDownloadSettingValue(value: unknown): value is number {
  return Number.isInteger(value) &&
    (value as number) >= DOWNLOAD_SETTINGS_MIN_VALUE &&
    (value as number) <= DOWNLOAD_SETTINGS_MAX_VALUE;
}

export function parseDownloadSettings(value: unknown): DownloadSettings {
  const fields = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

  return {
    parallelDownloads: isDownloadSettingValue(fields.parallelDownloads)
      ? fields.parallelDownloads
      : DEFAULT_DOWNLOAD_SETTINGS.parallelDownloads,
    requestsPerDownload: isDownloadSettingValue(fields.requestsPerDownload)
      ? fields.requestsPerDownload
      : DEFAULT_DOWNLOAD_SETTINGS.requestsPerDownload,
  };
}

export function readDownloadSettings(): DownloadSettings {
  if (typeof window === "undefined") return { ...DEFAULT_DOWNLOAD_SETTINGS };
  try {
    const stored = window.localStorage.getItem(DOWNLOAD_SETTINGS_STORAGE_KEY);
    return stored === null
      ? { ...DEFAULT_DOWNLOAD_SETTINGS }
      : parseDownloadSettings(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_DOWNLOAD_SETTINGS };
  }
}
