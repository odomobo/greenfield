//! The login protocol: the records exchanged on `login.sock` (between the web process and a login helper) and on a
//! desktop's `desktop.sock` (between a login helper and the user's desktop). See SIGNIN-ROADMAP.md, step 4.
//!
//! # Byte layout
//!
//! Every record is a 4-byte header and a payload:
//!
//! ```text
//!   offset 0  u8   kind (below)
//!   offset 1  u8   reserved, 0
//!   offset 2  u16  payload length in bytes, big-endian; at most the kind's limit
//!   offset 4  ...  payload
//! ```
//!
//! Kinds and payloads (texts are UTF-8, not NUL-terminated; their length is the rest of the payload):
//!
//! ```text
//!   1 ClientAddress  web -> helper, the first record on login.sock: the browser's address (for PAM_RHOST, the log,
//!                    the takeover message). 18 bytes: u8 family (4 or 6), u8 reserved 0, 16 bytes address (IPv4 in
//!                    the first 4 bytes, the rest 0).
//!   2 Begin          web -> helper, once, after ClientAddress: the user name, 0..=256 bytes (the web process sends an
//!                    empty name for a longer one; it fails like an unknown user).
//!   3 Prompt         helper -> web: u8 style, then the text, 0..=512 bytes. Styles: 1 a question with a hidden
//!                    answer (PAM_PROMPT_ECHO_OFF), 2 with a visible answer (PAM_PROMPT_ECHO_ON), 3 information
//!                    (PAM_TEXT_INFO), 4 an error message (PAM_ERROR_MSG). Only 1 and 2 are answered.
//!   4 Answer         web -> helper: the answer to the last question, 0..=1024 bytes.
//!   5 Result         helper -> web, last: u8 outcome, then a text, 0..=256 bytes. Outcomes: 0 signed in (the text is
//!                    the user name, as PAM may have canonicalized it; the record carries one fd, the web process's
//!                    end of the relay socket pair to the desktop), 1 refused (wrong password, unknown user: the text
//!                    is for the user), 2 failed (e.g. the desktop could not be started: the text is for the user).
//!   6 Handover       helper -> desktop, the only record on a desktop.sock connection: a new viewer connection. Same
//!                    payload as ClientAddress (the new connection's address, for the takeover message); carries one
//!                    fd, the desktop's end of the relay socket pair.
//! ```
//!
//! A record that carries an fd is sent with one `sendmsg` whose `SCM_RIGHTS` message holds it, so the fd arrives
//! with the record's first byte. Anything else (an unknown kind, a nonzero reserved byte, a length over the kind's
//! limit or not matching a fixed-size payload, invalid UTF-8, an unknown style or outcome) is an error: the reader
//! closes the connection. The TypeScript side of this layout is `packages/session/src/login-protocol.ts`.
#![forbid(unsafe_code)]

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

pub const HEADER_LEN: usize = 4;
pub const ADDRESS_LEN: usize = 18;
pub const MAX_USERNAME: usize = 256;
pub const MAX_PROMPT: usize = 512;
pub const MAX_ANSWER: usize = 1024;
pub const MAX_RESULT_TEXT: usize = 256;
/// The longest record of any kind.
pub const MAX_RECORD: usize = HEADER_LEN + MAX_ANSWER;

pub const KIND_CLIENT_ADDRESS: u8 = 1;
pub const KIND_BEGIN: u8 = 2;
pub const KIND_PROMPT: u8 = 3;
pub const KIND_ANSWER: u8 = 4;
pub const KIND_RESULT: u8 = 5;
pub const KIND_HANDOVER: u8 = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptStyle {
    EchoOff = 1,
    EchoOn = 2,
    Info = 3,
    Error = 4,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    SignedIn = 0,
    Refused = 1,
    Failed = 2,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Record {
    ClientAddress(IpAddr),
    Begin { username: String },
    Prompt { style: PromptStyle, text: String },
    Answer { text: String },
    Result { outcome: Outcome, text: String },
    Handover(IpAddr),
}

impl Record {
    /// Whether this kind of record carries an fd: a signed-in Result and a Handover.
    pub fn carries_fd(&self) -> bool {
        matches!(self, Record::Result { outcome: Outcome::SignedIn, .. } | Record::Handover(_))
    }

    /// The record's bytes. Fails if a text is over its limit.
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        let (kind, payload) = match self {
            Record::ClientAddress(ip) => (KIND_CLIENT_ADDRESS, encode_address(ip)),
            Record::Begin { username } => (KIND_BEGIN, checked(username, MAX_USERNAME)?.to_vec()),
            Record::Prompt { style, text } => (KIND_PROMPT, prefixed(*style as u8, checked(text, MAX_PROMPT)?)),
            Record::Answer { text } => (KIND_ANSWER, checked(text, MAX_ANSWER)?.to_vec()),
            Record::Result { outcome, text } => {
                (KIND_RESULT, prefixed(*outcome as u8, checked(text, MAX_RESULT_TEXT)?))
            }
            Record::Handover(ip) => (KIND_HANDOVER, encode_address(ip)),
        };
        let mut bytes = Vec::with_capacity(HEADER_LEN + payload.len());
        bytes.push(kind);
        bytes.push(0);
        bytes.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        bytes.extend_from_slice(&payload);
        Ok(bytes)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    UnknownKind(u8),
    Reserved,
    Length { kind: u8, length: usize },
    Utf8,
    Style(u8),
    Outcome(u8),
    Family(u8),
    TooLong,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Error::UnknownKind(kind) => write!(f, "unknown record kind {kind}"),
            Error::Reserved => write!(f, "reserved byte not 0"),
            Error::Length { kind, length } => write!(f, "invalid length {length} for record kind {kind}"),
            Error::Utf8 => write!(f, "text not UTF-8"),
            Error::Style(style) => write!(f, "unknown prompt style {style}"),
            Error::Outcome(outcome) => write!(f, "unknown outcome {outcome}"),
            Error::Family(family) => write!(f, "unknown address family {family}"),
            Error::TooLong => write!(f, "text over its limit"),
        }
    }
}

