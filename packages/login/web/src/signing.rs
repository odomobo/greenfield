//! The TLS key stays in the listener: a worker signs its handshake by asking the listener over its signing channel
//! (fd 8, a SOCK_SEQPACKET socket pair per worker). An exploited worker can't copy the key; at most it gets one
//! signature over a CertificateVerify layout with a transcript hash of its choosing, i.e. it can complete one TLS
//! handshake as the server (which it could do anyway on its own connection), once.
//!
//! # The channel
//!
//! One request, one reply, then the listener closes its end, whatever the request was:
//!
//! ```text
//!   request (worker -> listener), one packet:
//!     u16  the signature scheme, big-endian (TLS's SignatureScheme code point)
//!     ...  the message to sign: exactly the TLS 1.3 server CertificateVerify content (RFC 8446 section 4.4.3):
//!          64 bytes 0x20, "TLS 1.3, server CertificateVerify", a 0 byte, then the transcript hash (as long as the
//!          hash of one of our cipher suites: 32 or 48 bytes)
//!   reply (listener -> worker), one packet: the signature; or no reply (EOF): refused
//! ```
//!
//! The listener checks the layout strictly and that the scheme is a TLS 1.3 scheme its key supports, signs with
//! rustls's own signer for the key (so hashing and padding are rustls's), and answers at most one request per worker.
//!
//! Signing happens inline in the listener's single-threaded poll loop. That is fine: one signature takes about 0.1 ms
//! for ECDSA P-256 (the generated key) and about 1–2 ms for RSA 2048 (10 ms for RSA 4096), and there is at most one
//! per worker, so even a full set of 256 workers asking at once delays accepting by well under a second with RSA.
//!
//! Keys: whatever rustls's ring provider loads (`any_supported_type`): RSA (PKCS#1 or PKCS#8; signed with RSA-PSS,
//! as TLS 1.3 requires), ECDSA P-256 (the generated self-signed key) and P-384 (SEC1 or PKCS#8), Ed25519 (PKCS#8).
use rustls::crypto::ring::default_provider;
use rustls::sign::{Signer, SigningKey};
use rustls::{SignatureAlgorithm, SignatureScheme};
use std::fmt;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Arc;

/// The signature schemes TLS 1.3 allows (RFC 8446 section 4.2.3; no RSA PKCS#1, SHA-1 or SHA-224), in the order we
/// prefer them.
pub const TLS13_SCHEMES: [SignatureScheme; 8] = [
    SignatureScheme::ECDSA_NISTP256_SHA256,
    SignatureScheme::ECDSA_NISTP384_SHA384,
    SignatureScheme::ECDSA_NISTP521_SHA512,
    SignatureScheme::ED25519,
    SignatureScheme::ED448,
    SignatureScheme::RSA_PSS_SHA256,
    SignatureScheme::RSA_PSS_SHA384,
    SignatureScheme::RSA_PSS_SHA512,
];

/// The TLS 1.3 server CertificateVerify content before the transcript hash.
const SPACES: usize = 64;
const CONTEXT: &[u8] = b"TLS 1.3, server CertificateVerify\0";
/// The longest request: the scheme, the layout and the longest hash (SHA-512); a longer packet is refused.
pub const MAX_REQUEST: usize = 2 + SPACES + CONTEXT.len() + 64;
/// The longest signature (RSA 8192).
pub const MAX_SIGNATURE: usize = 1024;

pub fn scheme_code(scheme: SignatureScheme) -> u16 {
    u16::from_be_bytes(scheme.to_array())
}

/// The TLS 1.3 schemes `key` can sign with, in our order of preference.
pub fn schemes_of(key: &dyn SigningKey) -> Vec<SignatureScheme> {
    TLS13_SCHEMES.into_iter().filter(|&scheme| key.choose_scheme(&[scheme]).is_some()).collect()
}

/// The lengths of the transcript hashes of our cipher suites (TLS 1.3 with ring: SHA-256 and SHA-384).
pub fn transcript_hash_lengths() -> Vec<usize> {
    let mut lengths: Vec<usize> = default_provider()
        .cipher_suites
        .iter()
        .filter_map(|suite| suite.tls13())
        .map(|suite| suite.common.hash_provider.output_len())
        .collect();
    lengths.sort_unstable();
    lengths.dedup();
    lengths
}

