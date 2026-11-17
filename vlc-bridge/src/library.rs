use std::{
    ffi::CString,
    fs::File,
    io::{self, Read},
    os::fd::{AsRawFd, FromRawFd},
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::Path,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{Error, Result, config::open_directory};

const MAX_META: u64 = 25 * 1024 * 1024;
const MAX_MANIFEST: u64 = 8 * 1024;
const MAX_SAFE_NUMBER: u64 = (1 << 53) - 1;
const MAX_SAFE_TIMESTAMP: u64 = 8_640_000_000_000_000;
const FOLDER_MISMATCH: &str = "VLC folder does not match the folder chosen in Downloads Settings";

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Version {
    pub id: String,
    pub revision: String,
    pub size: u64,
    pub checksum: String,
}

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pair {
    pub meta: Version,
    pub payload: Version,
    pub modified_time: String,
}

pub fn hex_id(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn drive_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
}

impl Pair {
    fn id(&self) -> Result<String> {
        if self.meta.size > MAX_META
            || self.meta.id == self.payload.id
            || self.modified_time.len() > 64
            || !self.modified_time.is_ascii()
            || self.modified_time.bytes().any(|c| c.is_ascii_control())
            || [&self.meta, &self.payload].iter().any(|version| {
                version.size == 0
                    || version.size > MAX_SAFE_NUMBER
                    || !drive_id(&version.id)
                    || !drive_id(&version.revision)
                    || !(hex_id(&version.checksum, 32) || hex_id(&version.checksum, 64))
            })
        {
            return Err(Error::bad("Invalid encrypted Drive file version"));
        }

        // The browser derives the directory ID from this ordered JSON array.
        let versions = serde_json::to_vec(&(&self.meta, &self.payload))?;
        Ok(hex::encode(Sha256::digest(versions)))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Status {
    Downloading,
    Paused,
    Failed,
    Complete,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u8,
    pair: Pair,
    added_at: u64,
    status: Status,
    error: Option<String>,
    remote_deleted: bool,
}

pub struct Library {
    root: File,
    folder_key: String,
}

fn component(name: &str) -> io::Result<CString> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a single path component",
        ));
    }
    CString::new(name)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path component contains NUL"))
}

fn open_directory_at(parent: &File, name: &str, missing_message: &'static str) -> Result<File> {
    let name = component(name)?;
    // SAFETY: the parent descriptor is live and name is a NUL-terminated single component.
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::NotFound {
            return Err(Error::missing(missing_message));
        }
        return Err(error.into());
    }
    // SAFETY: openat returned a new owned descriptor.
    let directory = unsafe { File::from_raw_fd(descriptor) };
    if !directory.metadata()?.is_dir() {
        return Err(Error::conflict(missing_message));
    }
    Ok(directory)
}

fn open_file_at(directory: &File, name: &str) -> io::Result<File> {
    let name = component(name)?;
    // SAFETY: the directory descriptor is live and name is a NUL-terminated single component.
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned a new owned descriptor.
    let file = unsafe { File::from_raw_fd(descriptor) };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a singly linked regular file",
        ));
    }
    Ok(file)
}

fn invalid_manifest() -> Error {
    Error::conflict("Local download manifest is invalid")
}

fn verify_folder_marker(root: &File, folder_key: &str) -> Result<()> {
    if !hex_id(folder_key, 64) {
        return Err(Error::conflict(FOLDER_MISMATCH));
    }
    let marker = open_file_at(root, ".folder-id").map_err(|_| Error::conflict(FOLDER_MISMATCH))?;
    let length = marker
        .metadata()
        .map_err(|_| Error::conflict(FOLDER_MISMATCH))?
        .len();
    if !(64..=65).contains(&length) {
        return Err(Error::conflict(FOLDER_MISMATCH));
    }
    let mut bytes = Vec::with_capacity(length as usize);
    marker
        .take(66)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::conflict(FOLDER_MISMATCH))?;
    if bytes.len() as u64 != length {
        return Err(Error::conflict(FOLDER_MISMATCH));
    }
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.len() != 64 || !bool::from(bytes.as_slice().ct_eq(folder_key.as_bytes())) {
        return Err(Error::conflict(FOLDER_MISMATCH));
    }
    Ok(())
}

impl Library {
    pub fn open(directory: &Path, folder_key: &str) -> Result<Self> {
        if directory.as_os_str().as_bytes().len() > 4096 || !directory.is_absolute() {
            return Err(Error::bad("Invalid VLC download folder"));
        }
        let selected_root = open_directory(directory)
            .map_err(|_| Error::setup("Download directory does not exist or is inaccessible"))?;
        let root = open_directory_at(&selected_root, ".vaultdrive-downloads", FOLDER_MISMATCH)?;
        verify_folder_marker(&root, folder_key)?;
        Ok(Self {
            root,
            folder_key: folder_key.into(),
        })
    }

