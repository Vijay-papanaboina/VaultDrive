use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    env, fs,
    io::{self, Read},
    path::{Path, PathBuf},
    pin::Pin,
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use aes_gcm::{Aes256Gcm, KeyInit, aead::AeadInPlace};
use bytes::Bytes;
use hmac::{Hmac, Mac};
use http_body_util::{BodyExt, Full, Limited, combinators::UnsyncBoxBody};
use hyper::{
    Request, Response,
    body::{Body, Frame, Incoming},
    header,
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::json;
use sha2::Sha256;
use tokio::{
    net::TcpListener,
    sync::{Semaphore, mpsc},
    task::spawn_blocking,
    time::timeout,
};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    Error, Result,
    config::{ADDRESS, Config},
    library::{Library, hex_id},
    player::{Player, byte_range},
};

type HttpBody = UnsyncBoxBody<Bytes, io::Error>;
type Reply = Response<HttpBody>;
type Hmac256 = Hmac<Sha256>;
const HEADERS: &str = "content-type";
const METHODS: &str = "POST";
const FRESH_MILLIS: u64 = 60_000;
const MAX_NONCES: usize = 8192;
const PLAY_LIMIT: usize = 2 * 1024 * 1024;
const STOP_LIMIT: usize = 32 * 1024;
const CONTROL_CONTEXT: &[u8] = b"VaultDrive VLC control v2";
const FOLDER_ERROR: &str = "VLC folder does not match the folder chosen in Downloads Settings";
const PICKER_SECONDS: u64 = 75;
const MAX_DIRECTORY: usize = 4096;

struct State {
    origin: String,
    pairing: Zeroizing<[u8; 32]>,
    started_at_ms: u64,
    seen: Mutex<HashMap<String, u64>>,
    config: Config,
    player: Arc<Player>,
    streams: Arc<Semaphore>,
    picker: Mutex<()>,
}

fn full(data: impl Into<Bytes>) -> HttpBody {
    Full::new(data.into())
        .map_err(|never| match never {})
        .boxed_unsync()
}

fn response(status: u16, body: HttpBody) -> Reply {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .body(body)
        .expect("response headers")
}

fn json_reply(value: &impl serde::Serialize, status: u16) -> Reply {
    let mut reply = response(status, full(serde_json::to_vec(value).unwrap_or_default()));
    reply.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    reply
}

fn cors(reply: &mut Reply, origin: &str) {
    reply.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        origin.parse().expect("validated origin"),
    );
    reply
        .headers_mut()
        .insert(header::VARY, header::HeaderValue::from_static("Origin"));
}

