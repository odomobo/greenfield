//! TLS: the certificate and key (configured, or a self-signed pair generated on first run), and the rustls server
//! configuration every worker builds from them: TLS 1.3 only, ring as the crypto provider.
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use nebula_login_common::log;

/// The server configuration for a certificate chain and its key, both PEM in `pem` (the chain's certificates and one
/// private key, in any order).
pub fn server_config(pem: &[u8]) -> Result<Arc<ServerConfig>, String> {
    let chain = CertificateDer::pem_slice_iter(pem)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("reading the certificate: {e}"))?;
    if chain.is_empty() {
        return Err("no certificate".into());
    }
    let key = PrivateKeyDer::from_pem_slice(pem).map_err(|e| format!("reading the private key: {e}"))?;
    let mut config = ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .map_err(|e| e.to_string())?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    // every connection is a fresh process: there is nothing to resume a session from
    config.send_tls13_tickets = 0;
    Ok(Arc::new(config))
}

/// The configured certificate and key (`files`), or the self-signed pair in `<state_dir>/tls/`, generated if missing,
/// as one PEM text. Checked by building the server configuration; logs the certificate's fingerprint.
pub fn load(files: Option<(PathBuf, PathBuf)>, state_dir: &Path) -> Result<Vec<u8>, String> {
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
    let mut pem = read(&cert_file)?;
    pem.push(b'\n');
    pem.extend_from_slice(&read(&key_file)?);
    server_config(&pem).map_err(|e| format!("{} / {}: {e}", cert_file.display(), key_file.display()))?;
    let leaf = CertificateDer::pem_slice_iter(&pem).next().and_then(Result::ok).ok_or("no certificate")?;
    let fingerprint = ring::digest::digest(&ring::digest::SHA256, &leaf);
    let fingerprint: Vec<String> = fingerprint.as_ref().iter().map(|b| format!("{b:02X}")).collect();
    log::info(&format!("TLS certificate {}", cert_file.display()));
    log::info(&format!("  SHA-256 fingerprint: {}", fingerprint.join(":")));
    Ok(pem)
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
