//! TLS: the certificate and key (configured, or a self-signed pair generated on first run), and the rustls server
//! configuration every worker builds: TLS 1.3 only, ring as the crypto provider. The key stays in the listener: a
//! worker gets the certificate chain and the key's signature schemes (the public memfd, below) and signs through the
//! listener (signing.rs).
//!
//! # The public memfd's layout (fd 7 of a worker)
//!
//! ```text
//!   u8   number of signature schemes, 1..=8
//!   u16  each scheme, big-endian (TLS code points): the TLS 1.3 schemes the key signs with, preferred first
//!   then the certificate chain, leaf first, to the end:
//!   u32  certificate length, big-endian, at least 1
//!   ...  certificate, DER
//! ```
use rustls::crypto::ring::{default_provider, sign::any_supported_type};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::sign::{CertifiedKey, SigningKey, SingleCertAndKey};
use rustls::{ServerConfig, SignatureScheme};
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use crate::signing::{scheme_code, schemes_of, TLS13_SCHEMES};
use nebula_login_common::log;

/// The server configuration for a certificate chain and its key (in a worker, the listener's key behind the signing
/// channel).
pub fn server_config(chain: Vec<CertificateDer<'static>>, key: Arc<dyn SigningKey>) -> Arc<ServerConfig> {
    let mut config = ServerConfig::builder_with_provider(Arc::new(default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .expect("ring supports TLS 1.3")
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(SingleCertAndKey::from(CertifiedKey::new(chain, key))));
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    // every connection is a fresh process: there is nothing to resume a session from
    config.send_tls13_tickets = 0;
    Arc::new(config)
}

/// The certificate chain and the key, as the listener holds them.
pub struct Credentials {
    pub chain: Vec<CertificateDer<'static>>,
    pub key: Arc<dyn SigningKey>,
}

impl Credentials {
    /// From PEM texts: the chain's certificates in `cert_pem` (anything else in it is ignored), one private key in
    /// `key_pem`. Checks that the key is the leaf certificate's and can sign in TLS 1.3.
    pub fn from_pem(cert_pem: &[u8], key_pem: &[u8]) -> Result<Credentials, String> {
        let chain = CertificateDer::pem_slice_iter(cert_pem)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("reading the certificate: {e}"))?;
        if chain.is_empty() {
            return Err("no certificate".into());
        }
        let der = PrivateKeyDer::from_pem_slice(key_pem).map_err(|e| format!("reading the private key: {e}"))?;
        let key = any_supported_type(&der).map_err(|e| format!("the private key: {e}"))?;
        CertifiedKey::new(chain.clone(), key.clone()).keys_match().map_err(|e| format!("the key: {e}"))?;
        if schemes_of(&*key).is_empty() {
            return Err("the key can't sign in TLS 1.3".into());
        }
        Ok(Credentials { chain, key })
    }

    /// What a worker gets: the chain and the key's schemes (see "The public memfd's layout").
    pub fn public(&self) -> Vec<u8> {
        let schemes = schemes_of(&*self.key);
        let mut bytes = vec![schemes.len() as u8];
        for scheme in schemes {
            bytes.extend_from_slice(&scheme_code(scheme).to_be_bytes());
        }
        for cert in &self.chain {
            bytes.extend_from_slice(&(cert.len() as u32).to_be_bytes());
            bytes.extend_from_slice(cert);
        }
        bytes
    }
}

/// A worker's reading of the public memfd: the certificate chain and the key's signature schemes.
pub fn parse_public(bytes: &[u8]) -> Result<(Vec<CertificateDer<'static>>, Vec<SignatureScheme>), String> {
    let malformed = || "malformed certificate memfd".to_string();
    let (&count, mut rest) = bytes.split_first().ok_or_else(malformed)?;
    let count = count as usize;
    if count == 0 || count > TLS13_SCHEMES.len() || rest.len() < 2 * count {
        return Err(malformed());
    }
    let schemes = rest[..2 * count]
        .chunks(2)
        .map(|code| SignatureScheme::from(u16::from_be_bytes([code[0], code[1]])))
        .collect::<Vec<_>>();
    if !schemes.iter().all(|scheme| TLS13_SCHEMES.contains(scheme)) {
        return Err(malformed());
    }
    rest = &rest[2 * count..];
    let mut chain = Vec::new();
    while !rest.is_empty() {
        let length = rest.get(..4).ok_or_else(malformed)?;
        let length = u32::from_be_bytes([length[0], length[1], length[2], length[3]]) as usize;
        let cert = rest.get(4..4 + length).filter(|cert| !cert.is_empty()).ok_or_else(malformed)?;
        chain.push(CertificateDer::from(cert.to_vec()));
        rest = &rest[4 + length..];
    }
    if chain.is_empty() {
        return Err(malformed());
    }
    Ok((chain, schemes))
}

