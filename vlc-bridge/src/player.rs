use std::{
    collections::{HashSet, VecDeque},
    env,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    os::{fd::OwnedFd, unix::net::UnixStream},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use age::{Decryptor, x25519::Identity};
use serde::Deserialize;
use subtle::ConstantTimeEq;
use tempfile::TempDir;
use zeroize::Zeroizing;

use crate::{
    Error, Result,
    config::{ADDRESS, random},
    library::{Library, hex_id},
};

const MAX_PLAYLIST: usize = 10_000;
const SESSION_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const REVOKED_TTL: Duration = Duration::from_secs(300);

fn decode(file: File, identity: &Identity) -> Result<impl Read + Seek + Send + use<>> {
    // Bound the age header parser, independent of the payload length.
    // BufReader may prefetch the first payload bytes but the limited header must be valid.
    let mut input = BufReader::new(file);
    let mut header = Read::by_ref(&mut input).take(65536);
    let mut line = Vec::new();
    loop {
        line.clear();
        if header.read_until(b'\n', &mut line)? == 0 || !line.ends_with(b"\n") {
            return Err(Error::conflict("Invalid VaultDrive age header"));
        }
        // The header footer is a 32-byte MAC in unpadded base64.
        if line.starts_with(b"--- ") && line.len() == 48 {
            break;
        }
    }
    input.seek(SeekFrom::Start(0))?;
    let decryptor = Decryptor::new_buffered(input)
        .map_err(|_| Error::conflict("Invalid VaultDrive age header"))?;
    decryptor
        .decrypt(std::iter::once(identity as &dyn age::Identity))
        .map_err(|_| Error::conflict("The current vault key cannot decrypt this local video"))
}

fn video_mime(name: &str) -> Option<&'static str> {
    Some(
        match name.rsplit_once('.')?.1.to_ascii_lowercase().as_str() {
            "mp4" | "m4v" => "video/mp4",
            "mkv" => "video/x-matroska",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            "avi" | "divx" => "video/x-msvideo",
            "mpeg" | "mpg" | "vob" => "video/mpeg",
            "ts" | "mts" | "m2ts" => "video/mp2t",
            "3gp" | "3g2" => "video/3gpp",
            "ogv" => "video/ogg",
            "wmv" | "asf" => "video/x-ms-wmv",
            "flv" => "video/x-flv",
            "mxf" => "application/mxf",
            "rm" | "rmvb" => "application/vnd.rn-realmedia",
            _ => return None,
        },
    )
}

pub struct Track {
    id: String,
    name: Zeroizing<String>,
    offset: u64,
    pub length: u64,
    pub mime: &'static str,
}