impl std::error::Error for Error {}

/// The longest payload a record kind may have, and whether it is exactly that long.
fn payload_limit(kind: u8) -> Result<(usize, bool), Error> {
    match kind {
        KIND_CLIENT_ADDRESS | KIND_HANDOVER => Ok((ADDRESS_LEN, true)),
        KIND_BEGIN => Ok((MAX_USERNAME, false)),
        KIND_PROMPT => Ok((1 + MAX_PROMPT, false)),
        KIND_ANSWER => Ok((MAX_ANSWER, false)),
        KIND_RESULT => Ok((1 + MAX_RESULT_TEXT, false)),
        other => Err(Error::UnknownKind(other)),
    }
}

/// One record from the start of `bytes`: the record and how many bytes it took, `None` if more bytes are needed.
/// The header is checked as soon as it is there, so a reader never waits for (or buffers) more than `MAX_RECORD`.
pub fn decode(bytes: &[u8]) -> Result<Option<(Record, usize)>, Error> {
    if bytes.len() < HEADER_LEN {
        return Ok(None);
    }
    let kind = bytes[0];
    if bytes[1] != 0 {
        return Err(Error::Reserved);
    }
    let length = u16::from_be_bytes([bytes[2], bytes[3]]) as usize;
    let (limit, exact) = payload_limit(kind)?;
    let minimum = if kind == KIND_PROMPT || kind == KIND_RESULT { 1 } else { 0 };
    if length > limit || (exact && length != limit) || length < minimum {
        return Err(Error::Length { kind, length });
    }
    if bytes.len() < HEADER_LEN + length {
        return Ok(None);
    }
    let payload = &bytes[HEADER_LEN..HEADER_LEN + length];
    let text = |slice: &[u8]| String::from_utf8(slice.to_vec()).map_err(|_| Error::Utf8);
    let record = match kind {
        KIND_CLIENT_ADDRESS => Record::ClientAddress(decode_address(payload)?),
        KIND_HANDOVER => Record::Handover(decode_address(payload)?),
        KIND_BEGIN => Record::Begin { username: text(payload)? },
        KIND_ANSWER => Record::Answer { text: text(payload)? },
        KIND_PROMPT => {
            let style = match payload[0] {
                1 => PromptStyle::EchoOff,
                2 => PromptStyle::EchoOn,
                3 => PromptStyle::Info,
                4 => PromptStyle::Error,
                other => return Err(Error::Style(other)),
            };
            Record::Prompt { style, text: text(&payload[1..])? }
        }
        KIND_RESULT => {
            let outcome = match payload[0] {
                0 => Outcome::SignedIn,
                1 => Outcome::Refused,
                2 => Outcome::Failed,
                other => return Err(Error::Outcome(other)),
            };
            Record::Result { outcome, text: text(&payload[1..])? }
        }
        other => return Err(Error::UnknownKind(other)),
    };
    Ok(Some((record, HEADER_LEN + length)))
}

fn checked(text: &str, limit: usize) -> Result<&[u8], Error> {
    if text.len() > limit {
        return Err(Error::TooLong);
    }
    Ok(text.as_bytes())
}

fn prefixed(first: u8, rest: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(1 + rest.len());
    payload.push(first);
    payload.extend_from_slice(rest);
    payload
}

fn encode_address(ip: &IpAddr) -> Vec<u8> {
    let mut payload = vec![0u8; ADDRESS_LEN];
    match ip {
        IpAddr::V4(v4) => {
            payload[0] = 4;
            payload[2..6].copy_from_slice(&v4.octets());
        }
        IpAddr::V6(v6) => {
            payload[0] = 6;
            payload[2..18].copy_from_slice(&v6.octets());
        }
    }
    payload
}

