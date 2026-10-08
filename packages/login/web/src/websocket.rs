//! The WebSocket pieces the worker needs for the sign-in: the handshake's accept key, the page's sign-in frames (masked
//! text frames of at most SIGN_IN_MAX_FRAME_BYTES), our own text and close frames. After the sign-in the frames are
//! relayed as they are, unparsed.
use nebula_login_common::session_config::json_string;

/// The longest sign-in frame either side may send (SIGN_IN_MAX_FRAME_BYTES in libs/scene-protocol).
pub const MAX_FRAME: usize = 4096;
/// The sign-in failed, timed out or broke the rules (CLOSE_SIGN_IN_FAILED in libs/scene-protocol).
pub const CLOSE_SIGN_IN_FAILED: u16 = 4001;
const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let byte = |i: usize| *chunk.get(i).unwrap_or(&0) as u32;
        let n = byte(0) << 16 | byte(1) << 8 | byte(2);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Sec-WebSocket-Accept for a Sec-WebSocket-Key.
pub fn accept_key(key: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, format!("{key}{GUID}").as_bytes());
    base64(digest.as_ref())
}

/// The page's next frame from the start of `bytes`: the payload of a masked, unfragmented text frame of at most
/// MAX_FRAME bytes and the frame's size, None if more bytes are needed, Err if it's anything else.
pub fn parse_text_frame(bytes: &[u8]) -> Result<Option<(String, usize)>, ()> {
    if bytes.len() < 2 {
        return Ok(None);
    }
    let fin = bytes[0] & 0x80 != 0;
    let reserved = bytes[0] & 0x70;
    let opcode = bytes[0] & 0x0f;
    let masked = bytes[1] & 0x80 != 0;
    let mut length = (bytes[1] & 0x7f) as usize;
    let mut offset = 2;
    if !fin || reserved != 0 || opcode != 1 || !masked || length == 127 {
        return Err(());
    }
    if length == 126 {
        if bytes.len() < 4 {
            return Ok(None);
        }
        length = u16::from_be_bytes([bytes[2], bytes[3]]) as usize;
        offset = 4;
    }
    if length > MAX_FRAME {
        return Err(());
    }
    if bytes.len() < offset + 4 + length {
        return Ok(None);
    }
    let mask = &bytes[offset..offset + 4];
    let masked = &bytes[offset + 4..offset + 4 + length];
    let payload: Vec<u8> = masked.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]).collect();
    let payload = String::from_utf8(payload).map_err(|_| ())?;
    Ok(Some((payload, offset + 4 + length)))
}

fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0x80 | opcode];
    if payload.len() < 126 {
        out.push(payload.len() as u8);
    } else if payload.len() <= 0xffff {
        out.push(126);
        out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        out.push(127);
        out.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    out.extend_from_slice(payload);
    out
}

/// A text frame (server frames are unmasked).
pub fn text_frame(text: &str) -> Vec<u8> {
    frame(1, text.as_bytes())
}

/// A close frame.
pub fn close_frame(code: u16, reason: &str) -> Vec<u8> {
    let mut payload = code.to_be_bytes().to_vec();
    payload.extend_from_slice(&reason.as_bytes()[..reason.len().min(123)]);
    frame(8, &payload)
}

/// The page's sign-in messages ("Sign-in" in libs/scene-protocol).
#[derive(Debug, PartialEq, Eq)]
pub enum ClientMessage {
    Begin { username: String },
    Answer { text: String },
}

impl ClientMessage {
    /// The message in a frame's payload, if it is one.
    pub fn parse(payload: &str) -> Option<ClientMessage> {
        let json::Value::Object(fields) = json::parse(payload)? else {
            return None;
        };
        // (as JSON.parse: the last of duplicate keys counts)
        let string = |name: &str| {
            fields.iter().rev().find(|(key, _)| key == name).and_then(|(_, value)| match value {
                json::Value::String(text) => Some(text.clone()),
                _ => None,
            })
        };
        match string("type")?.as_str() {
            "begin" => Some(ClientMessage::Begin { username: string("username")? }),
            "answer" => Some(ClientMessage::Answer { text: string("text")? }),
            _ => None,
        }
    }
}

