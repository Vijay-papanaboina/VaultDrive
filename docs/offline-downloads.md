# Encrypted Downloads & VLC

**Download encrypted** keeps the exact Drive payload and original `.meta` archive on your computer. It does not replace **Download**, which still decrypts and saves an ordinary file.

## Save encrypted downloads

In **Encrypted Downloads settings**, choose a folder with Chrome or Edge. VaultDrive remembers the folder handle in IndexedDB and writes to `.vaultdrive-downloads` inside it. If the browser revokes permission, use **Allow access** in Settings. Choosing a folder, downloading, resuming, browsing, and deleting local files do not require the VLC helper. To keep an existing library, choose the folder that already contains its `.vaultdrive-downloads` directory.

Encrypted downloads use the same **Parallel downloads** preference as normal downloads, with a separate queue and one streaming request per file. The per-file threads setting only applies to normal downloads.

## Install the VLC helper

Download the Linux x64 or Windows x64 helper from [GitHub Releases](https://github.com/Vijay-papanaboina/VaultDrive/releases). Install VLC 3 separately.

On Arch Linux:

```sh
sudo pacman -S --needed vlc vlc-plugin-lua vlc-plugin-ffmpeg
install -Dm755 vaultdrive-vlc-linux-x64 ~/.local/bin/vaultdrive-vlc

~/.local/bin/vaultdrive-vlc serve https://vault-drive-three.vercel.app
```

On Windows, run this in PowerShell from the download folder:

```powershell
.\vaultdrive-vlc-windows-x64.exe serve https://vault-drive-three.vercel.app
```

The helper finds VLC in Program Files. For a portable or custom VLC installation, set `VAULTDRIVE_VLC` to the full path to `vlc.exe` before starting the helper.

Use your site's origin, including any non-default port. Local development can use `http://localhost:3000`. The helper prints the pairing code at startup. To build from source instead, run `cargo build --release --locked --manifest-path vlc-bridge/Cargo.toml`.

On the first **Play in VLC**, paste the printed code. The browser picker does not expose the absolute path, so the helper matches your download folder by its marker. It tries remembered and common locations and otherwise opens a desktop folder picker (`zenity` on Linux). Select the same folder once; VaultDrive remembers it for later plays. You can also pass the folder as an optional argument to `serve`.

Playback does not require changing folder ownership or permissions. Use a folder whose contents you trust; anyone with write access can modify your encrypted library.

Only pair a site you trust. If prompted, allow [loopback access](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access) for that site. The permission is only needed for VLC.

For automatic startup on Linux, first run `serve <origin>` once as above, then stop it and run:

```sh
install -Dm644 vlc-bridge/vaultdrive-vlc.service ~/.config/systemd/user/vaultdrive-vlc.service
systemctl --user daemon-reload
systemctl --user enable --now vaultdrive-vlc.service
```

If VLC cannot open from the service, import the display variables used by your desktop session and restart it. For Wayland, for example: `systemctl --user import-environment WAYLAND_DISPLAY` followed by `systemctl --user restart vaultdrive-vlc.service`. On X11 use `DISPLAY`. Running the helper from a desktop terminal also works.

## Use the local library

- Open **Downloads** while online once and wait for **Page available offline**. Bookmark `/downloads`. After a reload, unlock it with your normal vault password, even without Drive. The browser remembers the account email used as the key derivation salt, not the password or identity. Offline page caching is enabled in production builds, not `next dev`.
- Pause to keep your saved progress, or discard to remove a partial local copy. Resume requires Drive access and the same file revisions. The browser verifies both files against Drive's checksums. Pausing or a network failure closes the file to save the written prefix. If the browser is killed before closing the file, the last committed bytes are retained; work since that checkpoint may need to be downloaded again.
- **Play in VLC** opens a dedicated VLC window at the chosen video. The playlist follows the library order across pages and uses original names from authenticated payload headers, not edited card labels. Completed videos do not need Drive access. Closing VLC, using **Stop VLC**, or locking the vault in the launching tab ends that playback session.
- **Rescan folder** reloads the library from disk. Keep `entry.json`, `original.meta`, and `payload.age` together when making a backup. Do not rename the download directories. Trash on the Drive tab does not erase local copies. **Select** supports local copies across pages; **Delete selected** and **Delete all** ask for confirmation and never delete from Drive. Delete all also cancels queued encrypted transfers.

The Web app sends one sealed command with the folder reference, playlist order, selected video, and derived key. The helper then reads the encrypted files and original titles from disk and serves VLC independently of the Web page. It listens only on `127.0.0.1:47653`, never receives Google credentials, and does not save decrypted files. Use `reset-pairing` and restart with `serve <origin>` if you expose the pairing code.

## Checks

With Node 22.18+ and local VLC 3 and FFmpeg installed:

```sh
cargo test --locked --manifest-path vlc-bridge/Cargo.toml
cargo build --release --locked --manifest-path vlc-bridge/Cargo.toml
node --test tools/test-local-downloads.mjs tools/test-offline-download-shell.mjs
```

The test saves and rebuilds the library with the helper stopped, using mocked Drive and browser file handles backed by real files. It then starts the helper on port 47653 and exercises the installed VLC playlist and seek controls. Stop any regular helper before running it.
