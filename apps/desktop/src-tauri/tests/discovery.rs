//! Compatibility tests for strict Host discovery against real loopback fixtures.
//!
//! Each fixture is a real `TcpListener` bound to `127.0.0.1` — never a mock —
//! and responds exactly like (or unlike) the Host identity endpoint. The probe
//! must map outcomes as: compatible -> Attach, refused -> StartDefault, and
//! every occupied-but-unverified case -> StartDynamic. It must never follow
//! redirects, never request a non-loopback host, and cap responses at 4 KiB.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

use deepseek_harness_desktop_lib::{discover, Discovery};

const IDENTITY_PATH: &str = "/api/runtime.identity";
const HEAD: &str = "HTTP/1.1";

fn identity_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}{IDENTITY_PATH}")
}

/// A minimal valid identity body for a fixture instance.
fn compatible_identity(instance_id: &str, home_kind: &str) -> String {
    format!(
        r#"{{"product":"deepseek-harness","desktopProtocol":1,"version":"0.1.0-test","instanceId":"{instance_id}","homeKind":"{home_kind}"}}"#
    )
}

/// How a fixture responds to the identity probe.
enum Responder {
    /// Exact compatible identity.
    Compatible,
    /// A valid identity under a different product name.
    WrongProduct,
    /// A valid identity with the protocol bumped to 2.
    IncompatibleProtocol,
    /// A valid identity with a custom (non-default) home.
    CustomHome,
    /// A body that is not JSON at all.
    MalformedJson,
    /// A 3xx redirect with an empty body.
    Redirect,
    /// Something a non-DSH service would return.
    NonDsh,
    /// A body larger than the 4 KiB cap.
    TooLarge,
    /// Accepts the connection but never responds.
    Timeout,
}

/// Write `status` and `body` to `sock` as a `Connection: close` HTTP response.
fn respond(sock: &mut TcpStream, status: &str, body: &str) {
    let header = format!(
        "{HEAD} {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = sock.write_all(header.as_bytes());
    let _ = sock.write_all(body.as_bytes());
    let _ = sock.flush();
}

/// Serve one identity response on an ephemeral loopback port, returning the URL.
fn serve(mode: Responder) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (mut sock, _peer) = listener.accept().unwrap();
        let mut request = [0u8; 2048];
        let _ = sock.read(&mut request);
        match &mode {
            Responder::Compatible => respond(&mut sock, "200 OK", &compatible_identity("fixture-instance", "default")),
            Responder::WrongProduct => {
                respond(&mut sock, "200 OK", &compatible_identity("fixture-instance", "default").replacen("deepseek-harness", "some-other-app", 1))
            }
            Responder::IncompatibleProtocol => {
                respond(&mut sock, "200 OK", &compatible_identity("fixture-instance", "default").replacen("desktopProtocol\":1", "desktopProtocol\":2", 1))
            }
            Responder::CustomHome => respond(&mut sock, "200 OK", &compatible_identity("fixture-instance", "custom")),
            Responder::MalformedJson => respond(&mut sock, "200 OK", "{ this is not json"),
            Responder::Redirect => respond(&mut sock, "302 Found", ""),
            Responder::NonDsh => respond(&mut sock, "200 OK", r#"{"hello":"world"}"#),
            Responder::TooLarge => respond(&mut sock, "200 OK", &"x".repeat(8192)),
            Responder::Timeout => {
                // Hold the connection open without writing anything so the
                // client's read times out.
                let _ = sock.read(&mut [0u8; 1]);
                thread::sleep(Duration::from_secs(30));
            }
        }
    });
    identity_url(port)
}

/// A loopback port that nothing listens on (bound then released).
///
/// Some Windows loopback stacks report a closed port as a connect timeout rather
/// than a refusal; the probe maps both to `StartDefault`, so a released port
/// yields the "nothing listening" outcome deterministically.
fn refused_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    identity_url(port)
}

#[test]
fn attaches_to_a_compatible_host() {
    let url = serve(Responder::Compatible);
    assert_eq!(
        discover(&url).unwrap(),
        Discovery::Attach {
            base_url: url,
            instance_id: "fixture-instance".into(),
        }
    );
}

#[test]
fn starts_default_when_nothing_is_listening() {
    assert_eq!(discover(&refused_url()).unwrap(), Discovery::StartDefault);
}

#[test]
fn starts_dynamic_for_a_non_dsh_service() {
    let url = serve(Responder::NonDsh);
    assert_eq!(discover(&url).unwrap(), Discovery::StartDynamic);
}

#[test]
fn starts_dynamic_for_an_incompatible_protocol() {
    let url = serve(Responder::IncompatibleProtocol);
    assert_eq!(discover(&url).unwrap(), Discovery::StartDynamic);
}

#[test]
fn starts_dynamic_for_a_custom_home() {
    let url = serve(Responder::CustomHome);
    assert_eq!(discover(&url).unwrap(), Discovery::StartDynamic);
}

#[test]
fn starts_dynamic_for_an_occupied_but_unresponsive_host() {
    let url = serve(Responder::Timeout);
    assert_eq!(discover(&url).unwrap(), Discovery::StartDynamic);
}

#[test]
fn starts_dynamic_for_malformed_json() {
    let url = serve(Responder::MalformedJson);
    assert_eq!(discover(&url).unwrap(), Discovery::StartDynamic);
}

#[test]
fn never_follows_a_redirect() {
    let url = serve(Responder::Redirect);
    assert_eq!(discover(&url).unwrap(), Discovery::StartDynamic);
}

#[test]
fn starts_dynamic_for_a_response_over_four_kib() {
    let url = serve(Responder::TooLarge);
    assert_eq!(discover(&url).unwrap(), Discovery::StartDynamic);
}

#[test]
fn starts_dynamic_for_a_wrong_product() {
    let url = serve(Responder::WrongProduct);
    assert_eq!(discover(&url).unwrap(), Discovery::StartDynamic);
}

#[test]
fn treats_an_identity_url_with_a_query_as_unverified() {
    let url = serve(Responder::NonDsh);
    let url = url.replacen(IDENTITY_PATH, &format!("{IDENTITY_PATH}?x=1"), 1);
    assert_eq!(discover(&url).unwrap(), Discovery::StartDynamic);
}

#[test]
fn rejects_a_non_loopback_url_without_network_io() {
    assert!(discover("http://example.com/api/runtime.identity").is_err());
    assert!(discover("http://10.0.0.1:3080/api/runtime.identity").is_err());
    assert!(discover("ftp://127.0.0.1:3080/api/runtime.identity").is_err());
}