/// Our sign-in messages, as JSON.
pub enum ServerMessage<'a> {
    Prompt { text: &'a str, echo: bool },
    Info { text: &'a str },
    Error { text: &'a str },
    SignedIn { username: &'a str },
    Failed { message: &'a str },
}

impl ServerMessage<'_> {
    pub fn json(&self) -> String {
        match self {
            ServerMessage::Prompt { text, echo } => {
                format!("{{\"type\":\"prompt\",\"text\":{},\"echo\":{echo}}}", json_string(text))
            }
            ServerMessage::Info { text } => format!("{{\"type\":\"info\",\"text\":{}}}", json_string(text)),
            ServerMessage::Error { text } => format!("{{\"type\":\"error\",\"text\":{}}}", json_string(text)),
            ServerMessage::SignedIn { username } => {
                format!("{{\"type\":\"result\",\"ok\":true,\"username\":{}}}", json_string(username))
            }
            ServerMessage::Failed { message } => {
                format!("{{\"type\":\"result\",\"ok\":false,\"message\":{}}}", json_string(message))
            }
        }
    }

    pub fn frame(&self) -> Vec<u8> {
        text_frame(&self.json())
    }
}

/// Just enough JSON for the page's messages: a whole RFC 8259 document into values, nested at most MAX_DEPTH deep.
mod json {
    const MAX_DEPTH: usize = 16;

    #[derive(Debug)]
    pub enum Value {
        Null,
        Bool,
        Number,
        String(String),
        Array,
        Object(Vec<(String, Value)>),
    }

    struct Parser<'a> {
        bytes: &'a [u8],
        at: usize,
    }

    pub fn parse(text: &str) -> Option<Value> {
        let mut parser = Parser { bytes: text.as_bytes(), at: 0 };
        let value = parser.value(0)?;
        parser.space();
        (parser.at == parser.bytes.len()).then_some(value)
    }

    impl Parser<'_> {
        fn peek(&self) -> Option<u8> {
            self.bytes.get(self.at).copied()
        }

        fn space(&mut self) {
            while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
                self.at += 1;
            }
        }

        fn literal(&mut self, word: &[u8]) -> Option<()> {
            self.bytes[self.at..].starts_with(word).then(|| self.at += word.len())
        }

        fn value(&mut self, depth: usize) -> Option<Value> {
            if depth > MAX_DEPTH {
                return None;
            }
            self.space();
            match self.peek()? {
                b'n' => self.literal(b"null").map(|_| Value::Null),
                b't' => self.literal(b"true").map(|_| Value::Bool),
                b'f' => self.literal(b"false").map(|_| Value::Bool),
                b'"' => self.string().map(Value::String),
                b'[' => {
                    self.at += 1;
                    self.space();
                    if self.peek()? == b']' {
                        self.at += 1;
                        return Some(Value::Array);
                    }
                    loop {
                        self.value(depth + 1)?;
                        self.space();
                        match self.peek()? {
                            b',' => self.at += 1,
                            b']' => {
                                self.at += 1;
                                return Some(Value::Array);
                            }
                            _ => return None,
                        }
                    }
                }
                b'{' => {
                    self.at += 1;
                    let mut fields = Vec::new();
                    self.space();
                    if self.peek()? == b'}' {
                        self.at += 1;
                        return Some(Value::Object(fields));
                    }
                    loop {
                        self.space();
                        if self.peek()? != b'"' {
                            return None;
                        }
                        let key = self.string()?;
                        self.space();
                        if self.peek()? != b':' {
                            return None;
                        }
                        self.at += 1;
                        let value = self.value(depth + 1)?;
                        fields.push((key, value));
                        self.space();
                        match self.peek()? {
                            b',' => self.at += 1,
                            b'}' => {
                                self.at += 1;
                                return Some(Value::Object(fields));
                            }
                            _ => return None,
                        }
                    }
                }
                b'-' | b'0'..=b'9' => self.number().map(|_| Value::Number),
                _ => None,
            }
        }

        fn digits(&mut self) -> usize {
            let start = self.at;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.at += 1;
            }
            self.at - start
        }

        fn number(&mut self) -> Option<()> {
            if self.peek() == Some(b'-') {
                self.at += 1;
            }
            if self.peek() == Some(b'0') {
                self.at += 1;
            } else if self.digits() == 0 {
                return None;
            }
            if self.peek() == Some(b'.') {
                self.at += 1;
                if self.digits() == 0 {
                    return None;
                }
            }
            if matches!(self.peek(), Some(b'e' | b'E')) {
                self.at += 1;
                if matches!(self.peek(), Some(b'+' | b'-')) {
                    self.at += 1;
                }
                if self.digits() == 0 {
                    return None;
                }
            }
            Some(())
        }

        fn hex4(&mut self) -> Option<u32> {
            let digits = self.bytes.get(self.at..self.at + 4)?;
            let text = std::str::from_utf8(digits).ok()?;
            if !text.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            self.at += 4;
            u32::from_str_radix(text, 16).ok()
        }

        fn string(&mut self) -> Option<String> {
            // at the opening quote
            self.at += 1;
            let mut out = String::new();
            loop {
                let start = self.at;
                while matches!(self.peek(), Some(c) if c != b'"' && c != b'\\' && c >= 0x20) {
                    self.at += 1;
                }
                // (the input is a str, and we stopped at ASCII: a char boundary)
                out.push_str(std::str::from_utf8(&self.bytes[start..self.at]).ok()?);
                match self.peek()? {
                    b'"' => {
                        self.at += 1;
                        return Some(out);
                    }
                    b'\\' => {
                        self.at += 1;
                        let escape = self.peek()?;
                        self.at += 1;
                        match escape {
                            b'"' => out.push('"'),
                            b'\\' => out.push('\\'),
                            b'/' => out.push('/'),
                            b'b' => out.push('\u{8}'),
                            b'f' => out.push('\u{c}'),
                            b'n' => out.push('\n'),
                            b'r' => out.push('\r'),
                            b't' => out.push('\t'),
                            b'u' => {
                                let unit = self.hex4()?;
                                let high = (0xd800..0xdc00).contains(&unit);
                                let c = if high && self.bytes[self.at..].starts_with(b"\\u") {
                                    let saved = self.at;
                                    self.at += 2;
                                    match self.hex4() {
                                        Some(low) if (0xdc00..0xe000).contains(&low) => {
                                            char::from_u32(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00))
                                        }
                                        _ => {
                                            self.at = saved;
                                            None
                                        }
                                    }
                                } else {
                                    char::from_u32(unit)
                                };
                                // (a lone surrogate, as JSON.parse keeps it; in UTF-8 it becomes U+FFFD)
                                out.push(c.unwrap_or('\u{fffd}'));
                            }
                            _ => return None,
                        }
                    }
                    // a control character
                    _ => return None,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked(opcode: u8, payload: &[u8]) -> Vec<u8> {
        let mask = [1u8, 2, 3, 4];
        let mut out = vec![0x80 | opcode];
        if payload.len() < 126 {
            out.push(0x80 | payload.len() as u8);
        } else {
            out.push(0x80 | 126);
            out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        }
        out.extend_from_slice(&mask);
        out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        out
    }

    #[test]
    fn accept_key_of_the_rfc_example() {
        assert_eq!(accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
    }

    #[test]
    fn parses_sign_in_frames() {
        let frame = masked(1, b"{\"type\":\"begin\",\"username\":\"josh\"}");
        let (payload, size) = parse_text_frame(&frame).unwrap().unwrap();
        assert_eq!((payload.as_str(), size), ("{\"type\":\"begin\",\"username\":\"josh\"}", frame.len()));
        for end in 0..frame.len() {
            assert_eq!(parse_text_frame(&frame[..end]), Ok(None));
        }
        let long = masked(1, &[b'a'; 300]);
        assert_eq!(parse_text_frame(&long).unwrap().unwrap().1, long.len());
        assert!(parse_text_frame(&masked(2, b"binary")).is_err());
        assert!(parse_text_frame(&masked(1, &[b'a'; MAX_FRAME + 1])).is_err());
        assert!(parse_text_frame(&[0x81, 5, b'h', b'e', b'l', b'l', b'o']).is_err(), "unmasked");
        assert!(parse_text_frame(&masked(1, &[0xff])).is_err(), "not UTF-8");
        let mut fragment = masked(1, b"x");
        fragment[0] &= 0x7f;
        assert!(parse_text_frame(&fragment).is_err());
    }

    #[test]
    fn sign_in_messages() {
        assert_eq!(
            ClientMessage::parse(r#" {"type":"begin","username":"josh\n"} "#),
            Some(ClientMessage::Begin { username: "josh\n".into() })
        );
        assert_eq!(
            ClientMessage::parse(r#"{"text":"p\"w\\😀","type":"answer","extra":[1,-2.5e3,{"a":null}],"b":true}"#),
            Some(ClientMessage::Answer { text: "p\"w\\😀".into() })
        );
        for bad in [
            "",
            "forged-token",
            r#"{"type":"answer"}"#,
            r#"{"type":"begin","username":5}"#,
            r#"{"type":"other","text":"x"}"#,
            r#"{"type":"answer","text":"x"} x"#,
            r#"{"type":"answer","text":"x",}"#,
            r#"["type","answer"]"#,
            "{\"type\":\"answer\",\"text\":\"a\u{1}\"}",
            r#"{"type":"answer","text":"x","n":01}"#,
        ] {
            assert_eq!(ClientMessage::parse(bad), None, "{bad}");
        }
        assert_eq!(ClientMessage::parse(&format!("{}{{}}{}", "[".repeat(100), "]".repeat(100))), None);
    }

    #[test]
    fn server_messages() {
        assert_eq!(
            ServerMessage::Prompt { text: "Password: ", echo: false }.json(),
            r#"{"type":"prompt","text":"Password: ","echo":false}"#
        );
        assert_eq!(
            ServerMessage::Failed { message: "a \"b\"\n" }.json(),
            r#"{"type":"result","ok":false,"message":"a \"b\"\u000a"}"#
        );
        assert_eq!(ServerMessage::SignedIn { username: "u" }.frame()[..2], [0x81, 42]);
        assert_eq!(close_frame(4001, "x"), [0x88, 3, 0x0f, 0xa1, b'x']);
        let long = text_frame(&"a".repeat(200));
        assert_eq!(long[..4], [0x81, 126, 0, 200]);
    }
}
