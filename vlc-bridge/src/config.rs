use std::{
    env, fs,
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;
use zeroize::Zeroizing;

use crate::{Error, Result};

pub const ADDRESS: &str = "127.0.0.1:47653";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub origin: String,
    pub directory: Option<PathBuf>,
    key: String,
}

pub fn random<const N: usize>() -> io::Result<[u8; N]> {
    let mut bytes = [0; N];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn default_path(var: &str, fallback: &str) -> Result<PathBuf> {
    if let Some(path) = env::var_os(var).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            return Ok(path);
        }
    }
    Ok(PathBuf::from(env::var_os("HOME").ok_or(Error::setup("HOME is not set"))?).join(fallback))
}

pub fn config_dir() -> Result<PathBuf> {
    Ok(default_path("XDG_CONFIG_HOME", ".config")?.join("vaultdrive-vlc"))
}

pub fn open_file(path: &Path) -> io::Result<fs::File> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let stat = file.metadata()?;
    if !stat.is_file() || stat.nlink() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a regular file",
        ));
    }
    Ok(file)
}

pub fn open_directory(path: &Path) -> io::Result<fs::File> {
    let directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)?;
    if !directory.metadata()?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a directory",
        ));
    }
    Ok(directory)
}

pub fn private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    check_private_dir(path)
}

pub fn check_private_dir(path: &Path) -> io::Result<()> {
    let stat = fs::symlink_metadata(path)?;
    // SAFETY: geteuid takes no arguments and has no preconditions.
    if !stat.is_dir() || stat.uid() != unsafe { libc::geteuid() } || stat.mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "directory is not private",
        ));
    }
    Ok(())
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    let mut tmp = NamedTempFile::new_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path)?;
    fs::File::open(dir)?.sync_all()
}

fn validate_origin(origin: &str) -> bool {
    let Ok(uri) = origin.parse::<hyper::Uri>() else {
        return false;
    };
    let Some(authority) = uri.authority() else {
        return false;
    };
    let Some(scheme) = uri.scheme_str() else {
        return false;
    };
    if format!("{scheme}://{authority}") != origin || authority.as_str().contains('@') {
        return false;
    }
    let host = authority.host();
    let valid_host = host
        .bytes()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b".-".contains(&c));
    let port = authority.port_u16();
    if authority.as_str() != port.map_or_else(|| host.to_owned(), |p| format!("{host}:{p}")) {
        return false;
    }
    (scheme == "https" && valid_host && !host.is_empty() && port != Some(443))
        || (scheme == "http" && matches!(host, "localhost" | "127.0.0.1") && port != Some(80))
}

pub fn validate_directory(directory: &Path) -> Result<PathBuf> {
    if !directory.is_absolute() {
        return Err(Error::setup("Choose an absolute download directory"));
    }
    let directory = fs::canonicalize(directory)
        .map_err(|_| Error::setup("Download directory does not exist or is inaccessible"))?;
    let _directory = open_directory(&directory)
        .map_err(|_| Error::setup("Download directory does not exist or is inaccessible"))?;
    Ok(directory)
}

impl Config {
    pub fn load() -> Result<Self> {
        let dir = config_dir()?;
        private_dir(&dir)
            .map_err(|_| Error::setup("Run vaultdrive-vlc serve <VaultDrive origin> first"))?;
        let file = open_file(&dir.join("config.json"))
            .map_err(|_| Error::setup("Run vaultdrive-vlc serve <VaultDrive origin> first"))?;
        if file.metadata()?.permissions().mode() & 0o077 != 0 {
            return Err(Error::setup("Helper config must be readable only by you"));
        }
        let mut bytes = Zeroizing::new(Vec::new());
        file.take(8193).read_to_end(&mut bytes)?;
        let config: Self = serde_json::from_slice(&bytes)
            .map_err(|_| Error::setup("Invalid helper configuration"))?;
        if !validate_origin(&config.origin)
            || config
                .directory
                .as_ref()
                .is_some_and(|path| !path.is_absolute())
        {
            return Err(Error::setup("Invalid helper origin or download directory"));
        }
        config.pairing_key()?;
        Ok(config)
    }

    pub fn for_origin(origin: String, directory: Option<PathBuf>) -> Result<Self> {
        let origin = origin.strip_suffix('/').unwrap_or(&origin).to_owned();
        if !validate_origin(&origin) {
            return Err(Error::setup(
                "Use the exact HTTPS VaultDrive origin, or HTTP localhost for development",
            ));
        }
        let config = config_dir()?;
        fs::create_dir_all(
            config
                .parent()
                .ok_or(Error::setup("Invalid configuration directory"))?,
        )?;
        private_dir(&config)?;
        let existing = if config.join("config.json").try_exists()? {
            Some(Self::load()?)
        } else {
            None
        };
        let directory = if let Some(path) = directory {
            Some(validate_directory(&path)?)
        } else {
            existing
                .as_ref()
                .filter(|saved| saved.origin == origin)
                .and_then(|saved| saved.directory.clone())
        };
        let key = match existing {
            Some(mut existing) if existing.origin == origin => std::mem::take(&mut existing.key),
            _ => hex::encode(Zeroizing::new(random::<32>()?).as_slice()),
        };
        let result = Self {
            origin,
            directory,
            key,
        };
        result.save()?;
        Ok(result)
    }

    pub fn save(&self) -> Result<()> {
        let bytes = Zeroizing::new(
            serde_json::to_vec(self)
                .map_err(|_| Error::setup("Could not save helper configuration"))?,
        );
        atomic_write(&config_dir()?.join("config.json"), &bytes)?;
        Ok(())
    }

    pub fn pairing_key(&self) -> Result<Zeroizing<[u8; 32]>> {
        let mut result = Zeroizing::new([0; 32]);
        hex::decode_to_slice(&self.key, &mut *result)
            .map_err(|_| Error::setup("Invalid helper pairing code"))?;
        Ok(result)
    }

    pub fn pairing_code(&self) -> &str {
        &self.key
    }

    pub fn reset_pairing(&mut self) -> Result<()> {
        use zeroize::Zeroize;
        let bytes = Zeroizing::new(random::<32>()?);
        self.key.zeroize();
        self.key = hex::encode(bytes.as_slice());
        self.save()
    }
}

impl Drop for Config {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.key.zeroize();
    }
}
