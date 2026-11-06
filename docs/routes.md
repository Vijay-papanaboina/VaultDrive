# Routes and Components

The Encrypted GDrive project uses the Next.js App Router. Authenticated routes handle folder and metadata operations and create small JSON upload/download sessions. Original encrypted payload downloads, preview Range reads, and resumable upload chunks then move directly between the browser and Google Drive.

## Page Routes

- `/app/layout.tsx`: Root layout that includes global providers (Base UI, Better Auth Session, React Query, and CryptoProvider).
- `/app/page.tsx`: The landing page which handles initial authentication (Google OAuth login via Better Auth) and redirects logged-in users to `/drive`.
- `/app/drive/page.tsx`: The root Drive interface, showing the top-level folders in the user's Google Drive via `FolderList`.
- `/app/drive/[folderId]/page.tsx`: The folder browser page that mounts `FolderView` to fetch, decrypt, and display `.meta` items in a specific directory.
- `/app/drive/[folderId]/search/page.tsx`: Recursive search page that mounts `SearchView` to recursively fetch, decrypt, and display all files under a selected folder and its subdirectories.

## API Routes (Auth, Control, and Metadata)

Better Auth stores application sessions and OAuth credentials in PostgreSQL through the `pg` pool. Google refresh and write credentials remain server-side. For payload reads, the server requests a separate token with exactly the `drive.readonly` scope and returns it only with a validated JSON download session. Browser-facing Better Auth access-token and refresh-token paths are disabled, while server-side auth APIs remain available.

- `/api/auth/[...all]/route.ts`: Better Auth endpoints managing Google OAuth, session cookies, and PostgreSQL connections. HTTP access-token and refresh-token paths are disabled.
- `/api/drive/folders/route.ts`: Proxies requests to `lib/google-drive.ts` (`listFolders`). Queries the Google Drive API for folder structures within a specified parent ID.
- `/api/drive/meta/route.ts`: Queries the list of `.meta` files inside a given parent folder and hides incomplete metadata uploads.
- `/api/drive/meta/[fileId]/route.ts`: `GET` fetches bounded encrypted `.meta` bytes. `PUT` remains a separate bounded proxy operation that accepts an already encrypted `application/octet-stream` body and replaces only that Drive file's content after checking the optional `If-Unmodified-Since` value. `DELETE` moves the verified `.meta` and original pair to recoverable Google Drive Trash after explicit confirmation; clearing transfer history does not delete Drive files.
- `/api/drive/payload/[metaFileId]/route.ts`: Authenticated `POST` resolves the securely paired payload and creates a Google `files.download` operation. It polls pending operations server-side and returns JSON with a validated `downloadUri`, encrypted size, resource key when present, and a short-lived `drive.readonly` token. The browser sends the resource key on direct Google requests when present. The route never fetches or relays payload bytes. `GET` returns 405, with no proxy fallback.
- `/api/drive/path/route.ts`: Resolves folder path lineage by walking up the parent tree in Google Drive, returning breadcrumb data.

## Shared Client Utilities

Several client-side helpers are now shared across both the normal folder view and recursive search view:

- `lib/drive-client.ts`: Shared `fetchBreadcrumbs`, `fetchSubfolders`, and `fetchMetaList` helpers used by page hooks/components.
- `lib/drive-path.ts`: Shared breadcrumb-to-relative-path formatter.
- `lib/meta-decryption.ts`: Shared worker/decrypt/cache-update helpers used by both decryption hooks.
- `lib/crypto.ts`: Decrypts metadata archives and rebuilds/encrypts edited `details.json` plus the thumbnail entirely in the browser.
- `lib/drive-download-token.ts`: Uses Better Auth's server-side OAuth refresh grant to mint a token requesting exactly `https://www.googleapis.com/auth/drive.readonly`, then checks the returned scope. The token is not persisted or returned from broad access-token APIs.
- `lib/direct-payload-source.ts`: Keeps one download session in a per-source memory closure, fetches payload data directly from Google Drive, and renews near token expiry or once after a 401, 403, 404, or 410 response. It pins payload ID and size across renewal and never falls back to an app byte proxy.
- `lib/random-access-age-reader.ts`: Uses the direct payload source for bounded encrypted ranges and retains strict 206, byte-count, and content-range validation. When Google CORS hides `Content-Range`, the source checks `Content-Length` against the requested range and pinned encrypted size, then synthesizes the header locally.
- `lib/direct-drive-upload.ts`: Validates Google resumable upload capability URLs and sends bounded chunks directly to Google Drive without a browser write bearer token. It requests `X-GUploader-No-308: yes` and normalizes Google's exposed status override locally so incomplete uploads cannot become browser redirects.
- `hooks/use-drive-file-browser-state.ts`: Shared inline search and sort state for the file browser shell.
- `hooks/use-decryption-error-prompt.ts`: Shared modal-open / dismiss / stop / re-enter behavior for decryption failures.

