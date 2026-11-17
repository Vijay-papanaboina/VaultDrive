mod config;
mod library;
mod player;
mod server;
#[cfg(windows)]
mod windows;

use std::{env, io, path::PathBuf, time::Duration};

use config::Config;

type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug)]
struct Error {
    status: u16,
    message: &'static str,
}

impl Error {
    const fn new(status: u16, message: &'static str) -> Self {
        Self { status, message }
    }
    const fn bad(message: &'static str) -> Self {
        Self::new(400, message)
    }
    const fn setup(message: &'static str) -> Self {
        Self::new(503, message)
    }
    const fn conflict(message: &'static str) -> Self {
        Self::new(409, message)
    }
    const fn missing(message: &'static str) -> Self {
        Self::new(404, message)
    }
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::StorageFull => {
                Self::new(507, "Not enough disk space for the encrypted download")
            }
            io::ErrorKind::PermissionDenied => Self::new(
                403,
                "Cannot access the local download folder. Check its permissions.",
            ),
            io::ErrorKind::NotFound => {
                Self::missing("Local encrypted download file or directory is missing")
            }
            _ => Self::setup(
                "Local I/O failed. Check the download directory and available disk space.",
            ),
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::setup("Could not encode local download information")
    }
}

fn run() -> Result<()> {
    let mut args = env::args_os().skip(1);
    match args
        .next()
        .and_then(|arg| arg.into_string().ok())
        .as_deref()
    {
        #[cfg(windows)]
        Some("__pick-folder") if args.next().is_none() => {
            println!("{}", windows::choose_folder()?);
            Ok(())
        }
        Some("reset-pairing") if args.next().is_none() => {
            let mut config = Config::load()?;
            config.reset_pairing()?;
            println!(
                "Pairing reset. Restart with vaultdrive-vlc serve <VaultDrive origin> to print the new code."
            );
            Ok(())
        }
        Some("serve") => {
            let origin = args
                .next()
                .map(|arg| {
                    arg.into_string()
                        .map_err(|_| Error::bad("The VaultDrive origin must be UTF-8"))
                })
                .transpose()?;
            let directory = args.next().map(PathBuf::from);
            if args.next().is_some() {
                return Err(Error::bad("Too many serve arguments"));
            }
            let print_pairing = origin.is_some();
            let config = match origin {
                Some(origin) => Config::for_origin(origin, directory)?,
                None => Config::load()?,
            };
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .max_blocking_threads(24)
                .build()?;
            let result = runtime.block_on(server::serve(config, print_pairing));
            runtime.shutdown_timeout(Duration::from_secs(1));
            result
        }
        _ => Err(Error::bad(
            "Usage: vaultdrive-vlc serve <origin> [absolute playback directory] | reset-pairing",
        )),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{}", error.message);
        std::process::exit(1);
    }
}