/// The configured certificate and key (`files`), or the self-signed pair in `<state_dir>/tls/`, generated if missing.
/// Logs the certificate's fingerprint.
pub fn load(files: Option<(PathBuf, PathBuf)>, state_dir: &Path) -> Result<Credentials, String> {
    let (cert_file, key_file) = match files {
        Some(files) => files,
        None => {
            let dir = state_dir.join("tls");
            let files = (dir.join("cert.pem"), dir.join("key.pem"));
            if !files.0.exists() || !files.1.exists() {
                generate_self_signed(&dir, &files.0, &files.1)?;
            }
            files
        }
    };
    let read = |file: &Path| fs::read(file).map_err(|e| format!("reading {}: {e}", file.display()));
    let credentials = Credentials::from_pem(&read(&cert_file)?, &read(&key_file)?)
        .map_err(|e| format!("{} / {}: {e}", cert_file.display(), key_file.display()))?;
    let fingerprint = ring::digest::digest(&ring::digest::SHA256, &credentials.chain[0]);
    let fingerprint: Vec<String> = fingerprint.as_ref().iter().map(|b| format!("{b:02X}")).collect();
    log::info(&format!("TLS certificate {}", cert_file.display()));
    log::info(&format!("  SHA-256 fingerprint: {}", fingerprint.join(":")));
    Ok(credentials)
}

/// A self-signed certificate for this host (and localhost), made with openssl.
fn generate_self_signed(dir: &Path, cert_file: &Path, key_file: &Path) -> Result<(), String> {
    let failed = |e: io::Error| format!("generating a TLS certificate in {}: {e}", dir.display());
    fs::create_dir_all(dir).map_err(failed)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(failed)?;
    let host = crate::sys::hostname();
    let host = if host.is_empty() { "localhost".to_string() } else { host };
    log::info(&format!("Generating a self-signed TLS certificate for \"{host}\" in {}", dir.display()));
    let output = Command::new("openssl")
        .args(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "825"])
        .arg("-subj")
        .arg(format!("/CN={host}"))
        .arg("-addext")
        .arg(format!("subjectAltName=DNS:{host},DNS:localhost,IP:127.0.0.1,IP:::1"))
        .arg("-keyout")
        .arg(key_file)
        .arg("-out")
        .arg(cert_file)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run openssl to generate a TLS certificate: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not generate a TLS certificate with openssl: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    fs::set_permissions(key_file, fs::Permissions::from_mode(0o600)).map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generated(name: &str) -> Credentials {
        let dir = std::env::temp_dir().join(format!("nebula-tls-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (cert, key) = (dir.join("cert.pem"), dir.join("key.pem"));
        generate_self_signed(&dir, &cert, &key).unwrap();
        let credentials = Credentials::from_pem(&fs::read(&cert).unwrap(), &fs::read(&key).unwrap()).unwrap();
        let _ = fs::remove_dir_all(&dir);
        credentials
    }

    #[test]
    fn workers_get_the_chain_and_the_schemes_not_the_key() {
        let credentials = generated("public");
        let public = credentials.public();
        let (chain, schemes) = parse_public(&public).unwrap();
        assert_eq!(chain, credentials.chain);
        assert_eq!(schemes, vec![SignatureScheme::ECDSA_NISTP256_SHA256]);
        // exactly the scheme list and the certificates
        assert_eq!(public.len(), 1 + 2 + 4 + chain[0].len());
    }

    #[test]
    fn malformed_public_memfds_are_refused() {
        let public = generated("malformed").public();
        assert!(parse_public(&public[..public.len() - 1]).is_err());
        assert!(parse_public(&public[..3]).is_err());
        assert!(parse_public(&[]).is_err());
        let mut no_schemes = public.clone();
        no_schemes[0] = 0;
        assert!(parse_public(&no_schemes).is_err());
        // RSA PKCS#1 isn't a TLS 1.3 scheme
        let mut pkcs1 = public.clone();
        pkcs1[1..3].copy_from_slice(&[0x04, 0x01]);
        assert!(parse_public(&pkcs1).is_err());
    }
}
