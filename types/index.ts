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
 * Fully decrypted and extracted .meta file ready for display.
 */
export interface DecryptedMeta {
  driveFile: DriveMetaFile;
  details: MetaDetails;
  thumbnailUrl: string;                // blob URL — must be revoked on unmount
  originalFileName: string;            // driveFile.name with .meta stripped
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
