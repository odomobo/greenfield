//! The PAM conversation, relayed to the page: each message PAM sends becomes a Prompt record to the web process (which
//! shows it on the page), and each question's Answer record becomes PAM's response. This is the translation only; the
//! C side (pam.rs) hands PAM's messages here and copies the answers back.
#![forbid(unsafe_code)]

use nebula_login_common::channel::Channel;
use nebula_login_protocol::{PromptStyle, Record, MAX_PROMPT};
use std::io;
use std::time::{Duration, Instant};

/// PAM's message styles (security/_pam_types.h).
pub const PAM_PROMPT_ECHO_OFF: i32 = 1;
pub const PAM_PROMPT_ECHO_ON: i32 = 2;
pub const PAM_ERROR_MSG: i32 = 3;
pub const PAM_TEXT_INFO: i32 = 4;
/// The most messages in one call, and the longest response PAM takes (PAM_MAX_NUM_MSG, PAM_MAX_RESP_SIZE).
pub const PAM_MAX_NUM_MSG: usize = 32;
pub const PAM_MAX_RESP_SIZE: usize = 512;

/// The sign-in's connection to the web process, while PAM talks to the user.
pub struct Relay {
    channel: Option<Channel>,
    answer_timeout: Duration,
    last_answer: Instant,
}

/// Why a conversation failed: PAM gets PAM_CONV_ERR, and the attempt fails.
#[derive(Debug)]
pub enum ConversationError {
    /// something PAM sent that we don't relay (an unknown style, too many messages)
    Unsupported,
    /// the page went away, sent something else or took too long; or the relay was closed
    Connection(io::Error),
    /// an answer PAM can't take (too long, or with a NUL byte)
    Answer,
}

impl std::fmt::Display for ConversationError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            ConversationError::Unsupported => write!(f, "a PAM message that can't be relayed"),
            ConversationError::Connection(e) => write!(f, "the page's connection: {e}"),
            ConversationError::Answer => write!(f, "an answer PAM can't take"),
        }
    }
}

impl Relay {
    pub fn new(channel: Channel, answer_timeout: Duration) -> Relay {
        Relay { channel: Some(channel), answer_timeout, last_answer: Instant::now() }
    }

    /// When the page last answered (or when the relay was made): the failure minimum counts from there.
    pub fn last_answer(&self) -> Instant {
        self.last_answer
    }

    /// The connection, until `close`.
    pub fn channel(&mut self) -> io::Result<&mut Channel> {
        self.channel.as_mut().ok_or_else(|| io::Error::new(io::ErrorKind::NotConnected, "the sign-in is over"))
    }

    /// The sign-in is over (its Result was sent): PAM's later messages (e.g. while closing the session) go nowhere.
    pub fn close(&mut self) {
        self.channel = None;
    }

    /// One call of PAM's conversation function: `(style, text)` per message; an answer per message, `None` for the
    /// ones that are not questions. The page sees the messages in order and answers each question before it sees the
    /// next message.
    pub fn converse(&mut self, messages: &[(i32, String)]) -> Result<Vec<Option<String>>, ConversationError> {
        if messages.is_empty() || messages.len() > PAM_MAX_NUM_MSG {
            return Err(ConversationError::Unsupported);
        }
        let mut answers: Vec<Option<String>> = Vec::with_capacity(messages.len());
        let answer_timeout = self.answer_timeout;
        let result = (|| {
            for (style, text) in messages {
                let style = match *style {
                    PAM_PROMPT_ECHO_OFF => PromptStyle::EchoOff,
                    PAM_PROMPT_ECHO_ON => PromptStyle::EchoOn,
                    PAM_ERROR_MSG => PromptStyle::Error,
                    PAM_TEXT_INFO => PromptStyle::Info,
                    _ => return Err(ConversationError::Unsupported),
                };
                let text = truncate(text, MAX_PROMPT).to_string();
                let channel = self.channel().map_err(ConversationError::Connection)?;
                channel.write(&Record::Prompt { style, text }, None).map_err(ConversationError::Connection)?;
                if style != PromptStyle::EchoOff && style != PromptStyle::EchoOn {
                    answers.push(None);
                    continue;
                }
                let answer = match channel.read(answer_timeout).map_err(ConversationError::Connection)? {
                    (Record::Answer { text }, _) => text,
                    _ => {
                        let error = io::Error::new(io::ErrorKind::InvalidData, "expected Answer");
                        return Err(ConversationError::Connection(error));
                    }
                };
                self.last_answer = Instant::now();
                if answer.len() > PAM_MAX_RESP_SIZE || answer.contains('\0') {
                    wipe(answer);
                    return Err(ConversationError::Answer);
                }
                answers.push(Some(answer));
            }
            Ok(())
        })();
        match result {
            Ok(()) => Ok(answers),
            Err(e) => {
                answers.into_iter().flatten().for_each(wipe);
                // a broken connection stays broken: later conversations fail at once
                if matches!(e, ConversationError::Connection(_)) {
                    self.close();
                }
                Err(e)
            }
        }
    }
}