fn track(library: &Library, id: String, identity: &Identity) -> Result<Option<Track>> {
    let mut reader = decode(library.open_media(&id)?, identity)?;
    let mut prefix = [0; 4];
    reader
        .read_exact(&mut prefix)
        .map_err(|_| Error::conflict("Invalid VaultDrive filename header"))?;
    let length = u32::from_be_bytes(prefix) as usize;
    // Native basenames are at most 255 bytes. Bound playlist display memory.
    if !(1..=255).contains(&length) {
        return Err(Error::conflict("The original filename is too long for VLC"));
    }
    let mut filename = Zeroizing::new(vec![0; length]);
    reader
        .read_exact(&mut filename)
        .map_err(|_| Error::conflict("Invalid VaultDrive filename header"))?;
    let name = std::str::from_utf8(&filename)
        .map_err(|_| Error::conflict("Invalid VaultDrive filename"))?;
    let name = Zeroizing::new(
        name.chars()
            .map(|char| {
                if char.is_control() || char == '/' || char == '\\' {
                    '_'
                } else {
                    char
                }
            })
            .collect::<String>(),
    );
    let Some(mime) = video_mime(&name) else {
        return Ok(None);
    };
    let offset = 4 + length as u64;
    let length = reader
        .seek(SeekFrom::End(0))
        .map_err(|_| Error::conflict("The encrypted local video is truncated or damaged"))?
        .checked_sub(offset)
        .filter(|length| *length > 0)
        .ok_or(Error::conflict("The original video is empty"))?;
    Ok(Some(Track {
        id,
        name,
        offset,
        length,
        mime,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlayRequest {
    pub playback_id: String,
    pub ids: Vec<String>,
    pub selected: String,
    pub identity: ZeroizingString,
    pub directory: Option<String>,
    pub folder_key: String,
    pub folder_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(transparent)]
pub struct ZeroizingString(String);
impl Drop for ZeroizingString {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.0.zeroize();
    }
}

pub struct Playback {
    pub id: String,
    token: Zeroizing<String>,
    pub tracks: Vec<Track>,
    identity: Mutex<Option<Identity>>,
    library: Arc<Library>,
    pub closed: Arc<AtomicBool>,
}

impl Playback {
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.identity.lock().expect("identity lock").take();
    }

    pub fn reader(&self, index: usize, offset: u64) -> Result<impl Read + Seek + Send + use<>> {
        let track = self
            .tracks
            .get(index)
            .ok_or(Error::missing("Media not found"))?;
        let file = self.library.open_media(&track.id)?;
        let guard = self.identity.lock().expect("identity lock");
        let identity = guard
            .as_ref()
            .ok_or(Error::missing("Playback session ended"))?;
        let mut reader = decode(file, identity)?;
        drop(guard);
        reader.seek(SeekFrom::Start(track.offset + offset))?;
        Ok(reader)
    }

    fn url(&self, index: usize) -> Zeroizing<String> {
        Zeroizing::new(format!("http://{ADDRESS}/media/{}/{index}", *self.token))
    }

    pub fn matches(&self, token: &str, index: usize) -> bool {
        !self.closed.load(Ordering::Acquire)
            && bool::from(self.token.as_bytes().ct_eq(token.as_bytes()))
            && index < self.tracks.len()
    }
}

#[derive(Default)]
pub struct Player {
    launch_gate: Mutex<()>,
    sessions: Mutex<Sessions>,
}

#[derive(Default)]
struct Sessions {
    current: Option<Arc<Playback>>,
    revoked: VecDeque<(String, Instant)>,
    shutting_down: bool,
}

impl Sessions {
    fn revoked(&self, id: &str) -> bool {
        self.shutting_down
            || self
                .revoked
                .iter()
                .any(|(revoked, when)| revoked == id && when.elapsed() < REVOKED_TTL)
    }
}

pub fn executable() -> std::ffi::OsString {
    env::var_os("VAULTDRIVE_VLC")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "vlc".into())
}

struct Vlc {
    child: Child,
    _profile: TempDir,
}

impl Drop for Vlc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn vlc_start(playback: &Playback, selected: usize) -> Result<Vlc> {
    let profile = tempfile::Builder::new()
        .prefix("vaultdrive-vlc-")
        .tempdir_in("/tmp")?;
    let scripts = profile.path().join("vlc/lua/intf");
    fs::create_dir_all(&scripts)?;
    fs::write(
        scripts.join("vaultdrive-playlist.lua"),
        include_bytes!("playlist.lua"),
    )?;
    // VLC's Lua code receives data over an inherited private socket. It never
    // interprets filenames as commands or writes a playlist to disk.
    let (stream, child_stream) = UnixStream::pair()?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let child = Command::new(executable())
        .args([
            "--no-one-instance",
            "--no-media-library",
            "--no-qt-recentplay",
            "--no-qt-privacy-ask",
            "--no-metadata-network-access",
            "--no-auto-preparse",
            "--no-playlist-autostart",
            "--no-sub-autodetect-file",
            // VLC starts extra interfaces before its main interface. Initialize
            // Qt before Lua starts playback so video can embed in the controls.
            "--extraintf=qt:luaintf",
            "--intf=dummy",
            "--lua-intf=vaultdrive-playlist",
        ])
        .env("XDG_DATA_HOME", profile.path())
        .stdin(Stdio::from(OwnedFd::from(child_stream.try_clone()?)))
        .stdout(Stdio::from(OwnedFd::from(child_stream)))
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| Error::setup("Cannot start VLC. Install VLC 3 and its desktop interface."))?;
    let app = Vlc {
        child,
        _profile: profile,
    };
    let mut channel = BufReader::new(stream);
    let reply = |channel: &mut BufReader<UnixStream>, expected: &str| {
        let mut response = String::new();
        for _ in 0..4 {
            response.clear();
            match Read::by_ref(channel).take(256).read_line(&mut response) {
                Ok(n) if n > 0 => {
                    if response.trim_end() == expected {
                        return true;
                    }
                }
                _ => return false,
            }
        }
        false
    };
    if !reply(&mut channel, "VAULTDRIVE-READY") {
        return Err(Error::setup(
            "VLC could not start the playlist interface. Install the VLC 3 Lua plugin and check your desktop session.",
        ));
    }
    writeln!(
        channel.get_mut(),
        "{}\n{}",
        playback.tracks.len(),
        selected + 1
    )?;
    for (index, track) in playback.tracks.iter().enumerate() {
        if playback.closed.load(Ordering::Acquire) {
            return Err(Error::conflict("The VLC session was stopped"));
        }
        let url = playback.url(index);
        writeln!(channel.get_mut(), "{}\n{}", *url, *track.name)?;
    }
    if !reply(&mut channel, "VAULTDRIVE-PLAYING") {
        return Err(Error::setup("VLC could not open the local playlist."));
    }
    Ok(app)
}

