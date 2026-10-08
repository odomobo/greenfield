//! The page and its files, loaded once by the listener into one sealed memfd that every worker maps read-only and
//! serves from (workers never open files).
//!
//! # Bundle layout
//!
//! A sequence of entries, nothing before or after them:
//!
//! ```text
//!   u16  path length, big-endian, 1..=MAX_PATH
//!   ...  path, UTF-8, relative, '/'-separated, no "." or ".." components: the URL path without its leading '/'
//!        ("index.html" is the page itself, served at "/"; "static/theme.css"; "assets/index-1234.js")
//!   u32  content length, big-endian
//!   ...  content
//! ```
//!
//! The worker checks every length against the bundle's size; a malformed bundle is an error (it exits).
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;

pub const MAX_PATH: usize = 1024;
/// The page's path in the bundle (served at "/").
pub const PAGE: &str = "index.html";
/// Limits on what the listener loads (a misconfigured directory mustn't fill memory).
const MAX_FILES: usize = 10_000;
const MAX_TOTAL: usize = 256 << 20;
const MAX_DEPTH: usize = 8;

/// Builds a bundle.
#[derive(Default)]
pub struct Builder {
    bytes: Vec<u8>,
    files: usize,
}

impl Builder {
    pub fn add(&mut self, path: &str, content: &[u8]) -> io::Result<()> {
        if !valid_path(path) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("unusable file name {path:?}")));
        }
        if self.files >= MAX_FILES || self.bytes.len() + content.len() > MAX_TOTAL || content.len() > u32::MAX as usize
        {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "too many or too large files for the page"));
        }
        self.bytes.extend_from_slice(&(path.len() as u16).to_be_bytes());
        self.bytes.extend_from_slice(path.as_bytes());
        self.bytes.extend_from_slice(&(content.len() as u32).to_be_bytes());
        self.bytes.extend_from_slice(content);
        self.files += 1;
        Ok(())
    }

    /// Add the files under `dir` (recursively, following symbolic links), as `prefix/<relative path>`.
    pub fn add_dir(&mut self, prefix: &str, dir: &Path) -> io::Result<()> {
        self.add_dir_at(prefix, dir, 0)
    }

    fn add_dir_at(&mut self, prefix: &str, dir: &Path, depth: usize) -> io::Result<()> {
        if depth > MAX_DEPTH {
            return Ok(());
        }
        let mut entries = fs::read_dir(dir)?.collect::<io::Result<Vec<_>>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let path = format!("{prefix}/{name}");
            let metadata = fs::metadata(entry.path())?;
            if metadata.is_dir() {
                self.add_dir_at(&path, &entry.path(), depth + 1)?;
            } else if metadata.is_file() && valid_path(&path) {
                self.add(&path, &fs::read(entry.path())?)?;
            }
        }
        Ok(())
    }

    pub fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= MAX_PATH
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

/// A bundle's files, borrowed from its bytes.
pub struct Assets<'a> {
    files: HashMap<&'a str, &'a [u8]>,
}

impl<'a> Assets<'a> {
    pub fn parse(mut bytes: &'a [u8]) -> io::Result<Assets<'a>> {
        let malformed = || io::Error::new(io::ErrorKind::InvalidData, "malformed page bundle");
        let mut files = HashMap::new();
        while !bytes.is_empty() {
            let (length, rest) = bytes.split_first_chunk::<2>().ok_or_else(malformed)?;
            let length = u16::from_be_bytes(*length) as usize;
            if length == 0 || length > MAX_PATH || rest.len() < length {
                return Err(malformed());
            }
            let (path, rest) = rest.split_at(length);
            let path = std::str::from_utf8(path).map_err(|_| malformed())?;
            let (length, rest) = rest.split_first_chunk::<4>().ok_or_else(malformed)?;
            let length = u32::from_be_bytes(*length) as usize;
            if rest.len() < length {
                return Err(malformed());
            }
            let (content, rest) = rest.split_at(length);
            files.insert(path, content);
            bytes = rest;
        }
        Ok(Assets { files })
    }

    /// The file at a URL path's bundle path (the URL path without its leading '/').
    pub fn get(&self, path: &str) -> Option<&'a [u8]> {
        self.files.get(path).copied()
    }
}

/// A file's Content-Type, from its name.
pub fn content_type(path: &str) -> &'static str {
    let extension = path.rsplit_once('.').map(|(_, extension)| extension).unwrap_or("");
    match extension {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundles_round_trip() {
        let mut builder = Builder::default();
        builder.add(PAGE, b"<html>").unwrap();
        builder.add("assets/a.js", b"").unwrap();
        builder.add("static/theme.css", b"body {}").unwrap();
        let bytes = builder.finish();
        let assets = Assets::parse(&bytes).unwrap();
        assert_eq!(assets.get(PAGE), Some(&b"<html>"[..]));
        assert_eq!(assets.get("assets/a.js"), Some(&b""[..]));
        assert_eq!(assets.get("static/theme.css"), Some(&b"body {}"[..]));
        assert_eq!(assets.get("static/other.css"), None);
        // any truncation is malformed
        for end in 1..bytes.len() {
            if end != 2 + PAGE.len() + 4 + 6 && end != bytes.len() - (2 + 16 + 4 + 7) {
                assert!(Assets::parse(&bytes[..end]).is_err(), "{end}");
            }
        }
    }

    #[test]
    fn unusable_paths_are_refused() {
        let mut builder = Builder::default();
        for path in ["", "/a", "a/", "a//b", "a/../b", "./a", ".."] {
            assert!(builder.add(path, b"x").is_err(), "{path}");
        }
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type("assets/index-1.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("static/background.jpg"), "image/jpeg");
        assert_eq!(content_type("static/README"), "application/octet-stream");
    }
}
