//! A minimal HTTP/1.1 server side: request heads (with hard limits), the routes (the page, its files, redirects of old
//! addresses), responses with the security headers, and the checks of a WebSocket upgrade. Requests have no bodies:
//! only GET and HEAD are served, anything else gets 405 and the connection is closed.
use std::borrow::Cow;

use crate::assets::{self, Assets};

/// The longest request head (request line and headers), as Node's default.
pub const MAX_HEAD: usize = 16 * 1024;
pub const MAX_HEADERS: usize = 100;

#[derive(Debug, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    /// the request target as sent (origin-form: starts with '/')
    pub target: String,
    /// HTTP/1.1 (keep-alive by default) rather than HTTP/1.0
    pub http11: bool,
    /// names in lower case, values without surrounding white space
    pub headers: Vec<(String, String)>,
}

impl Request {
    /// The first value of a header (`name` in lower case).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, value)| value.as_str())
    }

    fn has_token(&self, name: &str, token: &str) -> bool {
        self.headers
            .iter()
            .filter(|(n, _)| n == name)
            .flat_map(|(_, value)| value.split(','))
            .any(|part| part.trim().eq_ignore_ascii_case(token))
    }

    /// The path, without the query or fragment.
    pub fn path(&self) -> &str {
        let end = self.target.find(['?', '#']).unwrap_or(self.target.len());
        &self.target[..end]
    }

    /// A WebSocket (or other protocol) upgrade.
    pub fn is_upgrade(&self) -> bool {
        self.header("upgrade").is_some() && self.has_token("connection", "upgrade")
    }

    /// Whether the connection stays open after the response.
    pub fn keep_alive(&self) -> bool {
        if self.has_token("connection", "close") {
            return false;
        }
        self.http11 || self.has_token("connection", "keep-alive")
    }

    /// Whether the request announces a body (which we don't read).
    pub fn has_body(&self) -> bool {
        self.header("transfer-encoding").is_some() || self.header("content-length").is_some_and(|length| length != "0")
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum HeadError {
    /// malformed: 400
    Malformed,
    /// over MAX_HEAD or MAX_HEADERS: 431
    TooLarge,
}

fn is_token_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&c)
}

/// A request head from the start of `bytes`: the request and the head's length (with its blank line), or None if more
/// bytes are needed.
pub fn parse_head(bytes: &[u8]) -> Result<Option<(Request, usize)>, HeadError> {
    let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
        return if bytes.len() >= MAX_HEAD { Err(HeadError::TooLarge) } else { Ok(None) };
    };
    if end + 4 > MAX_HEAD {
        return Err(HeadError::TooLarge);
    }
    let mut lines = bytes[..end].split(|&b| b == b'\n').map(|line| line.strip_suffix(b"\r").unwrap_or(line));
    let request_line = lines.next().ok_or(HeadError::Malformed)?;
    let mut parts = request_line.split(|&b| b == b' ');
    let (Some(method), Some(target), Some(version), None) = (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(HeadError::Malformed);
    };
    if method.is_empty() || !method.iter().all(|&c| is_token_char(c)) {
        return Err(HeadError::Malformed);
    }
    if !target.starts_with(b"/") || !target.iter().all(|&c| c > 0x20 && c < 0x7f) {
        return Err(HeadError::Malformed);
    }
    let http11 = match version {
        b"HTTP/1.1" => true,
        b"HTTP/1.0" => false,
        _ => return Err(HeadError::Malformed),
    };
    let mut headers = Vec::new();
    for line in lines {
        if line.contains(&b'\r') {
            return Err(HeadError::Malformed);
        }
        if headers.len() >= MAX_HEADERS {
            return Err(HeadError::TooLarge);
        }
        let colon = line.iter().position(|&b| b == b':').ok_or(HeadError::Malformed)?;
        let (name, value) = (&line[..colon], &line[colon + 1..]);
        // (no folded lines: a name starting with white space is not a token)
        if name.is_empty() || !name.iter().all(|&c| is_token_char(c)) {
            return Err(HeadError::Malformed);
        }
        if value.iter().any(|&c| (c < 0x20 && c != b'\t') || c == 0x7f) {
            return Err(HeadError::Malformed);
        }
        let value: String = value.iter().map(|&c| c as char).collect();
        headers.push((String::from_utf8_lossy(name).to_ascii_lowercase(), value.trim_matches([' ', '\t']).to_string()));
    }
    let request = Request {
        method: String::from_utf8_lossy(method).into_owned(),
        target: String::from_utf8_lossy(target).into_owned(),
        http11,
        headers,
    };
    Ok(Some((request, end + 4)))
}

