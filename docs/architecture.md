# Architecture & Decryption Flow

The Encrypted GDrive project acts as a secure, zero-knowledge overlay on top of Google Drive. By strictly separating storage (Google Drive), proxying (Next.js), and cryptography (Browser), the system ensures that sensitive data is never exposed unencrypted on any server.

## High-Level Architecture

1. **Frontend (Client-Side)**: React 19 application running in the browser. It handles state management, local/recursive/global search, and strictly executes all cryptographic operations (`age-encryption` and `fflate`) in memory.
2. **Backend (Proxy/Auth Layer)**: Next.js API Routes. It manages OAuth sessions using Better Auth (persisting session data locally in SQLite) and acts as a secure proxy. It attaches the user's Google Drive OAuth token to fetch and replace encrypted blobs in the Google Drive API.
3. **Storage Layer (Google Drive API)**: The actual Google Drive servers where files are stored. The data stored here consists of opaque folders, numbered age-encrypted payloads, and `.meta` files (age-encrypted metadata zip archives). A payload is paired with a `.meta` file by sharing its folder and using the `.meta` filename without the final suffix.

## Shared Client Architecture

The current frontend separates page-specific data discovery from shared file-browsing and decryption behavior:

1. **Fetch Helpers**: `lib/drive-client.ts` centralizes client-side calls for breadcrumbs, subfolders, and `.meta` file lists.
2. **View Shell**: `components/drive-file-browser.tsx` owns the shared file toolbar, inline search, sorting, refresh button, empty states, and `MetaGrid` rendering.
3. **Prompt Handling**: `components/decryption-error-dialog.tsx` and `hooks/use-decryption-error-prompt.ts` own the wrong-passphrase / stop / re-enter flow for both normal and recursive pages.
4. **Decryption Helpers**: `lib/meta-decryption.ts` centralizes the shared worker/decrypt/update helpers used by `useMetaFiles` and `useRecursiveMetaFiles`.
5. **Download Pipeline**: `components/file-download-provider.tsx` resolves encrypted payloads through the authenticated API, passes the response body through age stream decryption, validates the small CLI-compatible filename header, and writes plaintext chunks directly to disk when the browser supports the File System Access API.
6. **Metadata Edit Pipeline**: `MetaDetailModal` edits the in-memory `details.json` object and thumbnail bytes, `lib/crypto.ts` creates a new ZIP and age ciphertext in the browser, and `PUT /api/drive/meta/[fileId]` replaces only the existing `.meta` file content through the authenticated Drive API.
7. **Upload Pipeline**: `UploadModal` creates the small encrypted `.meta` sidecar first. The original is then read from `File.slice()` in bounded chunks, given the same CLI filename header, age-encrypted locally, and sent with a Drive resumable upload. Drive sees only opaque numeric `<id>.meta` and `<id>` names.
8. **Media Preview Pipeline**: Audio/video previews consume the payload's one-pass decrypted stream once. Each plaintext chunk is written at its offset to an origin-private OPFS temporary file and appended to a `MediaSource` buffer. The browser never assembles the original in JavaScript memory. If MSE evicts a range, the player rebuilds the buffer by reading bounded chunks back from OPFS. Unsupported codecs fall back to the normal download action.

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
    Next.js API-->>Client (React): Google Drive Access Token Stored
    
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

    User->>Client (React): Click Download on a card or selected-file action
    Client (React)->>Next.js API: Request paired payload using meta file ID
    Next.js API->>Google Drive API: Resolve same-parent filename without .meta, then GET payload
    Google Drive API-->>Next.js API: Encrypted payload bytes
    Next.js API-->>Client (React): Encrypted payload bytes
    Client (React)->>Client (React): Worker decrypts payload and parses filename header
    Client (React)-->>User: Save plaintext file with embedded original filename

    User->>Client (React): Preview audio or video
    Client (React)->>Next.js API: Request encrypted paired payload
    Next.js API-->>Client (React): Encrypted stream
    Client (React)->>Client (React): age-decrypt one pass
    Client (React)->>Client (React): Write bounded plaintext chunks to OPFS
    Client (React)->>Client (React): Append bounded chunks to MediaSource
    Client (React)-->>User: Play while download/decryption continues
```

## Security Guarantees
- The passphrase is never transmitted to the server or Google Drive.
- Metadata saves send only age-encrypted `.meta` bytes to the server. The server never receives plaintext `details.json`, thumbnail bytes, or the derived identity.
- Metadata saves update the existing `.meta` file's content only. The paired original payload and all Google Drive file naming/parent metadata remain untouched.
- The `identityRef` derived from the passphrase is held strictly in memory and clears on reload or when the key is explicitly replaced or cleared.
- The `.meta` blobs and payloads stored in Google Drive are completely opaque. Metadata is a zip containing JSON and thumbnails, while payloads contain a filename header and file bytes; both are encrypted using `age-encryption`.
- Original-file downloads fetch encrypted payload bytes through the server proxy, but age decryption, filename parsing, and plaintext Blob creation all happen in the browser. Plaintext is not sent back to the server.
- Better SQLite3 is used locally purely for Better Auth session management (if the Next.js app is hosted), keeping OAuth tokens secure.
- Media preview plaintext is temporarily cached in the browser's origin-private file system so seeking and MSE replay are possible. The cache contains only opaque Drive IDs, is never uploaded, is removed on vault lock or when manually cleared, and expires after two hours of inactivity. This is a deliberate usability tradeoff: previews require trusting the unlocked browser profile during that period.

## Search Pipeline

Because Google Drive only sees encrypted `.meta` blobs, searching requires local decryption:
1. When folders are browsed, the client decrypts `.meta` files and caches the output in React Query.
2. The normal folder view and recursive search view both reuse the same local browser shell for search, sorting, refresh, and `MetaGrid` rendering.
3. The recursive search page first crawls subfolders client-side, fetches each folder's `.meta` list, then feeds the aggregated file set into the same decryption/render pipeline used by the normal folder page.
4. The `GlobalSearchModal` utilizes `Fuse.js` to execute real-time, space-insensitive fuzzy matching across the decrypted React Query memory cache.
