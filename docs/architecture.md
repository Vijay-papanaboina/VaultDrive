# Architecture & Decryption Flow

The Encrypted GDrive project acts as a secure, zero-knowledge overlay on top of Google Drive. Cryptography stays in the browser. The Next.js backend handles authentication, metadata operations, and small session-control requests, while original encrypted payload bytes move directly between the browser and Google Drive.

## High-Level Architecture

1. **Frontend (Client-Side)**: React 19 application running in the browser. It handles state management, local/recursive/global search, and executes cryptographic operations (`age-encryption` and `fflate`) in memory.
2. **Backend (Auth and Control Layer)**: Next.js API Routes use Better Auth with PostgreSQL through a standard `pg` pool. Google refresh and write credentials stay server-side. For each payload source, the backend requests an exact `drive.readonly` token from the existing refresh grant and returns that short-lived token with a validated download session. The browser keeps it only in the source's memory closure. Better Auth HTTP access-token and refresh-token paths are disabled; server-side auth APIs remain available.
3. **Storage Layer (Google Drive API)**: Google Drive stores opaque folders, numbered age-encrypted payloads, and `.meta` files (age-encrypted metadata zip archives). A payload is paired with a `.meta` file by sharing its folder and using the `.meta` filename without the final suffix.

## Shared Client Architecture

The current frontend separates page-specific data discovery from shared file-browsing and decryption behavior:

1. **Fetch Helpers**: `lib/drive-client.ts` centralizes client-side calls for breadcrumbs, subfolders, and `.meta` file lists.
2. **View Shell**: `components/drive-file-browser.tsx` owns the shared file toolbar, inline search, sorting, refresh button, empty states, and `MetaGrid` rendering.
3. **Prompt Handling**: `components/decryption-error-dialog.tsx` and `hooks/use-decryption-error-prompt.ts` own the wrong-passphrase / stop / re-enter flow for both normal and recursive pages.
4. **Decryption Helpers**: `lib/meta-decryption.ts` centralizes the shared worker/decrypt/update helpers used by `useMetaFiles` and `useRecursiveMetaFiles`.
5. **Download Pipeline**: Individual and selected-file downloads share a queue with at most three active files. `components/file-download-provider.tsx` uses the random-access age reader to fetch authenticated encrypted records directly from Google Drive, validate the CLI-compatible filename header, and write bounded plaintext chunks to disk when the browser supports the File System Access API. Pausing aborts the current request and frees its queue slot after any pending disk write settles. Resuming continues from the committed plaintext offset, retaining the destination and progress until completion or session cleanup. Browsers without direct file access retain decrypted chunks in memory for the final Blob download.
6. **Metadata Edit Pipeline**: `MetaDetailModal` edits the in-memory `details.json` object and thumbnail bytes, `lib/crypto.ts` creates a new ZIP and age ciphertext in the browser, and `PUT /api/drive/meta/[fileId]` replaces only the existing `.meta` file content through the authenticated Drive API.
7. **Upload Pipeline**: `UploadModal` asks the server to allocate an empty opaque `.meta` file and a Drive resumable session. The browser uploads encrypted metadata directly, then asks the server to verify its exact size before creating a payload session. The original is read from `File.slice()` in bounded chunks, given the CLI filename header, age-encrypted locally, and uploaded directly to Drive. The browser sends no write bearer token. Drive sees only opaque numeric `<id>.meta` and `<id>` names. Upload sessions and their sealed age context exist only in provider memory, so reload, reopen, or vault lock ends the ability to resume; clearing history does not delete Drive files.
8. **Media Preview Pipeline**: MP4 previews request a session and fetch encrypted ranges directly from Google Drive. The random-access age reader decrypts authenticated records in memory for MP4Box/MSE; optional disk caching stores encrypted ranges only. Native/fallback formats fetch a direct encrypted stream and use temporary plaintext browser storage where needed. The existing playback loops, seek, and preload behavior remain unchanged.

## Data Flow: Google OAuth to Decryption

To access files, the user must first authenticate with Google OAuth, then provide a local encryption passphrase.

### System Interaction Mermaid Flow