const SECURITY_HEADERS: &[(&str, &str)] = &[
    (
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; \
         connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; \
         form-action 'none'",
    ),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    // not no-referrer: that makes browsers send "Origin: null" on same-origin requests, which the Origin check needs
    ("Referrer-Policy", "same-origin"),
    ("Cross-Origin-Opener-Policy", "same-origin"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=()"),
    ("Strict-Transport-Security", "max-age=31536000"),
];

pub struct Response<'a> {
    pub status: u16,
    pub headers: Vec<(&'static str, Cow<'a, str>)>,
    pub body: Cow<'a, [u8]>,
}

fn status_text(status: u16) -> &'static str {
    match status {
        101 => "Switching Protocols",
        200 => "OK",
        303 => "See Other",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        _ => "Internal Server Error",
    }
}

impl<'a> Response<'a> {
    fn new(status: u16, content_type: &'static str, cache: &'static str, body: Cow<'a, [u8]>) -> Response<'a> {
        let mut headers: Vec<(&'static str, Cow<'a, str>)> =
            SECURITY_HEADERS.iter().map(|&(name, value)| (name, Cow::Borrowed(value))).collect();
        headers.push(("Content-Type", Cow::Borrowed(content_type)));
        headers.push(("Cache-Control", Cow::Borrowed(cache)));
        Response { status, headers, body }
    }

    /// A page of ours (never cached).
    pub fn page(status: u16, body: Cow<'a, [u8]>) -> Response<'a> {
        Response::new(status, "text/html; charset=utf-8", "no-store", body)
    }

    pub fn error(status: u16) -> Response<'a> {
        Response::page(status, Cow::Owned(error_page(status).into_bytes()))
    }

    pub fn redirect(location: &'static str) -> Response<'a> {
        let mut response = Response::new(303, "text/html; charset=utf-8", "no-store", Cow::Borrowed(b""));
        response.headers.retain(|(name, _)| *name != "Content-Type");
        response.headers.push(("Location", Cow::Borrowed(location)));
        response
    }

    /// The bytes to send: the head, and the body unless `head_only` (HEAD). `close`: tell the client the connection
    /// closes after this.
    pub fn encode(&self, head_only: bool, close: bool) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {} {}\r\n", self.status, status_text(self.status)).into_bytes();
        for (name, value) in &self.headers {
            out.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
        }
        out.extend_from_slice(format!("Content-Length: {}\r\n", self.body.len()).as_bytes());
        out.extend_from_slice(if close { b"Connection: close\r\n\r\n" } else { b"Connection: keep-alive\r\n\r\n" });
        if !head_only {
            out.extend_from_slice(&self.body);
        }
        out
    }
}

/// The response to a request that isn't an upgrade.
pub fn route<'a>(request: &Request, assets: &Assets<'a>) -> Response<'a> {
    if request.method != "GET" && request.method != "HEAD" {
        let mut response = Response::error(405);
        response.headers.push(("Allow", Cow::Borrowed("GET")));
        return response;
    }
    let path = request.path();
    // the viewer's files and our public static files (no user data in them)
    if path.starts_with("/static/") || path.starts_with("/assets/") {
        return match assets.get(&path[1..]) {
            Some(content) => {
                Response::new(200, assets::content_type(path), "private, max-age=3600", Cow::Borrowed(content))
            }
            None => Response::error(404),
        };
    }
    // the one page: sign-in and desktop
    if path == "/" {
        if let Some(page) = assets.get(assets::PAGE) {
            return Response::page(200, Cow::Borrowed(page));
        }
        return Response::error(404);
    }
    // old addresses
    if path == "/login" || path == "/sessions" || path.starts_with("/desktop") {
        return Response::redirect("/");
    }
    Response::error(404)
}

/// The refusal of an upgrade (no security headers: there is no page).
pub fn refuse_upgrade(status: u16) -> Vec<u8> {
    format!("HTTP/1.1 {status} {}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", status_text(status)).into_bytes()
}

