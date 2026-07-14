// Drive folder item
export interface DriveFolder {
  id: string;
  name: string;
  parents?: string[];
  modifiedTime?: string;
}

// Drive .meta file item
export interface DriveMetaFile {
  id: string;
  name: string; // e.g. "backup.enc.meta"
  size: string;
  modifiedTime: string;
  createdTime?: string;
}

/**
 * Parsed contents of details.json inside the .meta zip.
 * No thumbnail here — it's a separate file (thumbnail.webp/.jpg/.png etc.)
 */
export interface MetaDetails {
  name: string;                        // required — original filename
  description?: string;                // optional
  date?: string;                       // optional — ISO string
  extra?: Record<string, unknown>;     // optional — any key-value pairs
}

/**
 * A single file in progressive loading state.
 * Created immediately when the Drive list is received (decrypted: false),
 * then updated in-place as each batch of 5 finishes decrypting.
 */
export interface ProgressiveMetaFile {
  driveFile: DriveMetaFile;
  originalFileName: string;
  decrypted: boolean;
  details?: MetaDetails;
  thumbnailBytes?: Uint8Array | null;
  thumbnailMimeType?: string | null;
  decryptError?: string; // per-file error when this specific file fails
}

/**
 * Fully decrypted meta — used for the detail modal.
 * Narrowed from ProgressiveMetaFile where decrypted === true.
 */
export interface DecryptedMeta {
  driveFile: DriveMetaFile;
  details: MetaDetails;
  thumbnailBytes: Uint8Array | null;
  thumbnailMimeType: string | null;
  originalFileName: string;
}

// Breadcrumb path item
export interface BreadcrumbItem {
  id: string;
  name: string;
}

// Drive API list response
export interface DriveListResponse {
  files: Array<{
    id: string;
    name: string;
    size?: string;
    modifiedTime?: string;
    parents?: string[];
  }>;
  nextPageToken?: string;
}