fn value<'a>(headers: &'a header::HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(value)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlEnvelope {
    nonce: String,
    ciphertext: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlData<T> {
    sent_at: u64,
    data: T,
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn unseal_control<T: DeserializeOwned>(
    pairing: &[u8; 32],
    origin: &str,
    started_at_ms: u64,
    now: u64,
    seen_nonces: &Mutex<HashMap<String, u64>>,
    path: &str,
    bytes: &[u8],
) -> Result<T> {
    let denied = Error::new(
        401,
        "Playback authentication failed. Pair the helper again.",
    );
    let sealed: ControlEnvelope = serde_json::from_slice(bytes).map_err(|_| denied)?;
    if !hex_id(&sealed.nonce, 24)
        || sealed.ciphertext.len() < 32
        || sealed.ciphertext.len() % 2 != 0
        || !sealed
            .ciphertext
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(denied);
    }
    let nonce = hex::decode(&sealed.nonce).map_err(|_| denied)?;
    let mut clear = Zeroizing::new(hex::decode(&sealed.ciphertext).map_err(|_| denied)?);
    let mut derivation = <Hmac256 as Mac>::new_from_slice(pairing).expect("pairing key length");
    derivation.update(CONTROL_CONTEXT);
    let mut key = derivation.finalize().into_bytes();
    let cipher = Aes256Gcm::new(&key);
    key.zeroize();
    let associated_data = format!("{origin}\nPOST\n{path}");
    cipher
        .decrypt_in_place(
            nonce.as_slice().into(),
            associated_data.as_bytes(),
            &mut *clear,
        )
        .map_err(|_| denied)?;

    let authenticated: ControlData<T> = serde_json::from_slice(&clear).map_err(|_| denied)?;
    if authenticated.sent_at < started_at_ms || now.abs_diff(authenticated.sent_at) > FRESH_MILLIS {
        return Err(denied);
    }

    let mut seen = seen_nonces.lock().expect("replay lock");
    seen.retain(|_, timestamp| now.abs_diff(*timestamp) <= FRESH_MILLIS);
    if seen.len() >= MAX_NONCES || seen.contains_key(&sealed.nonce) {
        return Err(denied);
    }
    seen.insert(sealed.nonce, now);
    Ok(authenticated.data)
}

fn unseal<T: DeserializeOwned>(state: &State, path: &str, bytes: &[u8]) -> Result<T> {
    unseal_control(
        &state.pairing,
        &state.origin,
        state.started_at_ms,
        unix_millis(),
        &state.seen,
        path,
        bytes,
    )
}

async fn command(state: Arc<State>, request: Request<Incoming>) -> Result<Reply> {
    let path = request.uri().path().to_owned();
    let body_limit = if path == "/v1/play" {
        PLAY_LIMIT
    } else {
        STOP_LIMIT
    };
    let length = request
        .body()
        .size_hint()
        .exact()
        .ok_or(Error::bad("A bounded request body is required"))?;
    if length == 0 || length > body_limit as u64 {
        return Err(Error::new(413, "Helper request is too large"));
    }
    let bytes = timeout(
        Duration::from_secs(20),
        Limited::new(request.into_body(), body_limit).collect(),
    )
    .await
    .map_err(|_| Error::new(408, "Helper request timed out"))?
    .map_err(|_| Error::bad("Incomplete helper request"))?
    .to_bytes();
    if bytes.len() as u64 != length {
        return Err(Error::bad("Incomplete helper request"));
    }
    spawn_blocking(move || dispatch(&state, &path, &bytes))
        .await
        .map_err(|_| Error::setup("Local helper operation failed"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stop {
    playback_id: String,
}

fn valid_folder_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\'])
        && !name.chars().any(char::is_control)
}

fn verify_candidate(path: &Path, folder_key: &str) -> Option<(Arc<Library>, PathBuf)> {
    Library::open(path, folder_key).ok()?;
    let directory = fs::canonicalize(path).ok()?;
    let library = Arc::new(Library::open(&directory, folder_key).ok()?);
    Some((library, directory))
}

fn picker_directory(state: &State, folder_key: &str) -> Result<(Arc<Library>, PathBuf)> {
    let _picker = state
        .picker
        .try_lock()
        .map_err(|_| Error::setup(FOLDER_ERROR))?;
    #[cfg(unix)]
    let mut command = {
        let mut command = Command::new(if Path::new("/bin/zenity").is_file() {
            "/bin/zenity"
        } else {
            "zenity"
        });
        command.args([
            "--file-selection",
            "--directory",
            "--timeout=75",
            "--title=Choose the VaultDrive download folder",
        ]);
        command
    };
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new(env::current_exe()?);
        command.arg("__pick-folder");
        command
    };
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| Error::setup(FOLDER_ERROR))?;

    let deadline = Instant::now() + Duration::from_secs(PICKER_SECONDS);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return Err(Error::setup(FOLDER_ERROR)),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::setup(FOLDER_ERROR));
            }
        }
    }

    let mut output = Vec::new();
    child
        .stdout
        .take()
        .ok_or(Error::setup(FOLDER_ERROR))?
        .take(MAX_DIRECTORY as u64 + 1)
        .read_to_end(&mut output)
        .map_err(|_| Error::setup(FOLDER_ERROR))?;
    if output.last() == Some(&b'\n') {
        output.pop();
    }
    if output.last() == Some(&b'\r') {
        output.pop();
    }
    if output.is_empty()
        || output.len() > MAX_DIRECTORY
        || output
            .iter()
            .any(|byte| *byte == 0 || *byte == b'\n' || *byte == b'\r')
    {
        return Err(Error::setup(FOLDER_ERROR));
    }
    let path = std::str::from_utf8(&output).map_err(|_| Error::setup(FOLDER_ERROR))?;
    verify_candidate(Path::new(path), folder_key).ok_or(Error::setup(FOLDER_ERROR))
}