## Key React Components

The UI is broken down into specific interactive client components ensuring optimal performance and scoped reactivity.

1. `PassphraseGate`: 
   - A modal interface guarding the `/drive` page.
   - Requires users to enter a passphrase and derives the age identity in memory.
   - It does not pre-validate the passphrase; errors surface naturally when a file fails to decrypt.

2. `DriveHeader`: 
   - Global navigation header.
   - Contains the global search trigger, breadcrumb navigation, and user session menu.
   - Includes a "Re-enter Key" button allowing users to update their memory passphrase seamlessly.
   - When files are selected, offers both `files.txt` export and direct original-file downloads.

3. `DriveFileBrowser`:
   - Shared browser shell used by both the normal folder page and recursive search page.
   - Owns the inline search box, sort controls, refresh button, empty states, and `MetaGrid` rendering.
   - Delegates page-specific data fetching and relative-path logic to the parent page component.

4. `GlobalSearchModal`: 
   - Triggered globally, using `Fuse.js` to execute fuzzy matching over the `React Query` cache of decrypted files.
   - Features a clean custom scrollbar UI and keyboard navigation.

5. `FolderView`:
   - Mounts on `/drive/[folderId]`.
   - Fetches subfolders and breadcrumbs for the current folder.
   - Uses `useMetaFiles` for `.meta` list fetching and decryption, then passes the results into `DriveFileBrowser`.

6. `SearchView`:
   - Mounts on `/drive/[folderId]/search`.
   - Fetches breadcrumbs for the root folder.
   - Uses `useRecursiveMetaFiles` to crawl subfolders using a client-side Breadth-First Search (BFS) algorithm, aggregate all `.meta` files, then pass the result into `DriveFileBrowser`.

7. `DecryptionErrorDialog`:
   - Shared modal used by both `FolderView` and `SearchView`.
   - Provides `Cancel`, `Stop`, and `Re-enter` actions when decryption failures suggest a wrong passphrase.

8. `MetaGrid`:
   - Shared grid surface for both page modes.
   - Renders a paginated grid of `MetaCard` elements (32 items per page), empty states, error states, and the detail modal.

9. `FileDownloadProvider` and `FileDownloadButton`:
   - Share one FIFO download queue across cards, detail modals, and the header, defaulting to three active files and four ordered range requests per file. Both limits are configurable from one to six.
   - Request session JSON from the app, then fetch encrypted payload bytes directly from Google Drive. The short-lived read-only token stays in the source closure, not localStorage, sessionStorage, OPFS, or React Query.
   - Display queued, paused, preparing, decrypting/writing, finalizing, success, and retry states. Pause retains the committed plaintext offset, and resume continues from that point. Recoverable read or connection failures can Continue from the committed offset; write or integrity failures require discard and restart. Supported browsers write decrypted chunks directly to disk; other browsers use a Blob fallback.

10. `MediaPreviewProvider` and the random-access age reader:
   - Request session JSON from the app, then make direct Google Drive Range requests. `partialDownloadAllowed` must be true, and a real 206 response plus exposed `Content-Length` must match the requested range and pinned encrypted size. The source supplies a locally synthesized `Content-Range` only when CORS hides that header.
   - Existing MP4Box/MSE seek, preload, and playback loops are unchanged. MP4 preview uses bounded in-memory ranges and the optional encrypted preview cache. Native and fallback playback can use temporary plaintext browser caching where needed.

