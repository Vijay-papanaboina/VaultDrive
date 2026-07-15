# Routes and Components

The Encrypted GDrive project uses the Next.js App Router. The backend APIs are designed to act as secure proxies that attach Google OAuth tokens to Google Drive API requests, ensuring the frontend client can perform cryptographic operations without exposing keys to the storage layer.

## Page Routes

- `/app/layout.tsx`: Root layout that includes global providers (Base UI, Better Auth Session, React Query, and CryptoProvider).
- `/app/page.tsx`: The landing page which handles initial authentication (Google OAuth login via Better Auth) and redirects logged-in users to `/drive`.
- `/app/drive/page.tsx`: The root Drive interface, showing the top-level folders in the user's Google Drive via `FolderList`.
- `/app/drive/[folderId]/page.tsx`: The folder browser page that mounts `FolderView` to fetch, decrypt, and display `.meta` items in a specific directory.

## API Routes (Google Drive Proxy)

Because browser clients cannot safely store Google Drive OAuth tokens indefinitely, the Next.js API acts as a middleman. Better Auth securely manages the user's session (using Better SQLite3), and the API routes append the valid Google Drive access token to upstream requests.

- `/api/auth/[...all]/route.ts`: Better Auth endpoints managing Google OAuth, session cookies, and local database connections.
- `/api/drive/folders/route.ts`: Proxies requests to `lib/google-drive.ts` (`listFolders`). Queries the Google Drive API for folder structures within a specified parent ID.
- `/api/drive/meta/route.ts`: Queries the list of `.meta` files inside a given parent folder.
- `/api/drive/meta/[fileId]/route.ts`: Fetches the raw encrypted `.meta` bytes for a specific file, returning `application/octet-stream`.
- `/api/drive/path/route.ts`: Resolves folder path lineage by walking up the parent tree in Google Drive, returning breadcrumb data.

## Key React Components

The UI is broken down into specific interactive client components ensuring optimal performance and scoped reactivity.

1. `PassphraseGate`: 
   - A modal interface guarding the `/drive` page.
   - Requires users to enter a valid decryption key.
   - It stores the derived key in memory without pre-validating. Errors surface naturally later if a file fails to decrypt.

2. `DriveHeader`: 
   - Global navigation header.
   - Contains the global search trigger, breadcrumb navigation, and user session menu.
   - Includes a "Re-enter Key" button allowing users to update their memory passphrase seamlessly.

3. `FolderView`: 
   - The primary file grid.
   - Integrates `useMetaFiles` to request `.meta` files from the API, decrypt them via `age-encryption`, and display them.
   - Includes local folder search with space-insensitive matching.
   - Uses a themed `DropdownMenu` for file sorting.

4. `GlobalSearchModal`: 
   - Triggered globally, using `Fuse.js` to execute fuzzy matching over the `React Query` cache of decrypted files.
   - Features a clean custom scrollbar UI and keyboard navigation.

## Application Hierarchy

```mermaid
graph TD
    Root[app/layout.tsx] --> AuthProvider
    Root --> QueryProvider
    Root --> CryptoProvider
    
    CryptoProvider --> DriveLayout[app/drive/layout.tsx]
    
    DriveLayout --> SelectionProvider
    SelectionProvider --> DriveHeader
    SelectionProvider --> PassphraseGate
    
    PassphraseGate -->|On Success| GatedContent
    GatedContent --> RootPage[app/drive/page.tsx]
    GatedContent --> FolderPage[app/drive/[folderId]/page.tsx]
    
    RootPage --> FolderList
    FolderPage --> FolderView
    
    DriveHeader --> Breadcrumbs
    DriveHeader --> GlobalSearchModal
    DriveHeader --> UserMenu
    
    FolderView --> MetaGrid
    FolderView --> LocalSearch
    FolderView --> SortDropdown
    
    MetaGrid --> MetaCard
    MetaCard --> MetaDetailModal
    
    NextAPI[Next.js API Routes] -.->|Manages Session| AuthProvider
    NextAPI -.->|Fetches Blobs| GoogleDrive[Google Drive API]
    FolderView -.->|Requests Data| NextAPI
```