fn play_directory(
    state: &State,
    request: &crate::player::PlayRequest,
) -> Result<(Arc<Library>, PathBuf)> {
    let mut candidates = Vec::new();
    if let Some(directory) = request.directory.as_deref() {
        #[cfg(unix)]
        candidates.push(PathBuf::from(directory));
        #[cfg(windows)]
        candidates.push(crate::windows::directory_from_browser(directory));
    }
    if let Some(directory) = state.config.directory.as_ref() {
        candidates.push(directory.clone());
    }
    if let Ok(directory) = env::current_dir() {
        candidates.push(directory);
    }
    #[cfg(unix)]
    let home = env::var_os("HOME");
    #[cfg(windows)]
    let home = env::var_os("USERPROFILE");
    if let Some(home) = home {
        let downloads = PathBuf::from(home).join("Downloads");
        candidates.push(downloads.clone());
        if let Some(name) = request
            .folder_name
            .as_deref()
            .filter(|name| valid_folder_name(name))
        {
            candidates.push(downloads.join(name));
        }
    }

    let mut tried = HashSet::new();
    for candidate in candidates {
        if !tried.insert(candidate.clone()) {
            continue;
        }
        if let Some(verified) = verify_candidate(&candidate, &request.folder_key) {
            return Ok(verified);
        }
    }

    if request.folder_name.is_some() {
        picker_directory(state, &request.folder_key)
    } else {
        Err(Error::setup(FOLDER_ERROR))
    }
}

fn dispatch(state: &State, path: &str, bytes: &[u8]) -> Result<Reply> {
    match path {
        "/v1/play" => {
            let request = unseal::<crate::player::PlayRequest>(state, path, bytes)?;
            let (library, directory) = play_directory(state, &request)?;
            #[cfg(windows)]
            let directory = crate::windows::browser_directory(&directory)
                .filter(|value| value.len() <= MAX_DIRECTORY)
                .ok_or(Error::setup(FOLDER_ERROR))?;
            let (count, playback_id) = state.player.play(library, request)?;
            Ok(json_reply(
                &json!({ "count": count, "playbackId": playback_id, "directory": directory }),
                200,
            ))
        }
        "/v1/play/stop" => {
            let stop = unseal::<Stop>(state, path, bytes)?;
            if !hex_id(&stop.playback_id, 32) {
                return Err(Error::bad("Invalid playback session"));
            }
            state.player.stop(Some(&stop.playback_id));
            Ok(response(204, full("")))
        }
        _ => Err(Error::missing("Unknown helper endpoint")),
    }
}

struct ReadBody {
    chunks: mpsc::Receiver<io::Result<Bytes>>,
    closed: Option<Arc<AtomicBool>>,
}

impl Body for ReadBody {
    type Data = Bytes;
    type Error = io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<io::Result<Frame<Bytes>>>> {
        if self
            .closed
            .as_ref()
            .is_some_and(|closed| closed.load(Ordering::Acquire))
        {
            self.chunks.close();
            return Poll::Ready(Some(Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Playback ended",
            ))));
        }
        self.chunks
            .poll_recv(cx)
            .map(|item| item.map(|item| item.map(Frame::data)))
    }
}

struct WipeBytes(Zeroizing<Vec<u8>>);
impl AsRef<[u8]> for WipeBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

