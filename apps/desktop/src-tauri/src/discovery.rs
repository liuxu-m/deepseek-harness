//! Strict Host discovery.
//!
//! The shell probes the loopback default port and decides whether to attach to
//! an already-running compatible harness, start its own host at the default
//! port, or start it at a dynamically assigned port. Discovery makes only a
//! single loopback `GET`, never follows redirects, never resolves a hostname,
//! and caps the response at 4 KiB.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

use thiserror::Error;

use crate::identity::{compatible, RuntimeIdentity, DSH_RUNTIME_IDENTITY_PATH};

/// Loopback literal the shell probes; never a hostname.
const LOOPBACK_HOST: &str = "127.0.0.1";
/// The default host port.
pub const DESKTOP_DEFAULT_PORT: u16 = 3080;
/// Connect/read timeout for the identity probe.
const FETCH_TIMEOUT: Duration = Duration::from_secs(2);
/// Any identity response larger than this is treated as unverified.
const MAX_IDENTITY_RESPONSE: usize = 4096;
/// A status code in this range is an acceptable identity response.
const OK_STATUS_START: u16 = 200;
const OK_STATUS_END: u16 = 300;

/// How the shell should run the bundled host after probing the default port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Discovery {
    /// A compatible host is already listening; attach to it and never start one.
    Attach {
        /// The base URL of the compatible host.
        base_url: String,
        /// The compatible host's verified identity; the supervisor re-validates
        /// readiness against it after startup.
        identity: RuntimeIdentity,
    },
    /// Nothing is listening on the default port; start the host there.
    StartDefault,
    /// Something is listening but is not a compatible host; start the host on a
    /// dynamically assigned port.
    StartDynamic,
}

/// Reasons host discovery can fail before it can choose an outcome.
#[derive(Debug, Error)]
pub enum DiscoveryError {
    /// The discovery URL was not for the loopback host.
    #[error("discovery URL `{0}` is not a loopback http identity URL")]
    NonLoopback(String),
    /// The discovery URL was not a well-formed loopback identity URL.
    #[error("discovery URL `{0}` is not a canonical `http://127.0.0.1:<port>{path}` identity URL", path = DSH_RUNTIME_IDENTITY_PATH)]
    MalformedUrl(String),
    /// The identity request failed before a response could be judged.
    #[error("identity request to `{0}` failed: {1}")]
    RequestFailed(String, std::io::Error),
}

/// Probe `url` and return the discovery outcome for the listening process.
pub fn discover(url: &str) -> Result<Discovery, DiscoveryError> {
    // A query on the identity URL marks a non-canonical endpoint, so it is
    // unverified regardless of what answers the fixed probe path.
    if url.contains('?') {
        return Ok(Discovery::StartDynamic);
    }

    let (port, raw_path) = parse_loopback_identity_url(url)?;
    if raw_path != DSH_RUNTIME_IDENTITY_PATH {
        return Err(DiscoveryError::MalformedUrl(url.into()));
    }
    probe(url, port)
}

/// Probe the default host port; the outcome the shell's supervisor consumes.
pub fn discover_default() -> Result<Discovery, DiscoveryError> {
    discover(&format!(
        "http://{LOOPBACK_HOST}:{DESKTOP_DEFAULT_PORT}{DSH_RUNTIME_IDENTITY_PATH}"
    ))
}

/// Parse the `host:port` authority and path from a loopback identity URL.
fn parse_loopback_identity_url(url: &str) -> Result<(u16, &str), DiscoveryError> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| DiscoveryError::MalformedUrl(url.into()))?;
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let port = match authority.rsplit_once(':') {
        Some((host, port)) => {
            if host != LOOPBACK_HOST {
                return Err(DiscoveryError::NonLoopback(url.into()));
            }
            port.parse::<u16>()
                .map_err(|_| DiscoveryError::MalformedUrl(url.into()))?
        }
        None => {
            if authority != LOOPBACK_HOST {
                return Err(DiscoveryError::NonLoopback(url.into()));
            }
            80
        }
    };
    Ok((port, path))
}

/// Connect to the loopback port, request the identity endpoint, and judge the
/// response against the compatible host.
fn probe(url: &str, port: u16) -> Result<Discovery, DiscoveryError> {
    let address = SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port);
    // A TCP connection that cannot be established to the loopback default port
    // (whether it is refused with RST or the handshake times out) means no host
    // is serving there, so start the bundled host at the default port. Some
    // Windows loopback stacks drop rather than RST a closed port, so the probe
    // treats a refused *and* a handshake-timeout as "nothing listening".
    let mut stream = match TcpStream::connect_timeout(&address, FETCH_TIMEOUT) {
        Ok(stream) => stream,
        Err(_) => return Ok(Discovery::StartDefault),
    };
    stream
        .set_read_timeout(Some(FETCH_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(FETCH_TIMEOUT)))
        .map_err(|error| DiscoveryError::RequestFailed(url.into(), error))?;

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {LOOPBACK_HOST}:{port}\r\nConnection: close\r\n\r\n",
        path = DSH_RUNTIME_IDENTITY_PATH
    );
    // A live connection that cannot even deliver the probe (or never yields a
    // compatible identity) is an established-but-unverified listener.
    if stream
        .write_all(request.as_bytes())
        .and_then(|()| stream.flush())
        .is_err()
    {
        return Ok(Discovery::StartDynamic);
    }

    // Read at most 4 KiB + 1; anything larger is an unverified, over-large
    // response and never gets parsed.
    let mut response = Vec::with_capacity(MAX_IDENTITY_RESPONSE + 1);
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&chunk[..read]);
                if response.len() > MAX_IDENTITY_RESPONSE {
                    return Ok(Discovery::StartDynamic);
                }
            }
            // A read failure (including the 2s timeout) after a live connection
            // means something accepted but never completed: occupied-unverified.
            Err(_) => return Ok(Discovery::StartDynamic),
        }
    }

    judge_response(url, &response)
}

/// Turn a complete (capped) identity response into a discovery outcome.
fn judge_response(url: &str, response: &[u8]) -> Result<Discovery, DiscoveryError> {
    let text = String::from_utf8_lossy(response);
    let (head, body) = match text.find("\r\n\r\n") {
        Some(separator) => (&text[..separator], &text[separator + 4..]),
        None => return Ok(Discovery::StartDynamic),
    };
    if !successful_status(head) {
        return Ok(Discovery::StartDynamic);
    }
    let identity: RuntimeIdentity = match serde_json::from_str(body) {
        Ok(identity) => identity,
        Err(_) => return Ok(Discovery::StartDynamic),
    };
    if !compatible(&identity) {
        return Ok(Discovery::StartDynamic);
    }
    Ok(Discovery::Attach {
        base_url: url.to_string(),
        identity,
    })
}

/// Return true when the status line carries a 2xx status code.
fn successful_status(head: &str) -> bool {
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|token| token.parse::<u16>().ok())
        .unwrap_or(0);
    (OK_STATUS_START..OK_STATUS_END).contains(&status)
}