```mermaid
sequenceDiagram
    participant User
    participant PassphraseGate
    participant Client (React)
    participant Next.js API
    participant Google Drive API

    User->>Client (React): Login via Google OAuth
    Client (React)->>Next.js API: Create Session (Better Auth)
    Next.js API-->>Client (React): Auth session only; Drive credentials stay server-side
    
    User->>PassphraseGate: Enters Passphrase
    PassphraseGate->>Client (React): setPassphrase(password)
    Client (React)->>Client (React): deriveAgeIdentity (Argon2id) -> X25519 Key
    Client (React)->>Client (React): Store identityRef in Memory
    Client (React)->>PassphraseGate: hasPassphrase = true
    PassphraseGate-->>User: Grant Access & Render Shared Browser View

    Note over User, Client (React): Browsing Drive & Fetching Files
    
    User->>Client (React): Open Folder
    Client (React)->>Next.js API: Request Folder Contents
    Next.js API->>Google Drive API: GET /files?q='parentId' in parents
    Google Drive API-->>Next.js API: File List
    Next.js API-->>Client (React): File List

    loop For each .meta file
        Client (React)->>Next.js API: Request Blob
        Next.js API->>Google Drive API: GET /files/{id}?alt=media
        Google Drive API-->>Next.js API: Encrypted Blob
        Next.js API-->>Client (React): Encrypted Blob
        
        Client (React)->>Client (React): decryptMetaZip using identityRef
        Client (React)->>Client (React): 1. age-encryption decode
        Client (React)->>Client (React): 2. fflate unzip
        Client (React)->>Client (React): 3. Extract details.json & thumbnail
    end
    
    Client (React)-->>User: Render Decrypted File Cards

    User->>Client (React): Edit details.json fields or replace thumbnail
    Client (React)->>Client (React): Rebuild ZIP and age-encrypt with identityRef
    Client (React)->>Next.js API: PUT encrypted .meta bytes
    Next.js API->>Google Drive API: PATCH existing .meta content only
    Google Drive API-->>Next.js API: Updated file timestamps and size
    Next.js API-->>Client (React): Updated Drive file record
    Client (React)-->>User: Refresh edited card and thumbnail

    User->>Client (React): Click Download or Preview
    Client (React)->>Next.js API: POST payload meta ID for a download session
    Next.js API->>Google Drive API: Resolve secure pair and start files.download operation
    Google Drive API-->>Next.js API: Operation with download URI
    loop While operation is pending
        Next.js API->>Google Drive API: GET operations/{name}
        Google Drive API-->>Next.js API: Operation status
    end
    Next.js API-->>Client (React): JSON URI, pinned file size, and short-lived drive.readonly token
    Client (React)->>Google Drive API: Direct HTTPS GET or Range GET with read-only bearer
    Google Drive API-->>Client (React): Encrypted payload bytes (never relayed by Next.js)
    Client (React)->>Client (React): Age decrypt and validate authenticated payload records and filename header
    Client (React)-->>User: Save plaintext file or play preview
    Note over Client (React): MP4 uses memory or encrypted range cache; native fallback may cache plaintext

    User->>Client (React): Upload a new file
    Client (React)->>Next.js API: JSON request for metadata upload session
    Next.js API->>Google Drive API: Create empty metadata file and resumable session
    Next.js API-->>Client (React): Metadata session JSON
    Client (React)->>Google Drive API: Direct PUT encrypted .meta chunks
    Client (React)->>Next.js API: POST meta-complete JSON
    Next.js API->>Google Drive API: Verify exact metadata size and update upload state
    Client (React)->>Next.js API: Request payload upload session JSON
    Next.js API-->>Client (React): Payload session JSON
    Client (React)->>Google Drive API: Direct PUT age-encrypted payload chunks
```

## Security Guarantees
- The passphrase is never transmitted to the server or Google Drive.
- Metadata saves send only age-encrypted `.meta` bytes to the server. The server never receives plaintext `details.json`, thumbnail bytes, or the derived identity.
- Metadata saves update the existing `.meta` file's content only. The paired original payload and all Google Drive file naming/parent metadata remain untouched.
- The `identityRef` derived from the passphrase is held strictly in memory and clears on reload or when the key is explicitly replaced or cleared.
- The `.meta` blobs and payloads stored in Google Drive are completely opaque. Metadata is a zip containing JSON and thumbnails, while payloads contain a filename header and file bytes; both are encrypted using `age-encryption`.
- The payload endpoint is authenticated `POST /api/drive/payload/{metaId}` and returns session JSON only. `GET` returns 405. The backend never fetches or relays the encrypted payload bytes.
- The backend mints a short-lived token requesting exactly `https://www.googleapis.com/auth/drive.readonly` and validates that Google returned exactly that scope. Only this read-only token is returned to the browser, held in the per-download or per-preview source closure, and cleared when the source closes or its parent aborts. It is not stored in localStorage, sessionStorage, OPFS, or React Query. Refresh tokens and write-capable credentials remain server-side.
- Direct range reads require `partialDownloadAllowed` and a real HTTP 206. Google CORS does not expose `Content-Range`, so the source validates the exposed `Content-Length` against the requested range and authenticated encrypted size, then synthesizes `Content-Range` locally for the age reader. Payload ID and size stay pinned across token renewal. Authenticated age records still verify their contents.
- Original-file downloads fetch encrypted payload bytes directly from Google Drive. Age decryption, filename parsing, and plaintext file creation all happen in the browser. Plaintext is not sent to the server.
- Better Auth uses PostgreSQL through the `pg` pool. The server uses its internal auth API for OAuth refreshes while browser-facing token access paths are disabled.
- For standard PostgreSQL URLs, legacy `sslmode=prefer`, `require`, or `verify-ca` is normalized to `verify-full` unless `uselibpqcompat=true`, preserving CA and hostname verification while avoiding the pg parser deprecation warning.
- Native/fallback preview plaintext may be temporarily cached in browser storage for playback and replay. That cache is not uploaded, is removed on vault lock or when manually cleared, and expires after two hours of inactivity. MP4 previews use memory and optionally cache encrypted ranges, which are removed when the preview closes.

## Search Pipeline

Because Google Drive only sees encrypted `.meta` blobs, searching requires local decryption:
1. When folders are browsed, the client decrypts `.meta` files and caches the output in React Query.
2. The normal folder view and recursive search view both reuse the same local browser shell for search, sorting, refresh, and `MetaGrid` rendering.
3. The recursive search page first crawls subfolders client-side, fetches each folder's `.meta` list, then feeds the aggregated file set into the same decryption/render pipeline used by the normal folder page.
4. The `GlobalSearchModal` utilizes `Fuse.js` to execute real-time, space-insensitive fuzzy matching across the decrypted React Query memory cache.