impl Player {
    pub fn current(&self) -> Option<Arc<Playback>> {
        self.sessions
            .lock()
            .expect("playlist lock")
            .current
            .as_ref()
            .filter(|session| !session.closed.load(Ordering::Acquire))
            .cloned()
    }

    pub fn stop(&self, playback_id: Option<&str>) {
        let mut sessions = self.sessions.lock().expect("playlist lock");
        if let Some(id) = playback_id {
            // A Stop can arrive before a pending Play has finished reading the playlist.
            sessions
                .revoked
                .retain(|(previous, time)| previous != id && time.elapsed() < REVOKED_TTL);
            if sessions.revoked.len() >= 128 {
                sessions.revoked.pop_front();
            }
            sessions.revoked.push_back((id.into(), Instant::now()));
        } else {
            sessions.shutting_down = true;
        }
        if sessions
            .current
            .as_ref()
            .is_some_and(|session| playback_id.is_none_or(|id| session.id == id))
            && let Some(session) = sessions.current.take()
        {
            session.close();
        }
    }

    pub fn play(
        self: &Arc<Self>,
        library: Arc<Library>,
        request: PlayRequest,
    ) -> Result<(usize, String)> {
        let _gate = self
            .launch_gate
            .try_lock()
            .map_err(|_| Error::conflict("VLC is already starting"))?;
        if request.ids.is_empty()
            || request.ids.len() > MAX_PLAYLIST
            || !hex_id(&request.playback_id, 32)
            || !hex_id(&request.selected, 64)
            || request.identity.0.len() > 128
        {
            return Err(Error::bad("Invalid playlist request"));
        }
        let stopped = Error::conflict("The VLC session was stopped");
        if self
            .sessions
            .lock()
            .expect("playlist lock")
            .revoked(&request.playback_id)
        {
            return Err(stopped);
        }
        let identity = request
            .identity
            .0
            .parse::<Identity>()
            .map_err(|_| Error::bad("Invalid vault identity"))?;
        drop(request.identity);
        let mut tracks = Vec::with_capacity(request.ids.len().min(128));
        let mut seen = HashSet::new();
        let mut selected = None;
        for id in request.ids {
            if self
                .sessions
                .lock()
                .expect("playlist lock")
                .revoked(&request.playback_id)
            {
                return Err(stopped);
            }
            if !hex_id(&id, 64) {
                return Err(Error::bad("Invalid playlist download ID"));
            }
            if !seen.insert(id.clone()) {
                continue;
            }
            let is_selected = id == request.selected;
            match track(&library, id, &identity) {
                Ok(Some(track)) => {
                    if is_selected {
                        selected = Some(tracks.len());
                    }
                    tracks.push(track);
                }
                Ok(None) if is_selected => {
                    return Err(Error::bad("This original is not a supported video file"));
                }
                Err(error) if is_selected => return Err(error),
                _ => {}
            }
        }
        let selected = selected.ok_or(Error::bad("Select a completed local video"))?;
        let playback = Arc::new(Playback {
            id: request.playback_id,
            token: Zeroizing::new(hex::encode(random::<32>()?)),
            tracks,
            identity: Mutex::new(Some(identity)),
            library,
            closed: Arc::new(AtomicBool::new(false)),
        });
        let previous = {
            let mut sessions = self.sessions.lock().expect("playlist lock");
            if sessions.revoked(&playback.id) {
                return Err(stopped);
            }
            sessions.current.replace(playback.clone())
        };
        if let Some(previous) = previous {
            previous.close();
        }
        let mut vlc = match vlc_start(&playback, selected) {
            Ok(vlc) => vlc,
            Err(error) => {
                self.stop(Some(&playback.id));
                return Err(error);
            }
        };
        let player = Arc::clone(self);
        let session = playback.clone();
        thread::spawn(move || {
            let expires = Instant::now() + SESSION_TTL;
            while !session.closed.load(Ordering::Acquire)
                && Instant::now() < expires
                && matches!(vlc.child.try_wait(), Ok(None))
            {
                thread::sleep(Duration::from_millis(250));
            }
            player.stop(Some(&session.id));
            session.close();
            drop(vlc);
        });
        Ok((playback.tracks.len(), playback.id.clone()))
    }
}

