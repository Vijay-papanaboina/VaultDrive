# Routes and Components

The Encrypted GDrive project uses the Next.js App Router. The backend APIs are designed to act as secure proxies that attach Google OAuth tokens to Google Drive API requests, ensuring the frontend client can perform cryptographic operations without exposing keys to the storage layer.

## Page Routes

- `/app/layout.tsx`: Root layout that includes global providers (Base UI, Better Auth Session, React Query, and CryptoProvider).
- `/app/page.tsx`: The landing page which handles initial authentication (Google OAuth login via Better Auth) and redirects logged-in users to `/drive`.
- `/app/drive/page.tsx`: The root Drive interface, showing the top-level folders in the user's Google Drive via `FolderList`.
- `/app/drive/[folderId]/page.tsx`: The folder browser page that mounts `FolderView` to fetch, decrypt, and display `.meta` items in a specific directory.
- `/app/drive/[folderId]/search/page.tsx`: Recursive search page that mounts `SearchView` to recursively fetch, decrypt, and display all files under a selected folder and its subdirectories.

## API Routes (Google Drive Proxy)

Because browser clients cannot safely store Google Drive OAuth tokens indefinitely, the Next.js API acts as a middleman. Better Auth securely manages the user's session (using Better SQLite3), and the API routes append the valid Google Drive access token to upstream requests.

- `/api/auth/[...all]/route.ts`: Better Auth endpoints managing Google OAuth, session cookies, and local database connections.
- `/api/drive/folders/route.ts`: Proxies requests to `lib/google-drive.ts` (`listFolders`). Queries the Google Drive API for folder structures within a specified parent ID.
- `/api/drive/meta/route.ts`: Queries the list of `.meta` files inside a given parent folder.
- `/api/drive/meta/[fileId]/route.ts`: `GET` fetches raw encrypted `.meta` bytes. `PUT` accepts an already encrypted `application/octet-stream` body and replaces only that Drive file's content after checking the optional `If-Unmodified-Since` value.
- `/api/drive/payload/[metaFileId]/route.ts`: Resolves the payload beside a `.meta` file in the same Drive folder, fetches its raw age-encrypted bytes, and returns them without decrypting.
- `/api/drive/path/route.ts`: Resolves folder path lineage by walking up the parent tree in Google Drive, returning breadcrumb data.

## Shared Client Utilities

Several client-side helpers are now shared across both the normal folder view and recursive search view:

- `lib/drive-client.ts`: Shared `fetchBreadcrumbs`, `fetchSubfolders`, and `fetchMetaList` helpers used by page hooks/components.
- `lib/drive-path.ts`: Shared breadcrumb-to-relative-path formatter.
- `lib/meta-decryption.ts`: Shared worker/decrypt/cache-update helpers used by both decryption hooks.
- `lib/crypto.ts`: Decrypts metadata archives and rebuilds/encrypts edited `details.json` plus the thumbnail entirely in the browser.
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
   - Share single-file and sequential selected-file downloads across cards, detail modals, and the header.
   - Display resolving, downloading, streaming/decrypting, success, and retry states. Supported browsers write decrypted chunks directly to disk; other browsers use a Blob fallback.

10. `MetaDetailModal`:
   - Displays decrypted metadata and provides an edit mode for all current `details.json` fields plus thumbnail replacement/removal.
   - Uploads only the new encrypted `.meta` bytes; it never renames or updates the paired original payload.

11. Upload routes:
   - `POST /api/drive/upload/meta` creates encrypted opaque metadata in the selected folder.
   - `POST /api/drive/upload/session` creates its temporary opaque payload and resumable Drive session.
   - The browser uploads encrypted payload chunks directly to that session, then `POST /api/drive/upload/complete` names the payload `<id>`.
   - `DELETE /api/drive/upload/cleanup` removes a user-cancelled pair. Original names and plaintext never reach these routes.

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
    NextAPI -.->|Fetches Blobs| GoogleDrive[Google Drive API]
    FolderView -.->|Requests Data| NextAPI
    SearchView -.->|Requests Data| NextAPI
    FileDownloadProvider -.->|Requests encrypted payload| NextAPI
```