fn read_body(
    state: &State,
    mut reader: impl Read + Send + 'static,
    length: u64,
    closed: Option<Arc<AtomicBool>>,
    sensitive: bool,
) -> Result<HttpBody> {
    let permit = state
        .streams
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::new(503, "Too many local reads"))?;
    let (sender, chunks) = mpsc::channel(1);
    let done = closed.clone();
    spawn_blocking(move || {
        let _permit = permit;
        let mut remaining = length;
        while remaining > 0
            && !sender.is_closed()
            && !done
                .as_ref()
                .is_some_and(|closed| closed.load(Ordering::Acquire))
        {
            let len = remaining.min(64 * 1024) as usize;
            let mut buffer = Zeroizing::new(vec![0; len]);
            if reader.read_exact(&mut buffer).is_err() {
                let _ = sender.blocking_send(Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Local media read failed",
                )));
                return;
            }
            let bytes = if sensitive {
                Bytes::from_owner(WipeBytes(buffer))
            } else {
                Bytes::from(std::mem::take(&mut *buffer))
            };
            if sender.blocking_send(Ok(bytes)).is_err() {
                return;
            }
            remaining -= len as u64;
        }
    });
    Ok(ReadBody { chunks, closed }.boxed_unsync())
}

fn content(mut reply: Reply, length: u64, mime: &'static str) -> Reply {
    reply.headers_mut().insert(
        header::CONTENT_LENGTH,
        length.to_string().parse().expect("valid length"),
    );
    reply
        .headers_mut()
        .insert(header::CONTENT_TYPE, header::HeaderValue::from_static(mime));
    reply
}

async fn media(state: Arc<State>, request: Request<Incoming>) -> Result<Reply> {
    let missing = Error::missing("Media not found");
    if request.headers().contains_key(header::ORIGIN)
        || request.headers().contains_key("sec-fetch-site")
    {
        return Err(missing);
    }
    let head = match request.method().as_str() {
        "HEAD" => true,
        "GET" => false,
        _ => return Err(Error::new(405, "Media supports GET and HEAD only")),
    };
    let mut parts = request.uri().path().split('/');
    let (Some(""), Some("media"), Some(token), Some(index), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return Err(missing);
    };
    let index = index.parse::<usize>().map_err(|_| missing)?;
    let playback = state
        .player
        .current()
        .filter(|playback| playback.matches(token, index))
        .ok_or(missing)?;
    let track = &playback.tracks[index];
    let range = if request.headers().contains_key(header::RANGE) {
        Some(value(request.headers(), "range").unwrap_or(""))
    } else {
        None
    };
    let (start, size, partial) = match byte_range(range, track.length) {
        Ok(range) => range,
        Err(_) => {
            let mut reply = response(416, full(""));
            reply.headers_mut().insert(
                header::CONTENT_RANGE,
                format!("bytes */{}", track.length)
                    .parse()
                    .expect("content range"),
            );
            reply.headers_mut().insert(
                header::ACCEPT_RANGES,
                header::HeaderValue::from_static("bytes"),
            );
            return Ok(reply);
        }
    };
    let (mime, total) = (track.mime, track.length);
    let body = if head {
        full("")
    } else {
        let closed = playback.closed.clone();
        let reader = spawn_blocking(move || playback.reader(index, start))
            .await
            .map_err(|_| Error::setup("Cannot open local video"))??;
        read_body(&state, reader, size, Some(closed), true)?
    };
    let mut reply = content(response(if partial { 206 } else { 200 }, body), size, mime);
    reply.headers_mut().insert(
        header::ACCEPT_RANGES,
        header::HeaderValue::from_static("bytes"),
    );
    if partial {
        let end = start + size - 1;
        reply.headers_mut().insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}")
                .parse()
                .expect("content range"),
        );
    }
    Ok(reply)
}