pub fn byte_range(range: Option<&str>, length: u64) -> Result<(u64, u64, bool)> {
    let Some(range) = range else {
        return Ok((0, length, false));
    };
    let invalid = Error::new(416, "Range is outside the video");
    if length == 0 || range.len() > 128 {
        return Err(invalid);
    }
    let (_, value) = range
        .split_once('=')
        .filter(|(unit, _)| unit.eq_ignore_ascii_case("bytes"))
        .ok_or(invalid)?;
    let (first, last) = value.split_once('-').ok_or(invalid)?;
    let number = |value: &str| {
        if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
            value.parse::<u64>().ok()
        } else {
            None
        }
    };
    if first.is_empty() {
        let suffix = number(last).filter(|size| *size > 0).ok_or(invalid)?;
        let start = length.saturating_sub(suffix);
        return Ok((start, length - start, true));
    }
    let start = number(first)
        .filter(|start| *start < length)
        .ok_or(invalid)?;
    let end = if last.is_empty() {
        length - 1
    } else {
        number(last).ok_or(invalid)?.min(length - 1)
    };
    if end < start {
        return Err(invalid);
    }
    Ok((start, end - start + 1, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_http_ranges() {
        assert_eq!(byte_range(None, 22).unwrap(), (0, 22, false));
        assert_eq!(byte_range(Some("bytes=0-0"), 22).unwrap(), (0, 1, true));
        assert_eq!(byte_range(Some("bytes=7-"), 22).unwrap(), (7, 15, true));
        assert_eq!(byte_range(Some("bytes=-5"), 22).unwrap(), (17, 5, true));
        assert_eq!(byte_range(Some("bytes=7-31"), 22).unwrap(), (7, 15, true));
        for invalid in [
            "bytes=22-",
            "bytes=-0",
            "bytes=1-2,4-5",
            "bytes=10-8",
            "bytes=+1-7",
        ] {
            assert_eq!(byte_range(Some(invalid), 22).unwrap_err().status, 416);
        }
    }
}
