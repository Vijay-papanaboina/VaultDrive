# Encrypted GDrive

A secure, client-side encryption frontend for Google Drive. This project provides a Google Drive-like web interface where your files are stored on Google Drive, but their metadata and contents are fully end-to-end encrypted using `age-encryption`.

All sensitive cryptographic operations, including passphrase-derived key creation and data decryption, occur strictly client-side in the browser. Original encrypted payload downloads and resumable upload data move directly between the browser and Google Drive. The Next.js backend handles authentication, small control requests, and bounded metadata operations. It never sees your unencrypted data or encryption key.

## Core Features

- **Google Drive Storage Backend**: Authenticate via Google OAuth to use your existing Google Drive as the storage layer for your encrypted vault.
- **End-to-End Encryption**: Files and their metadata (stored as `.meta` zip archives in Google Drive) are encrypted using `age-encryption`. The passphrase you provide never leaves your browser; it derives an in-memory X25519 identity key.
- **Passphrase Gating**: A secure modal blocks access until a passphrase is entered. The passphrase derives an in-memory age identity; it is not pre-validated, and incorrect-key errors surface when metadata or payloads are decrypted.
- **Global, Local, and Recursive Search**:
  - **In-Folder Search**: Real-time filtering within the current directory with space-insensitive matching.
  - **Recursive Folder Search**: Open any folder in recursive search mode to crawl its subfolders, aggregate `.meta` files, and browse the entire subtree in one view.
  - **Global Fuzzy Search**: Instantly find any decrypted file across your entire drive structure via a global modal, powered by `Fuse.js` and React Query caching.
- **Performance Optimized**:
  - Heavy cryptographic decryption is offloaded to a dynamic browser Web Worker pool, with a shared client-side decryption pipeline used by both normal and recursive views.
  - Local search and sort use a dedicated browser worker so large decrypted folders stay responsive during reordering and filtering, with search inputs debounced (350ms) to avoid redundant computations.
  - File grids utilize a paginated layout (32 items per page) with responsive pagination controls to avoid DOM overload and ensure rapid rendering.
- **Rclone Selection & Export**: Select specific files to export an ID list and fetch your raw encrypted data from Google Drive using Rclone command-line utilities.
- **Browser Downloads**: From the selection toolbar, choose between exporting `files.txt` or fetching encrypted payloads directly from Google Drive, decrypting, and saving the selected originals in the browser. Individual and selected-file downloads share a three-file queue with per-file pause and resume controls. Paused files retain their progress and free a slot for waiting downloads. Recoverable read interruptions can Continue from the committed offset; write or integrity failures require discard and restart. A short-lived, read-only Google token is held only in the download source's memory.
- **Streaming Media Preview**: MP4 previews fetch encrypted ranges directly from Google Drive and decrypt authenticated age records into MP4Box/MSE. Optional disk caching stores encrypted MP4 ranges; the normal MP4 path does not write plaintext to disk. Native/fallback formats use a direct encrypted stream and temporary plaintext browser storage where needed. Unsupported formats fall back to Download.
- **Direct Encrypted Uploads**: Original payload and `.meta` ciphertext are uploaded directly to Google Drive resumable sessions. The browser sends no write bearer token; the server creates sessions and verifies metadata completion through small JSON control requests. Retry sessions live only in memory and are cleared by reload, reopening, or vault lock.
- **Encrypted Metadata Editing**: Edit the fields stored in `details.json` and replace or remove the thumbnail from a decrypted card, then re-zip, re-encrypt, and update the same `.meta` file in Google Drive. Original payload files and Drive filenames are never changed.
- **Modern UI/UX**: Built with Tailwind CSS v4 and Base UI, featuring custom scrollbars, micro-animations, and a highly polished dark mode.

## Tech Stack

- **Framework**: [Next.js 16](https://nextjs.org/) (App Router)
- **UI Library**: [React 19](https://react.dev/)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Components**: [Base UI](https://base-ui.com/) & custom themed components
- **Authentication**: [Better Auth](https://better-auth.com/) using Google OAuth and PostgreSQL through a standard `pg` pool
- **Storage**: [Google Drive API (v3)](https://developers.google.com/drive/api/v3/reference)
- **Encryption**: [`age-encryption`](https://github.com/FiloSottile/age) & [`fflate`](https://github.com/101arrowz/fflate)
- **Search**: [`Fuse.js`](https://fusejs.io/)

## Documentation

For an in-depth look at how the system maintains zero-knowledge privacy while interacting with Google Drive:

1. [Architecture & Decryption Flow](./docs/architecture.md) - Learn about session setup, direct encrypted data transfers, client-side decryption, the shared browser shell, and recursive search.
2. [Routes & Components](./docs/routes.md) - Understand the Next.js API endpoints, shared view components, and page-specific wiring.
3. [CLI Tools & Selection Export](./docs/tools.md) - Details on browser downloads, Rclone export, folder-flattening, and the local Node.js decryption/packaging script tools.

## Getting Started

1. **Install Dependencies**:
   ```bash
   npm install
   # or
   pnpm install
   ```

2. **Setup Environment**:
   Create a `.env.local` file with the following variables:
   ```env
   DATABASE_URL=postgresql://vaultdrive:change_me@localhost:5432/vaultdrive
   BETTER_AUTH_URL=http://localhost:3000
   NEXT_PUBLIC_BETTER_AUTH_URL=http://localhost:3000
   BETTER_AUTH_SECRET=your_secret_here
   AUTH_GOOGLE_ID=your_google_oauth_client_id
   AUTH_GOOGLE_SECRET=your_google_oauth_client_secret
   ```
   Set `DATABASE_URL` to a standard PostgreSQL connection URI. For a TLS-required hosted database, include `sslmode=verify-full`, for example `postgresql://user:password@db.example.com:5432/vaultdrive?sslmode=verify-full`. Local PostgreSQL may omit the `sslmode` query parameter when its server does not require TLS.
   Ensure your Google OAuth application has the `https://www.googleapis.com/auth/drive` scope enabled for server-side Drive operations. The backend requests a separate short-lived token with exactly `https://www.googleapis.com/auth/drive.readonly` for direct browser payload reads. Existing users must sign in again after changing OAuth scopes so Google can issue the required server-side grant.

3. **Initialize Better Auth Tables**:
   Set `DATABASE_URL` to a real PostgreSQL connection, then run:
   ```bash
   pnpm db:migrate
   ```
   This initializes or updates the Better Auth tables. Start or restart the development server, then sign in.

4. **Run the Development Server**:
   ```bash
   npm run dev
   # or
   pnpm dev
   ```

5. Open [http://localhost:3000](http://localhost:3000) to login via Google and access your encrypted drive.

Deploy the frontend and backend together. The old payload GET proxy returns 405, and the old upload chunk relay returns 410. In browser network tools, original payload GETs, preview Range requests, and upload chunk PUTs should target Google Drive. Session setup, metadata completion, and other JSON control requests should target the app.