11. `MetaDetailModal`:
   - Displays decrypted metadata and provides an edit mode for all current `details.json` fields plus thumbnail replacement/removal.
   - Uploads only the new encrypted `.meta` bytes; it never renames or updates the paired original payload.

12. Upload routes:
   - `POST /api/drive/upload/meta` accepts JSON containing the folder ID, encrypted metadata size, and optional opaque ID. It creates an empty `<id>.meta` file and returns its Google resumable session URL, without receiving metadata bytes.
   - The browser uploads encrypted `.meta` chunks directly to Google Drive, then calls `POST /api/drive/upload/meta-complete`. The server verifies the exact expected size and marks metadata ready before any payload session can be created.
   - `POST /api/drive/upload/session` creates the opaque payload and returns its resumable Google session. The browser age-encrypts the original in bounded chunks and sends direct PUT requests without a write bearer token.
   - `POST /api/drive/upload/complete` remains for legacy payload finalization. `DELETE /api/drive/upload/cleanup` safely removes known unfinished metadata or payload targets, can recover an unfinished payload's bound ID from its metadata ID when a session response was lost, and refuses completed or mismatched targets.
   - Upload control calls accept JSON bodies of at most 8 KiB. `POST /api/drive/upload/chunk` returns 410; there is no app-side chunk relay. Original names and plaintext never reach these routes.
   - Upload session state and sealed age context are held in provider memory only. Reload, reopening the site, or locking the vault ends the ability to resume; clearing upload history does not delete Drive files.

## Data Hooks

- `useMetaFiles`:
  Fetches one folder's `.meta` file list, decrypts entries with a worker pool, progressively updates cards, and supports cancellation.
- `useRecursiveMetaFiles`:
  Crawls the folder tree, aggregates many `.meta` file lists, reuses the same worker/decrypt pipeline, and stores `folderId -> path` for per-card relative paths.

## Application Hierarchy

```mermaid
graph TD
    Root[app/layout.tsx] --> AuthProvider
    Root --> QueryProvider
    Root --> CryptoProvider
    
    CryptoProvider --> DriveLayout[app/drive/layout.tsx]
    
    DriveLayout --> SelectionProvider
    DriveLayout --> FileDownloadProvider
    SelectionProvider --> DriveHeader
    SelectionProvider --> PassphraseGate
    
    PassphraseGate -->|On Success| GatedContent
    GatedContent --> RootPage[app/drive/page.tsx]
    GatedContent --> FolderPage[app/drive/[folderId]/page.tsx]
    GatedContent --> SearchPage[app/drive/[folderId]/search/page.tsx]
    
    RootPage --> FolderList
    FolderPage --> FolderView
    SearchPage --> SearchView
    
    DriveHeader --> Breadcrumbs
    DriveHeader --> GlobalSearchModal
    DriveHeader --> UserMenu
    
    FolderView --> DriveFileBrowser
    SearchView --> DriveFileBrowser
    FolderView --> DecryptionErrorDialog
    SearchView --> DecryptionErrorDialog
    
    DriveFileBrowser --> MetaGrid
    MetaGrid --> MetaCard
    MetaCard --> MetaDetailModal
    MetaCard --> FileDownloadButton
    MetaDetailModal --> FileDownloadButton
    
    NextAPI[Next.js API Routes] -.->|Manages Session| AuthProvider
    NextAPI -.->|Lists folders and proxies bounded metadata| GoogleDrive[Google Drive API]
    FolderView -.->|Requests Data| NextAPI
    SearchView -.->|Requests Data| NextAPI
    FileDownloadProvider -.->|Requests session JSON| NextAPI
    FileDownloadProvider -.->|Direct encrypted GET| GoogleDrive
    MediaPreviewProvider -.->|Direct encrypted Range GET| GoogleDrive
    FileUploadProvider -.->|Requests upload session JSON| NextAPI
    FileUploadProvider -.->|Direct encrypted PUT| GoogleDrive
```