    fn load(&self, id: &str) -> Result<(File, Manifest)> {
        if !hex_id(id, 64) {
            return Err(Error::bad("Invalid local download ID"));
        }
        verify_folder_marker(&self.root, &self.folder_key)?;

        let dir = open_directory_at(&self.root, id, "Local download not found")?;

        let manifest_file = open_file_at(&dir, "entry.json").map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                Error::missing("Local download manifest is missing")
            } else {
                error.into()
            }
        })?;
        let length = manifest_file.metadata()?.len();
        if length == 0 || length > MAX_MANIFEST {
            return Err(invalid_manifest());
        }
        let mut bytes = Vec::with_capacity(length as usize);
        manifest_file
            .take(MAX_MANIFEST + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 != length || bytes.len() as u64 > MAX_MANIFEST {
            return Err(invalid_manifest());
        }

        let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| invalid_manifest())?;
        let manifest_id = manifest.pair.id().map_err(|_| invalid_manifest())?;
        if manifest.version != 1 || manifest_id != id || manifest.added_at > MAX_SAFE_TIMESTAMP {
            return Err(invalid_manifest());
        }
        Ok((dir, manifest))
    }

    pub fn open_media(&self, id: &str) -> Result<File> {
        let (dir, manifest) = self.load(id)?;
        if manifest.status != Status::Complete {
            return Err(Error::conflict("Download has not completed"));
        }

        // Only the canonical browser payload is readable. Partial files and
        // alternate paths are never considered for playback.
        let file = open_file_at(&dir, "payload.age").map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                Error::missing("The local encrypted video payload is missing")
            } else {
                error.into()
            }
        })?;
        if file.metadata()?.len() != manifest.pair.payload.size {
            return Err(Error::conflict("The local encrypted payload size changed"));
        }
        Ok(file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
        path::PathBuf,
    };

    fn pair() -> Pair {
        Pair {
            meta: Version {
                id: "meta".into(),
                revision: "1".into(),
                size: 4,
                checksum: hex::encode(Sha256::digest(b"meta")),
            },
            payload: Version {
                id: "payload".into(),
                revision: "2".into(),
                size: 7,
                checksum: hex::encode(Sha256::digest(b"payload")),
            },
            modified_time: "2026-10-29T00:00:00Z".into(),
        }
    }

    fn set_writable_directory(path: &Path) {
        fs::set_permissions(path, fs::Permissions::from_mode(0o777)).unwrap();
    }

    fn folder_key() -> String {
        "c".repeat(64)
    }

    fn write_root(parent: &Path, key: &str) -> PathBuf {
        let root = parent.join(".vaultdrive-downloads");
        fs::create_dir(&root).unwrap();
        set_writable_directory(&root);
        fs::write(root.join(".folder-id"), key).unwrap();
        root
    }

    fn write_entry(parent: &Path, key: &str, status: Status, payload_file: &[u8]) -> String {
        let root = write_root(parent, key);
        let pair = pair();
        let id = pair.id().unwrap();
        let dir = root.join(&id);
        fs::create_dir(&dir).unwrap();
        set_writable_directory(&dir);
        let manifest = Manifest {
            version: 1,
            pair,
            added_at: 1_798_000_000_000,
            status,
            error: None,
            remote_deleted: false,
        };
        fs::write(
            dir.join("entry.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(dir.join("original.meta"), b"meta").unwrap();
        fs::write(dir.join("payload.age"), payload_file).unwrap();
        id
    }

    #[test]
    fn open_does_not_create_the_browser_managed_directory() {
        let directory = tempfile::tempdir().unwrap();
        assert!(Library::open(directory.path(), &folder_key()).is_err());
        assert!(!directory.path().join(".vaultdrive-downloads").exists());
    }

    #[test]
    fn playback_accepts_group_world_writable_directories() {
        let directory = tempfile::tempdir().unwrap();
        set_writable_directory(directory.path());
        let key = folder_key();
        let id = write_entry(directory.path(), &key, Status::Complete, b"payload");
        let store = Library::open(directory.path(), &key).unwrap();
        assert_eq!(store.open_media(&id).unwrap().metadata().unwrap().len(), 7);
    }

    #[test]
    fn playback_rejects_traversal_and_symlinked_entries() {
        let directory = tempfile::tempdir().unwrap();
        let key = folder_key();
        write_root(directory.path(), &key);
        let store = Library::open(directory.path(), &key).unwrap();
        assert!(store.open_media("../outside").is_err());

        let root = directory.path().join(".vaultdrive-downloads");
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();
        set_writable_directory(&outside);
        let id = pair().id().unwrap();
        symlink(&outside, root.join(&id)).unwrap();
        assert!(store.open_media(&id).is_err());
    }

    #[test]
    fn playback_rejects_incomplete_and_wrong_length_payloads() {
        let directory = tempfile::tempdir().unwrap();
        let key = folder_key();
        let id = write_entry(directory.path(), &key, Status::Downloading, b"payload");
        let store = Library::open(directory.path(), &key).unwrap();
        assert!(store.open_media(&id).is_err());

        let directory = tempfile::tempdir().unwrap();
        let key = folder_key();
        let id = write_entry(directory.path(), &key, Status::Complete, b"short");
        let store = Library::open(directory.path(), &key).unwrap();
        assert!(store.open_media(&id).is_err());
    }

    #[test]
    fn playback_rejects_a_different_folder_key() {
        let directory = tempfile::tempdir().unwrap();
        let key = folder_key();
        write_root(directory.path(), &key);
        assert!(Library::open(directory.path(), &"d".repeat(64)).is_err());
    }
}
