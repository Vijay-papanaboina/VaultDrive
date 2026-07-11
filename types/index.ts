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
  size: string; // Drive returns size as string
  modifiedTime: string;
}

// Decrypted .meta file content (confirmed schema)
export interface MetaFileContent {
  name: string; // required — original filename
  description?: string; // optional
  date?: string; // optional — ISO string
  thumbnail: string; // required — base64 image
  extra?: Record<string, unknown>; // optional key-value pairs
}

// Combined type used by UI cards
export interface DecryptedMeta {
  driveFile: DriveMetaFile;
  content: MetaFileContent;
  originalFileName: string; // driveFile.name with .meta stripped
}

// Breadcrumb path item
export interface BreadcrumbItem {
  id: string;
  name: string;
}

// Drive API list response
export interface DriveListResponse {
  files: Array<{ id: string; name: string; size?: string; modifiedTime?: string; parents?: string[] }>;
  nextPageToken?: string;
}