async fn handle(
    state: Arc<State>,
    request: Request<Incoming>,
) -> std::result::Result<Reply, Infallible> {
    if value(request.headers(), "host") != Some(ADDRESS)
        || request.uri().authority().is_some()
        || request.uri().query().is_some()
    {
        eprintln!(
            "VaultDrive VLC rejected request before origin check: method={} host={:?}",
            request.method(),
            value(request.headers(), "host")
        );
        return Ok(response(403, full("")));
    }
    if request.uri().path().starts_with("/media/") {
        return Ok(media(state, request)
            .await
            .unwrap_or_else(|error| response(error.status, full(""))));
    }
    if value(request.headers(), "origin") != Some(&state.origin) {
        eprintln!(
            "VaultDrive VLC rejected origin: method={} path={} origin={:?} expected={}",
            request.method(),
            request.uri().path(),
            value(request.headers(), "origin"),
            state.origin
        );
        return Ok(response(403, full("")));
    }
    let path = request.uri().path();
    let mut result =
        if request.method() == "OPTIONS" && matches!(path, "/v1/play" | "/v1/play/stop") {
            let mut reply = response(204, full(""));
            for (name, value) in [
                (header::ACCESS_CONTROL_ALLOW_HEADERS, HEADERS),
                (header::ACCESS_CONTROL_ALLOW_METHODS, METHODS),
                (header::ACCESS_CONTROL_MAX_AGE, "600"),
            ] {
                reply
                    .headers_mut()
                    .insert(name, header::HeaderValue::from_static(value));
            }
            reply
        } else if request.method() == "POST" && matches!(path, "/v1/play" | "/v1/play/stop") {
            let method = request.method().clone();
            let path = request.uri().path().to_owned();
            match command(state.clone(), request).await {
                Ok(reply) => reply,
                Err(error) => {
                    eprintln!(
                        "VaultDrive VLC request rejected: method={} path={} status={} reason={}",
                        method, path, error.status, error.message
                    );
                    json_reply(&json!({ "error": error.message }), error.status)
                }
            }
        } else {
            response(404, full(""))
        };
    cors(&mut result, &state.origin);
    Ok(result)
}

pub async fn serve(config: Config, print_pairing: bool) -> Result<()> {
    let listener = TcpListener::bind(ADDRESS).await.map_err(|_| {
        Error::setup("Cannot bind helper localhost port 47653. Is another helper running?")
    })?;
    if print_pairing {
        println!("Pairing code: {}", config.pairing_code());
    }
    #[cfg(unix)]
    let interrupted = {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        async move {
            tokio::select! {
                result = tokio::signal::ctrl_c() => result,
                _ = terminate.recv() => Ok(()),
            }
        }
    };
    #[cfg(windows)]
    let interrupted = tokio::signal::ctrl_c();
    tokio::pin!(interrupted);
    let state = Arc::new(State {
        origin: config.origin.clone(),
        pairing: config.pairing_key()?,
        started_at_ms: unix_millis(),
        seen: Mutex::new(HashMap::new()),
        config,
        player: Arc::new(Player::default()),
        streams: Arc::new(Semaphore::new(12)),
        picker: Mutex::new(()),
    });
    let connections = Arc::new(Semaphore::new(64));
    eprintln!("VaultDrive VLC helper listening on {ADDRESS}");
    loop {
        tokio::select! {
            _ = &mut interrupted => break,
            result = listener.accept() => {
                let (stream, peer) = result?;
                if !peer.ip().is_loopback() { continue; }
                let Ok(permit) = connections.clone().try_acquire_owned() else { continue; };
                stream.set_nodelay(true)?;
                let state = state.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let _ = http1::Builder::new().timer(TokioTimer::new())
                        .header_read_timeout(Duration::from_secs(5)).max_headers(32).max_buf_size(16 * 1024)
                        .serve_connection(TokioIo::new(stream), service_fn(move |request| handle(state.clone(), request)))
                        .await;
                });
            }
        }
    }
    state.player.stop(None);
    Ok(())
}