fn decode_address(payload: &[u8]) -> Result<IpAddr, Error> {
    if payload[1] != 0 {
        return Err(Error::Reserved);
    }
    match payload[0] {
        4 => {
            if payload[6..].iter().any(|&b| b != 0) {
                return Err(Error::Reserved);
            }
            Ok(IpAddr::V4(Ipv4Addr::new(payload[2], payload[3], payload[4], payload[5])))
        }
        6 => {
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&payload[2..18]);
            Ok(IpAddr::V6(Ipv6Addr::from(octets)))
        }
        other => Err(Error::Family(other)),
    }
}

/// Whether an address is this machine's own (127.0.0.0/8, ::1, or an IPv4-mapped 127.x address).
pub fn is_loopback(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(record: Record) {
        let bytes = record.encode().unwrap();
        assert_eq!(decode(&bytes).unwrap(), Some((record.clone(), bytes.len())));
        // any prefix is incomplete, not an error
        for end in 0..bytes.len() {
            assert_eq!(decode(&bytes[..end]).unwrap(), None);
        }
    }

    #[test]
    fn records_round_trip() {
        round_trip(Record::ClientAddress("127.0.0.1".parse().unwrap()));
        round_trip(Record::ClientAddress("2001:db8::1".parse().unwrap()));
        round_trip(Record::Begin { username: "josh".into() });
        round_trip(Record::Begin { username: String::new() });
        round_trip(Record::Prompt { style: PromptStyle::EchoOff, text: "Password: ".into() });
        round_trip(Record::Prompt { style: PromptStyle::Error, text: "nope".into() });
        round_trip(Record::Answer { text: "pässword".into() });
        round_trip(Record::Result { outcome: Outcome::SignedIn, text: "josh".into() });
        round_trip(Record::Result { outcome: Outcome::Refused, text: "The username or password is incorrect.".into() });
        round_trip(Record::Handover("::1".parse().unwrap()));
    }

    /// The same bytes are checked in the TypeScript side's test (packages/session/src/test/login-protocol.test.ts).
    #[test]
    fn layout_is_fixed() {
        assert_eq!(
            Record::ClientAddress("127.0.0.1".parse().unwrap()).encode().unwrap(),
            [1, 0, 0, 18, 4, 0, 127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        );
        assert_eq!(Record::Begin { username: "ab".into() }.encode().unwrap(), [2, 0, 0, 2, b'a', b'b']);
        assert_eq!(
            Record::Prompt { style: PromptStyle::EchoOn, text: "x".into() }.encode().unwrap(),
            [3, 0, 0, 2, 2, b'x']
        );
        assert_eq!(Record::Answer { text: "pw".into() }.encode().unwrap(), [4, 0, 0, 2, b'p', b'w']);
        assert_eq!(
            Record::Result { outcome: Outcome::SignedIn, text: "u".into() }.encode().unwrap(),
            [5, 0, 0, 2, 0, b'u']
        );
        let mut handover = vec![6, 0, 0, 18, 6, 0];
        handover.extend_from_slice(&[0; 15]);
        handover.push(1);
        assert_eq!(Record::Handover("::1".parse().unwrap()).encode().unwrap(), handover);
    }

    #[test]
    fn limits_are_enforced() {
        assert_eq!(Record::Begin { username: "x".repeat(MAX_USERNAME + 1) }.encode(), Err(Error::TooLong));
        assert!(Record::Answer { text: "x".repeat(MAX_ANSWER) }.encode().is_ok());
        assert_eq!(Record::Answer { text: "x".repeat(MAX_ANSWER + 1) }.encode(), Err(Error::TooLong));
        // a header announcing too much is refused before the payload arrives
        assert_eq!(decode(&[4, 0, 0x04, 0x01]), Err(Error::Length { kind: 4, length: 1025 }));
        assert_eq!(decode(&[1, 0, 0, 17]), Err(Error::Length { kind: 1, length: 17 }));
        assert_eq!(decode(&[3, 0, 0, 0]), Err(Error::Length { kind: 3, length: 0 }));
        assert_eq!(decode(&[9, 0, 0, 0]), Err(Error::UnknownKind(9)));
        assert_eq!(decode(&[2, 1, 0, 0]), Err(Error::Reserved));
        assert_eq!(decode(&[2, 0, 0, 1, 0xff]), Err(Error::Utf8));
        assert_eq!(decode(&[3, 0, 0, 1, 5]), Err(Error::Style(5)));
        assert_eq!(decode(&[5, 0, 0, 1, 3]), Err(Error::Outcome(3)));
        let mut bad_family = vec![1, 0, 0, 18, 5];
        bad_family.extend_from_slice(&[0; 17]);
        assert_eq!(decode(&bad_family), Err(Error::Family(5)));
    }

    #[test]
    fn loopback() {
        for ip in ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"] {
            assert!(is_loopback(&ip.parse().unwrap()), "{ip}");
        }
        for ip in ["10.0.0.1", "::ffff:10.0.0.1", "2001:db8::1", "0.0.0.0"] {
            assert!(!is_loopback(&ip.parse().unwrap()), "{ip}");
        }
    }
}
