# Encrypted GDrive

A secure, client-side encryption frontend for Google Drive. This project provides a Google Drive-like web interface where your files are stored on Google Drive, but their metadata and contents are fully end-to-end encrypted using `age-encryption`.

All sensitive cryptographic operations—including passphrase validation and data decryption—occur strictly client-side in the browser. The Next.js backend serves merely as a secure proxy to fetch data from the Google Drive API, ensuring the server never sees your unencrypted data or your encryption key.

## Core Features

- **Google Drive Storage Backend**: Authenticate via Google OAuth to use your existing Google Drive as the storage layer for your encrypted vault.
- **End-to-End Encryption**: Files and their metadata (stored as `.meta` zip archives in Google Drive) are encrypted using `age-encryption`. The passphrase you provide never leaves your browser; it derives an in-memory X25519 identity key.
- **Passphrase Gating**: A secure modal blocks access until a valid key is provided, preventing unauthorized local access while allowing seamless key re-entry without breaking session state.
- **Global, Local, and Recursive Search**:
  - **In-Folder Search**: Real-time filtering within the current directory with space-insensitive matching.
  - **Recursive Folder Search**: Open any folder in recursive search mode to crawl its subfolders, aggregate `.meta` files, and browse the entire subtree in one view.
  - **Global Fuzzy Search**: Instantly find any decrypted file across your entire drive structure via a global modal, powered by `Fuse.js` and React Query caching.
- **Performance Optimized**:
  - Heavy cryptographic decryption is offloaded to a dynamic browser Web Worker pool, with a shared client-side decryption pipeline used by both normal and recursive views.
  - Local search and sort use a dedicated browser worker so large decrypted folders stay responsive during reordering and filtering.
  - File grids progressively reveal rows instead of mounting every card at once after each search/sort update.
- **Rclone Selection & Export**: Select specific files to export an ID list and fetch your raw encrypted data from Google Drive using Rclone command-line utilities.
- **Modern UI/UX**: Built with Tailwind CSS v4 and Base UI, featuring custom scrollbars, micro-animations, and a highly polished dark mode.

## Tech Stack

- **Framework**: [Next.js 16](https://nextjs.org/) (App Router)
- **UI Library**: [React 19](https://react.dev/)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Components**: [Base UI](https://base-ui.com/) & custom themed components
- **Authentication**: [Better Auth](https://better-auth.com/) (using Google OAuth & Better SQLite3 for local session persistence)
- **Storage**: [Google Drive API (v3)](https://developers.google.com/drive/api/v3/reference)
- **Encryption**: [`age-encryption`](https://github.com/FiloSottile/age) & [`fflate`](https://github.com/101arrowz/fflate)
- **Search**: [`Fuse.js`](https://fusejs.io/)

## Documentation

For an in-depth look at how the system maintains zero-knowledge privacy while interacting with Google Drive:

1. [Architecture & Decryption Flow](./docs/architecture.md) - Learn about the Google Drive proxy layer, client-side decryption pipeline, shared browser shell, and recursive search flow.
2. [Routes & Components](./docs/routes.md) - Understand the Next.js API endpoints, shared view components, and page-specific wiring.
3. [CLI Tools & Selection Export](./docs/tools.md) - Details on Rclone bulk downloading, folder-flattening, and the local Node.js decryption/packaging script tools.

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
   BETTER_AUTH_URL=http://localhost:3000
   BETTER_AUTH_SECRET=your_secret_here
   AUTH_GOOGLE_ID=your_google_oauth_client_id
   AUTH_GOOGLE_SECRET=your_google_oauth_client_secret
   ```
   Ensure your Google OAuth application has the `https://www.googleapis.com/auth/drive.readonly` scope enabled.

3. **Run the Development Server**:
   ```bash
   npm run dev
   # or
   pnpm dev
   ```

4. Open [http://localhost:3000](http://localhost:3000) to login via Google and access your encrypted drive.