/// At most `limit` bytes of `text`, cut at a character boundary.
pub fn truncate(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Overwrite an answer (it may be a password) before freeing it.
pub fn wipe(text: String) {
    let mut bytes = text.into_bytes();
    bytes.iter_mut().for_each(|b| *b = 0);
    std::hint::black_box(&bytes);
}

#[cfg(test)]
mod tests {
    use super::*;
    use nebula_login_protocol::MAX_ANSWER;
    use std::os::unix::net::UnixStream;
    use std::thread;

    fn pair(answer_timeout: Duration) -> (Relay, Channel) {
        let (ours, web) = UnixStream::pair().unwrap();
        (Relay::new(Channel::new(ours), answer_timeout), Channel::new(web))
    }

    fn read(web: &mut Channel) -> Record {
        web.read(Duration::from_secs(5)).unwrap().0
    }

    #[test]
    fn messages_become_prompts_and_answers_come_back() {
        let (mut relay, mut web) = pair(Duration::from_secs(5));
        let page = thread::spawn(move || {
            assert_eq!(read(&mut web), Record::Prompt { style: PromptStyle::Info, text: "Hello".into() });
            assert_eq!(read(&mut web), Record::Prompt { style: PromptStyle::EchoOff, text: "Password: ".into() });
            web.write(&Record::Answer { text: "secret".into() }, None).unwrap();
            assert_eq!(read(&mut web), Record::Prompt { style: PromptStyle::Error, text: "Careful".into() });
            assert_eq!(read(&mut web), Record::Prompt { style: PromptStyle::EchoOn, text: "Code: ".into() });
            web.write(&Record::Answer { text: "123456".into() }, None).unwrap();
        });
        let before = relay.last_answer();
        let answers = relay
            .converse(&[
                (PAM_TEXT_INFO, "Hello".into()),
                (PAM_PROMPT_ECHO_OFF, "Password: ".into()),
                (PAM_ERROR_MSG, "Careful".into()),
                (PAM_PROMPT_ECHO_ON, "Code: ".into()),
            ])
            .unwrap();
        assert_eq!(answers, [None, Some("secret".into()), None, Some("123456".into())]);
        assert!(relay.last_answer() > before);
        page.join().unwrap();
    }

    #[test]
    fn long_texts_are_cut_at_a_character_boundary() {
        let (mut relay, mut web) = pair(Duration::from_secs(5));
        let long = "é".repeat(MAX_PROMPT);
        relay.converse(&[(PAM_TEXT_INFO, long)]).unwrap();
        let Record::Prompt { text, .. } = read(&mut web) else { panic!("no prompt") };
        assert_eq!(text, "é".repeat(MAX_PROMPT / 2));
        assert_eq!(truncate("abc", 2), "ab");
        assert_eq!(truncate("aé", 2), "a");
    }

    #[test]
    fn what_pam_cant_take_fails_the_conversation() {
        // unknown styles (e.g. Linux-PAM's binary prompts), no messages, too many
        let (mut relay, _web) = pair(Duration::from_secs(5));
        assert!(matches!(relay.converse(&[(7, "x".into())]), Err(ConversationError::Unsupported)));
        assert!(matches!(relay.converse(&[]), Err(ConversationError::Unsupported)));
        let many = vec![(PAM_TEXT_INFO, String::new()); PAM_MAX_NUM_MSG + 1];
        assert!(matches!(relay.converse(&many), Err(ConversationError::Unsupported)));

        // an answer over PAM_MAX_RESP_SIZE (the protocol allows more), or with a NUL
        for answer in ["x".repeat(PAM_MAX_RESP_SIZE + 1), "a\0b".to_string()] {
            assert!(answer.len() <= MAX_ANSWER);
            let (mut relay, mut web) = pair(Duration::from_secs(5));
            web.write(&Record::Answer { text: answer }, None).unwrap();
            assert!(matches!(relay.converse(&[(PAM_PROMPT_ECHO_OFF, "P".into())]), Err(ConversationError::Answer)));
        }
    }

    #[test]
    fn a_page_that_doesnt_answer_in_time_ends_the_relay() {
        let (mut relay, _web) = pair(Duration::from_millis(50));
        let result = relay.converse(&[(PAM_PROMPT_ECHO_OFF, "Password: ".into())]);
        assert!(matches!(result, Err(ConversationError::Connection(e)) if e.kind() == io::ErrorKind::TimedOut));
        // closed: later conversations (e.g. while the session closes) fail at once
        assert!(matches!(relay.converse(&[(PAM_TEXT_INFO, "x".into())]), Err(ConversationError::Connection(_))));
    }

    #[test]
    fn something_else_than_an_answer_ends_the_relay() {
        let (mut relay, mut web) = pair(Duration::from_secs(5));
        web.write(&Record::Begin { username: "x".into() }, None).unwrap();
        assert!(matches!(
            relay.converse(&[(PAM_PROMPT_ECHO_OFF, "Password: ".into())]),
            Err(ConversationError::Connection(_))
        ));
        assert!(relay.channel().is_err());
    }
}