/// Why a WebSocket upgrade is refused (an HTTP status), if it is.
pub fn check_upgrade(request: &Request, allowed_origins: &[String]) -> Result<(), u16> {
    if request.path() != "/ws" {
        return Err(404);
    }
    if !origin_allowed(request, allowed_origins) {
        return Err(403);
    }
    let key_ok = request.header("sec-websocket-key").is_some_and(|key| {
        key.len() == 24
            && key.ends_with("==")
            && key[..22].bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
    });
    if !key_ok || request.header("sec-websocket-version") != Some("13") {
        return Err(400);
    }
    Ok(())
}

/// Same-origin check for the WebSocket: the browser-supplied Origin must match the host the request was sent to (or
/// an explicitly allowed origin). Requests without Origin are refused.
pub fn origin_allowed(request: &Request, allowed_origins: &[String]) -> bool {
    let (Some(origin), Some(host)) = (request.header("origin"), request.header("host")) else {
        return false;
    };
    origin == format!("https://{host}") || allowed_origins.iter().any(|allowed| allowed == origin)
}

pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// A server-rendered error page. No inline scripts or styles (the CSP forbids them), no product or version names.
pub fn error_page(status: u16) -> String {
    let text = match status {
        404 => "Not found",
        403 => "Forbidden",
        _ => "Something went wrong",
    };
    format!(
        "<!doctype html>
<html lang=\"en\">
<head>
<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
<meta name=\"referrer\" content=\"same-origin\">
<title>{text}</title>
<link rel=\"icon\" href=\"/static/icon-32.png\" type=\"image/png\" sizes=\"32x32\">
<link rel=\"icon\" href=\"/static/icon-16.png\" type=\"image/png\" sizes=\"16x16\">
<link rel=\"stylesheet\" href=\"/static/theme.css\">
</head>
<body>
<div class=\"page\">
<main class=\"card\"><h1>{text}</h1><p class=\"subtitle\"><a href=\"/\">Back</a></p></main>
</div>
</body>
</html>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::Builder;

    fn request(text: &str) -> Request {
        let (request, length) = parse_head(text.as_bytes()).unwrap().unwrap();
        assert_eq!(length, text.len());
        request
    }

    #[test]
    fn parses_request_heads() {
        let r = request(
            "GET /assets/a.js?v=1 HTTP/1.1\r\nHost: example\r\nX-Empty:\r\nConnection:  keep-alive , Upgrade\r\n\r\n",
        );
        assert_eq!(r.method, "GET");
        assert_eq!(r.path(), "/assets/a.js");
        assert_eq!(r.header("host"), Some("example"));
        assert_eq!(r.header("x-empty"), Some(""));
        assert!(r.keep_alive());
        assert!(!r.is_upgrade());
        assert!(!request("GET / HTTP/1.0\r\n\r\n").keep_alive());
        assert!(!request("GET / HTTP/1.1\r\nConnection: close\r\n\r\n").keep_alive());
        assert!(request("GET / HTTP/1.1\r\nContent-Length: 3\r\n\r\n").has_body());
        // incomplete
        assert_eq!(parse_head(b"GET / HTTP/1.1\r\nHost: x\r\n"), Ok(None));
        // a pipelined request after this one is not part of it
        assert_eq!(parse_head(b"GET / HTTP/1.1\r\n\r\nGET").unwrap().unwrap().1, 18);
    }

    #[test]
    fn refuses_malformed_and_large_heads() {
        for text in [
            "GET / HTTP/2\r\n\r\n",
            "GET  / HTTP/1.1\r\n\r\n",
            "GET http://x/ HTTP/1.1\r\n\r\n",
            "G(T / HTTP/1.1\r\n\r\n",
            "GET / HTTP/1.1\r\n folded: x\r\n\r\n",
            "GET / HTTP/1.1\r\nNo colon\r\n\r\n",
            "GET / HTTP/1.1\r\nX: a\0b\r\n\r\n",
        ] {
            assert_eq!(parse_head(text.as_bytes()), Err(HeadError::Malformed), "{text:?}");
        }
        let long = format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(MAX_HEAD));
        assert_eq!(parse_head(long.as_bytes()), Err(HeadError::TooLarge));
        assert_eq!(parse_head("a".repeat(MAX_HEAD).as_bytes()), Err(HeadError::TooLarge));
        let many = format!("GET / HTTP/1.1\r\n{}\r\n", "X: y\r\n".repeat(MAX_HEADERS + 1));
        assert_eq!(parse_head(many.as_bytes()), Err(HeadError::TooLarge));
    }

    #[test]
    fn routes() {
        let mut builder = Builder::default();
        builder.add("index.html", b"<html>page").unwrap();
        builder.add("assets/a.js", b"js").unwrap();
        builder.add("static/theme.css", b"css").unwrap();
        let bytes = builder.finish();
        let assets = Assets::parse(&bytes).unwrap();
        let get = |text: &str| route(&request(text), &assets);
        let header = |response: &Response, name: &str| {
            response.headers.iter().find(|(n, _)| *n == name).map(|(_, v)| v.to_string())
        };

        let page = get("GET / HTTP/1.1\r\n\r\n");
        assert_eq!((page.status, &*page.body), (200, &b"<html>page"[..]));
        assert_eq!(header(&page, "Cache-Control").as_deref(), Some("no-store"));
        assert!(header(&page, "Strict-Transport-Security").is_some());
        assert!(header(&page, "Content-Security-Policy").unwrap().contains("frame-ancestors 'none'"));
        let script = get("GET /assets/a.js HTTP/1.1\r\n\r\n");
        assert_eq!((script.status, &*script.body), (200, &b"js"[..]));
        assert_eq!(header(&script, "Content-Type").as_deref(), Some("text/javascript; charset=utf-8"));
        assert_eq!(get("GET /static/theme.css HTTP/1.1\r\n\r\n").status, 200);
        assert_eq!(get("GET /static/nothing.css HTTP/1.1\r\n\r\n").status, 404);
        assert_eq!(get("GET /assets/../index.html HTTP/1.1\r\n\r\n").status, 404);
        assert_eq!(get("GET /index.html HTTP/1.1\r\n\r\n").status, 404);
        assert_eq!(get("GET /api/me HTTP/1.1\r\n\r\n").status, 404);
        let redirect = get("GET /login HTTP/1.1\r\n\r\n");
        assert_eq!((redirect.status, header(&redirect, "Location").as_deref()), (303, Some("/")));
        let post = get("POST /api/login HTTP/1.1\r\n\r\n");
        assert_eq!((post.status, header(&post, "Allow").as_deref()), (405, Some("GET")));

        let head = get("HEAD / HTTP/1.1\r\n\r\n").encode(true, false);
        let text = String::from_utf8(head).unwrap();
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(text.contains("Content-Length: 10\r\n"));
        assert!(text.ends_with("\r\n\r\n"));
    }

    #[test]
    fn upgrade_checks() {
        let upgrade = |path: &str, origin: Option<&str>, key: &str| {
            let origin = origin.map(|o| format!("Origin: {o}\r\n")).unwrap_or_default();
            request(&format!(
                "GET {path} HTTP/1.1\r\nHost: h:1\r\n{origin}Connection: Upgrade\r\nUpgrade: websocket\r\n\
                 Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n\r\n"
            ))
        };
        let key = "dGhlIHNhbXBsZSBub25jZQ==";
        let allowed = vec!["https://desktop.example".to_string()];
        assert!(upgrade("/ws", Some("https://h:1"), key).is_upgrade());
        assert_eq!(check_upgrade(&upgrade("/ws", Some("https://h:1"), key), &allowed), Ok(()));
        assert_eq!(check_upgrade(&upgrade("/ws", Some("https://desktop.example"), key), &allowed), Ok(()));
        assert_eq!(check_upgrade(&upgrade("/control", Some("https://h:1"), key), &allowed), Err(404));
        assert_eq!(check_upgrade(&upgrade("/ws", Some("https://evil.example"), key), &allowed), Err(403));
        assert_eq!(check_upgrade(&upgrade("/ws", None, key), &allowed), Err(403));
        assert_eq!(check_upgrade(&upgrade("/ws", Some("http://h:1"), key), &allowed), Err(403));
        assert_eq!(check_upgrade(&upgrade("/ws", Some("https://h:1"), "short=="), &allowed), Err(400));
    }
}
