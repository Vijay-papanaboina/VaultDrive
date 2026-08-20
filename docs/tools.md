# Command Line Tools & Selection Export

This document explains the browser file-selection/download workflow, integration with Rclone, and the suite of Node.js scripts in the [tools/](file:///mnt/D/Projects/encrypted-gdrive/tools) directory.

---

## 1. UI File Selection & Rclone Bulk Download

Files are stored in Google Drive as opaque, end-to-end encrypted payloads (named with numeric IDs) alongside `.meta` description sidecars. VaultDrive supports both direct browser downloads and an encrypted-file export workflow.

To download files, VaultDrive provides a bulk-download helper pipeline:

### Workflow
1. **Select Files**: Click the **Select Files** button in the [DriveHeader](file:///mnt/D/Projects/encrypted-gdrive/components/drive-header.tsx) to activate selection checkboxes.
2. **Select Target Files**: Click on individual file cards or use global search to select files across multiple visited folders.
3. **Choose a download mode** from the header:
   - **Download Original Files** fetches each paired payload, stream-decrypts it in the browser, and saves the plaintext using the filename embedded in the payload. Chromium browsers with File System Access support write chunks directly to disk; other browsers use a Blob fallback. Files are downloaded individually.
   - **Download File List** downloads a local `files.txt` containing a line-separated list of relative folder paths and numeric payload filenames.
4. **Fetch Using Rclone** (for the file-list mode): An interactive dialog displays the rclone commands to copy the encrypted files to your machine using the downloaded `files.txt`:
   ```bash
   rclone copy "mygdrive:" ./encrypted-files --files-from files.txt
   ```
5. **Flatten Directory (Optional)**: If you want to pull files out of their subfolders into the root destination folder:
   ```bash
   find . -mindepth 1 -type f -exec mv -t . {} +
   ```
6. **Decrypt Locally** (for the Rclone workflow): Run the local decryption utility `decrypt-file.mjs` against the downloaded directory to reconstruct the original filenames and unencrypted file payloads.

### Individual Card Downloads

Every successfully decrypted card exposes a download icon on hover, and the same action is available in the card detail modal. The browser resolves the matching payload by using the `.meta` Drive file ID, the `.meta` file's parent folder, and the metadata filename without `.meta`. It then stream-decrypts the payload locally and saves the embedded original filename. The navbar's Downloads button shows each file's current stage and byte progress.

---

## 2. CLI Tools Suite

VaultDrive provides command-line scripts inside the `tools/` directory. These tools are built using native Node.js ESM and depend on shared packages in the repository (e.g. `@scure/base`, `age-encryption`, and `fflate`). Make sure dependencies are installed first:
```bash
npm install
```

### A. VaultDrive CLI Packaging Tool
* **File Path**: [tools/vaultdrive-cli.mjs](file:///mnt/D/Projects/encrypted-gdrive/tools/vaultdrive-cli.mjs)
* **Purpose**: Scans a local folder recursively for original files and webp/image thumbnails, packages them into encrypted `.meta` zip archives, and encrypts the files to numbered ID files ready for upload.

#### Options
* `--input`, `-i`: (Required) Input directory containing the original unencrypted files and their `.webp` thumbnails.
* `--start-id`, `-s`: (Required) Starting integer ID for the encrypted files (increments globally).
* `--output`, `-o`: (Optional) Directory where the encrypted output structure is saved. If omitted, saves inside `encrypted/` subfolders within the input directory.
* `--keys`, `-k`: Key derivation mode. Enter a passphrase to derive and output the Public Key (Recipient) and Private Key (Identity), then exit.

#### Usage Example
```bash
# Package a folder starting with ID 100
node tools/vaultdrive-cli.mjs -i /path/to/my-photos -s 100 -o /path/to/upload-package

# Output derived age keys from a passphrase
node tools/vaultdrive-cli.mjs --keys
```

---

### B. VaultDrive Decryption Utility
* **File Path**: [tools/decrypt-file.mjs](file:///mnt/D/Projects/encrypted-gdrive/tools/decrypt-file.mjs)
* **Purpose**: Decrypts downloaded age-encrypted payloads and `.meta` packages locally using a passphrase, restoring the original filenames and directory hierarchy.

Payload files produced by the packager decrypt to a four-byte big-endian filename length, a UTF-8 filename, and the original file bytes. The browser download path uses the same format and the same derived age identity, but consumes the payload as a stream and writes chunks to the selected destination instead of first creating a complete decrypted output file.

#### Options
* `--file`, `-f`: Path to a single encrypted payload or `.meta` file.
* `--dir`, `-d`: Path to a directory containing encrypted files to scan and decrypt recursively.
* `--output`, `-o`: (Optional) Directory where the decrypted mirror structure is written. If omitted, decrypts in-place inside `decrypted/` folders.

#### Usage Example
```bash
# Decrypt an entire directory of downloaded files
node tools/decrypt-file.mjs -d ./encrypted-files -o ./my-restored-files
```

---

### C. CLI Integration Test Suite
* **File Path**: [tools/test-cli.mjs](file:///mnt/D/Projects/encrypted-gdrive/tools/test-cli.mjs)
* **Purpose**: Performs local end-to-end integration tests to verify the cryptographic packaging and decryption scripts. 

#### What it tests
1. Generates mock file types (videos, text files, thumbnails).
2. Spawns `vaultdrive-cli.mjs` to package the test files.
3. Spawns `decrypt-file.mjs` to decrypt the packaged files.
4. Programmatically verifies decryption success, zip decompression integrity, schema validations, thumbnail checksums, and payload byte parity.

#### Usage
```bash
node tools/test-cli.mjs
```