/// Check a request against the layout (see the module documentation): the scheme and the message to sign.
pub fn check_request<'a>(
    request: &'a [u8],
    hash_lengths: &[usize],
) -> Result<(SignatureScheme, &'a [u8]), &'static str> {
    if request.len() < 2 {
        return Err("too short");
    }
    let scheme = SignatureScheme::from(u16::from_be_bytes([request[0], request[1]]));
    if !TLS13_SCHEMES.contains(&scheme) {
        return Err("not a TLS 1.3 signature scheme");
    }
    let message = &request[2..];
    let Some(hash_length) = message.len().checked_sub(SPACES + CONTEXT.len()) else {
        return Err("not a CertificateVerify");
    };
    if !hash_lengths.contains(&hash_length) {
        return Err("not a CertificateVerify (length)");
    }
    if !message[..SPACES].iter().all(|&b| b == 0x20) || &message[SPACES..SPACES + CONTEXT.len()] != CONTEXT {
        return Err("not a server CertificateVerify");
    }
    Ok((scheme, message))
}

/// The listener's key, and what it signs.
pub struct Key {
    key: Arc<dyn SigningKey>,
    hash_lengths: Vec<usize>,
}

impl Key {
    pub fn new(key: Arc<dyn SigningKey>) -> Key {
        Key { key, hash_lengths: transcript_hash_lengths() }
    }

    /// Sign a worker's request, if it is the CertificateVerify layout with a scheme of our key.
    pub fn sign(&self, request: &[u8]) -> Result<Vec<u8>, String> {
        let (scheme, message) = check_request(request, &self.hash_lengths)?;
        let signer = self
            .key
            .choose_scheme(&[scheme])
            .filter(|signer| signer.scheme() == scheme)
            .ok_or("a signature scheme the key doesn't support")?;
        signer.sign(message).map_err(|e| e.to_string())
    }
}

/// The listener's end of a worker's signing channel: answers one request, then closes.
pub struct Channel {
    stream: Option<UnixStream>,
}

/// What `Channel::serve` did.
#[derive(Debug, PartialEq, Eq)]
pub enum Served {
    /// nothing to read yet
    Waiting,
    /// signed the request (or tried to: the reply may not have been delivered); the channel is closed
    Signed,
    /// refused the request, with why; the channel is closed
    Refused(String),
    /// the worker closed its end without asking (or the channel was already used)
    Closed,
}

impl Channel {
    /// `stream`: the listener's end, non-blocking.
    pub fn new(stream: UnixStream) -> Channel {
        Channel { stream: Some(stream) }
    }

    /// Our end, for polling (None once it is closed).
    pub fn stream(&self) -> Option<&UnixStream> {
        self.stream.as_ref()
    }

    /// Read the worker's request and answer it, once (call it when the channel is readable). After a request, signed
    /// or refused, the channel is closed: a worker gets at most one signature.
    pub fn serve(&mut self, key: &Key) -> Served {
        let Some(stream) = self.stream.as_mut() else {
            return Served::Closed;
        };
        // (one more than the longest request: a longer packet arrives truncated and is refused by its length)
        let mut request = [0u8; MAX_REQUEST + 1];
        let size = match stream.read(&mut request) {
            Ok(size) => size,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::Interrupted => {
                return Served::Waiting;
            }
            Err(_) => 0,
        };
        let mut stream = self.stream.take().expect("checked above");
        if size == 0 {
            return Served::Closed;
        }
        match key.sign(&request[..size]) {
            Ok(signature) => {
                // (a fresh socket: one packet fits in its buffer; if not, the worker's handshake fails)
                let _ = stream.write(&signature);
                Served::Signed
            }
            Err(why) => Served::Refused(why),
        }
    }
}

fn algorithm(scheme: SignatureScheme) -> SignatureAlgorithm {
    match scheme {
        SignatureScheme::ECDSA_NISTP256_SHA256
        | SignatureScheme::ECDSA_NISTP384_SHA384
        | SignatureScheme::ECDSA_NISTP521_SHA512 => SignatureAlgorithm::ECDSA,
        SignatureScheme::ED25519 => SignatureAlgorithm::ED25519,
        SignatureScheme::ED448 => SignatureAlgorithm::ED448,
        _ => SignatureAlgorithm::RSA,
    }
}

/// The worker's stand-in for the key: rustls's signing-key interface, signing through the listener. The channel is
/// blocking, with a read timeout (the handshake's), set by the worker.
pub struct RemoteKey {
    channel: Arc<UnixStream>,
    /// the key's schemes, in our order of preference (from the listener, see tls::Public)
    schemes: Vec<SignatureScheme>,
}

impl RemoteKey {
    pub fn new(channel: UnixStream, schemes: Vec<SignatureScheme>) -> RemoteKey {
        RemoteKey { channel: Arc::new(channel), schemes }
    }
}

impl fmt::Debug for RemoteKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RemoteKey").field("schemes", &self.schemes).finish()
    }
}

