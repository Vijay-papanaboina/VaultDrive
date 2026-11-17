use std::{
    fs::{File, OpenOptions},
    io,
    os::windows::fs::{MetadataExt as _, OpenOptionsExt},
    path::{Component, Path, PathBuf, Prefix},
    ptr,
};

use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File as CapFile, OpenOptions as CapOptions};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom, CRYPT_INTEGER_BLOB,
        CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    },
    Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    },
    System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize},
    UI::Shell::{
        BIF_NEWDIALOGSTYLE, BIF_RETURNONLYFSDIRS, BROWSEINFOW, SHBrowseForFolderW,
        SHGetPathFromIDListEx,
    },
};
use zeroize::{Zeroize, Zeroizing};

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Not a regular VaultDrive path")
}

fn component(name: &str) -> io::Result<&str> {
    if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\\', ':', '\0']) {
        return Err(invalid());
    }
    Ok(name)
}

fn directory(file: File) -> io::Result<File> {
    let metadata = file.metadata()?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(invalid());
    }
    Ok(file)
}

fn regular(file: CapFile) -> io::Result<File> {
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(invalid());
    }
    let file = file.into_std();
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(invalid());
    }
    Ok(file)
}

pub fn open_directory(path: &Path) -> io::Result<File> {
    if !path.is_absolute()
        || !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_) | Prefix::UNC(_, _) | Prefix::VerbatimUNC(_, _)))
    {
        return Err(invalid());
    }
    directory(
        OpenOptions::new()
            .read(true)
            // cap-std requires directory handles that deny renames/deletion.
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?,
    )
}

pub fn open_file(path: &Path) -> io::Result<File> {
    regular(CapFile::from_std(
        OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?,
    ))
}

pub fn directory_at(parent: &File, name: &str) -> io::Result<File> {
    let parent = Dir::from_std_file(parent.try_clone()?);
    let entry = parent.open_dir_nofollow(component(name)?)?;
    directory(entry.into_std_file())
}

pub fn file_at(parent: &File, name: &str) -> io::Result<File> {
    let parent = Dir::from_std_file(parent.try_clone()?);
    let mut options = CapOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    regular(parent.open_with(component(name)?, &options)?)
}

pub fn random<const N: usize>() -> io::Result<[u8; N]> {
    let mut bytes = [0; N];
    let length = u32::try_from(N).map_err(|_| invalid())?;
    // SAFETY: the system RNG writes at most length bytes into the live array.
    let status = unsafe {
        BCryptGenRandom(
            ptr::null_mut(),
            bytes.as_mut_ptr(),
            length,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        bytes.zeroize();
        return Err(io::Error::other("Windows random number generation failed"));
    }
    Ok(bytes)
}

pub fn config_bytes(bytes: &[u8], protect: bool) -> io::Result<Zeroizing<Vec<u8>>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(|_| invalid())?,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: input and output blobs point to live memory. DPAPI owns the
    // returned buffer until LocalFree, and defaults to current-user protection.
    let success = unsafe {
        if protect {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if success == 0 || output.pbData.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: DPAPI returned a buffer of cbData bytes; zero it before release.
    unsafe {
        let buffer = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let result = Zeroizing::new(buffer.to_vec());
        buffer.zeroize();
        LocalFree(output.pbData.cast());
        Ok(result)
    }
}

pub fn choose_folder() -> io::Result<String> {
    // SAFETY: this runs on the standalone picker process's main thread.
    if unsafe { CoInitializeEx(ptr::null(), COINIT_APARTMENTTHREADED as u32) } < 0 {
        return Err(io::Error::other("Cannot open the Windows folder picker"));
    }
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            // SAFETY: balances the successful CoInitializeEx on this thread.
            unsafe { CoUninitialize() }
        }
    }
    let _apartment = Apartment;
    let title: Vec<u16> = "Choose the VaultDrive download folder\0"
        .encode_utf16()
        .collect();
    let mut name = [0u16; 260];
    let picker = BROWSEINFOW {
        pszDisplayName: name.as_mut_ptr(),
        lpszTitle: title.as_ptr(),
        ulFlags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE,
        ..BROWSEINFOW::default()
    };
    // SAFETY: picker fields and the display buffer live across the modal call.
    let selection = unsafe { SHBrowseForFolderW(&picker) };
    if selection.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "Folder selection canceled",
        ));
    }
    let mut path = [0u16; 4097];
    // SAFETY: selection is a valid PIDL and path is a writable buffer.
    let success = unsafe {
        let success = SHGetPathFromIDListEx(selection, path.as_mut_ptr(), path.len() as u32, 0);
        CoTaskMemFree(selection.cast());
        success
    };
    let end = path
        .iter()
        .position(|unit| *unit == 0)
        .ok_or_else(invalid)?;
    if success == 0 || end == 0 {
        return Err(invalid());
    }
    String::from_utf16(&path[..end]).map_err(|_| invalid())
}

// The Web protocol already treats this as an opaque slash-prefixed receipt.
// Use file-URL path form so deployed Web clients can remember Windows folders.
pub fn browser_directory(path: &Path) -> Option<String> {
    let path = path.to_str()?;
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return Some(format!("//{}", unc.replace('\\', "/")));
    }
    let path = path
        .strip_prefix(r"\\?\")
        .unwrap_or(path)
        .replace('\\', "/");
    Some(if path.starts_with("//") {
        path
    } else {
        format!("/{path}")
    })
}

pub fn directory_from_browser(path: &str) -> PathBuf {
    if let Some(unc) = path.strip_prefix("//") {
        return PathBuf::from(format!(r"\\?\UNC\{}", unc.replace('/', "\\")));
    }
    if let Some(drive) = path.strip_prefix('/') {
        return PathBuf::from(format!(r"\\?\{}", drive.replace('/', "\\")));
    }
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_receipt_round_trips() {
        for path in [r"\\?\C:\Media Files", r"\\?\UNC\server\share\Videos"] {
            let receipt = browser_directory(Path::new(path)).unwrap();
            assert!(receipt.starts_with('/'));
            assert_eq!(directory_from_browser(&receipt), Path::new(path));
        }
    }

    #[test]
    fn pairing_config_is_protected_by_windows() {
        let data = b"test-only synthetic pairing data";
        let protected = config_bytes(data, true).unwrap();
        assert!(!protected.windows(data.len()).any(|window| window == data));
        assert_eq!(config_bytes(&protected, false).unwrap().as_slice(), data);
    }
}