impl SigningKey for RemoteKey {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        let scheme = self.schemes.iter().find(|scheme| offered.contains(scheme))?;
        Some(Box::new(RemoteSigner { channel: self.channel.clone(), scheme: *scheme }))
    }

    fn algorithm(&self) -> SignatureAlgorithm {
        self.schemes.first().map(|&scheme| algorithm(scheme)).unwrap_or(SignatureAlgorithm::Unknown(0))
    }
}

struct RemoteSigner {
    channel: Arc<UnixStream>,
    scheme: SignatureScheme,
}

impl fmt::Debug for RemoteSigner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RemoteSigner").field("scheme", &self.scheme).finish()
    }
}

impl Signer for RemoteSigner {
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, rustls::Error> {
        let failed = |what: &str| rustls::Error::General(format!("signing through the listener: {what}"));
        let mut request = Vec::with_capacity(2 + message.len());
        request.extend_from_slice(&self.scheme.to_array());
        request.extend_from_slice(message);
        let mut channel = &*self.channel;
        match channel.write(&request) {
            Ok(n) if n == request.len() => {}
            Ok(_) => return Err(failed("short write")),
            Err(e) => return Err(failed(&e.to_string())),
        }
        let mut signature = vec![0u8; MAX_SIGNATURE];
        loop {
            match channel.read(&mut signature) {
                Ok(0) => return Err(failed("refused")),
                Ok(n) => {
                    signature.truncate(n);
                    return Ok(signature);
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(failed(&e.to_string())),
            }
        }
    }

    fn scheme(&self) -> SignatureScheme {
        self.scheme
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};

    fn layout(hash: &[u8]) -> Vec<u8> {
        let mut message = vec![0x20u8; 64];
        message.extend_from_slice(b"TLS 1.3, server CertificateVerify\0");
        message.extend_from_slice(hash);
        message
    }

    fn request(scheme: SignatureScheme, message: &[u8]) -> Vec<u8> {
        let mut request = scheme.to_array().to_vec();
        request.extend_from_slice(message);
        request
    }

    fn p256() -> (Arc<dyn SigningKey>, Vec<u8>) {
        let rng = ring::rand::SystemRandom::new();
        let alg = &ring::signature::ECDSA_P256_SHA256_ASN1_SIGNING;
        let pkcs8 = ring::signature::EcdsaKeyPair::generate_pkcs8(alg, &rng).unwrap();
        let pair = ring::signature::EcdsaKeyPair::from_pkcs8(alg, pkcs8.as_ref(), &rng).unwrap();
        use ring::signature::KeyPair;
        let public = pair.public_key().as_ref().to_vec();
        let der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pkcs8.as_ref().to_vec()));
        (rustls::crypto::ring::sign::any_supported_type(&der).unwrap(), public)
    }

    fn verify(public: &[u8], message: &[u8], signature: &[u8]) -> bool {
        ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_ASN1, public)
            .verify(message, signature)
            .is_ok()
    }

    #[test]
    fn our_cipher_suites_hash_with_sha256_and_sha384() {
        assert_eq!(transcript_hash_lengths(), vec![32, 48]);
    }

    #[test]
    fn accepts_exactly_the_certificate_verify_layout() {
        let lengths = [32, 48];
        let scheme = SignatureScheme::ECDSA_NISTP256_SHA256;
        for hash in [[7u8; 32].as_slice(), [7u8; 48].as_slice()] {
            let message = layout(hash);
            assert_eq!(check_request(&request(scheme, &message), &lengths), Ok((scheme, message.as_slice())));
        }
        let refused = |request: Vec<u8>| check_request(&request, &lengths).is_err();
        // other hash lengths, or nothing after the context
        for length in [0, 1, 31, 33, 47, 49, 64] {
            assert!(refused(request(scheme, &layout(&vec![7u8; length]))), "hash length {length}");
        }
        // the client's CertificateVerify context, a different context, a missing 0 byte, other padding
        let mut client = vec![0x20u8; 64];
        client.extend_from_slice(b"TLS 1.3, client CertificateVerify\0");
        client.extend_from_slice(&[7u8; 32]);
        assert!(refused(request(scheme, &client)));
        let mut message = layout(&[7u8; 32]);
        message[64 + 33] = b'!';
        assert!(refused(request(scheme, &message)));
        let mut message = layout(&[7u8; 32]);
        message[0] = 0x21;
        assert!(refused(request(scheme, &message)));
        // arbitrary content of a valid length, nothing, a lone scheme
        assert!(refused(request(scheme, &[0x20u8; 64 + 34 + 32])));
        assert!(refused(Vec::new()));
        assert!(refused(vec![4, 3]));
        // schemes TLS 1.3 doesn't allow
        let legacy = [SignatureScheme::RSA_PKCS1_SHA256, SignatureScheme::ECDSA_SHA1_Legacy, SignatureScheme::from(0)];
        for scheme in legacy {
            assert!(refused(request(scheme, &layout(&[7u8; 32]))));
        }
    }

    #[test]
    fn signs_with_the_key_only_its_own_schemes() {
        let (key, public) = p256();
        assert_eq!(schemes_of(&*key), vec![SignatureScheme::ECDSA_NISTP256_SHA256]);
        let key = Key::new(key);
        let message = layout(&[1u8; 32]);
        let signature = key.sign(&request(SignatureScheme::ECDSA_NISTP256_SHA256, &message)).unwrap();
        assert!(verify(&public, &message, &signature));
        assert!(key.sign(&request(SignatureScheme::ECDSA_NISTP384_SHA384, &message)).is_err());
        assert!(key.sign(&request(SignatureScheme::RSA_PSS_SHA256, &message)).is_err());
    }

    fn channel_pair() -> (Channel, RemoteKey) {
        let (ours, theirs) = crate::sys::seqpacket_pair().unwrap();
        let ours = UnixStream::from(ours);
        ours.set_nonblocking(true).unwrap();
        let theirs = UnixStream::from(theirs);
        theirs.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
        (Channel::new(ours), RemoteKey::new(theirs, vec![SignatureScheme::ECDSA_NISTP256_SHA256]))
    }

    /// The worker's side signs in a thread (it blocks until the listener's side answers).
    fn sign_remotely(remote: &RemoteKey, message: Vec<u8>) -> std::thread::JoinHandle<Result<Vec<u8>, rustls::Error>> {
        let signer = remote.choose_scheme(&[SignatureScheme::RSA_PSS_SHA256, SignatureScheme::ECDSA_NISTP256_SHA256]);
        let signer = signer.expect("a scheme");
        std::thread::spawn(move || signer.sign(&message))
    }

    fn serve_when_asked(channel: &mut Channel, key: &Key) -> Served {
        loop {
            match channel.serve(key) {
                Served::Waiting => std::thread::sleep(std::time::Duration::from_millis(1)),
                served => return served,
            }
        }
    }

    #[test]
    fn signs_once_per_channel() {
        let (key, public) = p256();
        let key = Key::new(key);
        let (mut channel, remote) = channel_pair();
        assert_eq!(channel.serve(&key), Served::Waiting);
        let message = layout(&[2u8; 32]);
        let asking = sign_remotely(&remote, message.clone());
        assert_eq!(serve_when_asked(&mut channel, &key), Served::Signed);
        assert!(verify(&public, &message, &asking.join().unwrap().unwrap()));
        // the second request finds the channel closed
        assert!(channel.stream().is_none());
        assert_eq!(channel.serve(&key), Served::Closed);
        assert!(sign_remotely(&remote, message).join().unwrap().is_err());
    }

    #[test]
    fn refuses_other_content_and_closes() {
        let (key, _) = p256();
        let key = Key::new(key);
        let (mut channel, remote) = channel_pair();
        let asking = sign_remotely(&remote, b"anything else".to_vec());
        assert!(matches!(serve_when_asked(&mut channel, &key), Served::Refused(_)));
        assert!(asking.join().unwrap().is_err());
        // and nothing more after that, not even the real layout
        assert!(sign_remotely(&remote, layout(&[3u8; 32])).join().unwrap().is_err());
    }

    #[test]
    fn refuses_an_oversized_packet() {
        let (key, _) = p256();
        let key = Key::new(key);
        let (mut channel, remote) = channel_pair();
        let mut message = layout(&[4u8; 32]);
        message.extend_from_slice(&[0u8; 1000]);
        let asking = sign_remotely(&remote, message);
        assert!(matches!(serve_when_asked(&mut channel, &key), Served::Refused(_)));
        assert!(asking.join().unwrap().is_err());
    }
}
