//! One sign-in attempt, in a child of its own: read the client's address and the user name, run PAM with one handle
//! (its prompts relayed to the page; an expired password is changed through the same relay), check the account policy,
//! and on success attach to the user's running desktop or open the PAM session and start one. Everything that needs
//! root or PAM is behind `Host` and `Pam`, so this flow is tested without them.
#![forbid(unsafe_code)]

use crate::policy::Policy;
use crate::relay::{Relay, PAM_PROMPT_ECHO_OFF};
use nebula_login_common::channel::Channel;
use nebula_login_common::desktop::{self, Desktop};
use nebula_login_common::log;
use nebula_login_common::sys::User;
use nebula_login_protocol::{Outcome, Record};
use std::io;
use std::net::IpAddr;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

pub const WRONG: &str = "The username or password is incorrect.";
/// An expired password that wasn't changed (a wrong current password, new ones that didn't match or that PAM refused).
pub const NOT_CHANGED: &str = "The password has expired and was not changed.";
pub const UNAVAILABLE: &str = "Signing in is not possible right now.";
pub const NO_DESKTOP: &str = "The desktop could not be started.";
/// What an unusable user name is asked (the prompt pam_unix asks an unknown user with).
const PASSWORD_PROMPT: &str = "Password: ";

/// Why PAM refused.
#[derive(Debug)]
pub enum Refusal {
    /// authentication or the account check failed (the text is PAM's, for the log)
    Denied(String),
    /// authenticated, but the password has expired (pam_acct_mgmt said PAM_NEW_AUTHTOK_REQD): it must be changed
    Expired,
}

/// One PAM handle, from authentication to the end of the session.
pub trait Pam {
    /// pam_authenticate, then pam_acct_mgmt. The conversation goes through `relay`.
    fn authenticate(&mut self) -> Result<(), Refusal>;
    /// pam_chauthtok(PAM_CHANGE_EXPIRED_AUTHTOK), after `authenticate` said Expired. The conversation goes through
    /// `relay` (PAM asks for the current and the new password itself, and retries as configured).
    fn change_password(&mut self) -> Result<(), String>;
    /// PAM_USER: the name PAM authenticated (modules may have mapped it).
    fn user(&self) -> Option<String>;
    /// pam_setcred(PAM_ESTABLISH_CRED), then pam_open_session.
    fn open_session(&mut self) -> Result<(), String>;
    /// The environment PAM set up for the session (`NAME=value`).
    fn environment(&self) -> Vec<String>;
    /// pam_close_session and pam_setcred(PAM_DELETE_CRED), if the session was opened.
    fn close_session(&mut self);
    /// The conversation's connection to the web process.
    fn relay(&mut self) -> &mut Relay;
}

/// What an attempt needs from the system.
pub trait Host {
    type Pam: Pam;
    /// pam_start for `username`, with PAM_RHOST (the client) and PAM_TTY set. On failure the relay comes back.
    fn start_pam(&self, username: &str, client: IpAddr, relay: Relay) -> Result<Self::Pam, (Relay, String)>;
    /// The passwd entry of a user name.
    fn user(&self, name: &str) -> Option<User>;
    /// `<runtime>/users/<uid>/`, created if needed (owned by the helper, the user can't write to it).
    fn user_dir(&self, uid: libc::uid_t) -> io::Result<PathBuf>;
    /// Start the user's desktop (as the user, with the session's environment) inheriting `listener`. Its pid.
    fn start_desktop(&self, user: &User, environment: Vec<String>, listener: OwnedFd) -> io::Result<libc::pid_t>;
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// the web process sends the address and the user name right after connecting
    pub begin_timeout: Duration,
    /// how long the page has to answer each prompt
    pub answer_timeout: Duration,
    /// a failed attempt takes at least this long from the last answer
    pub min_failure: Duration,
}

/// A sign-in that started a desktop: the sign-in child stays as its PAM parent.
pub struct Started<P> {
    pub pam: P,
    pub pid: libc::pid_t,
    pub username: String,
}

/// A user name we hand to PAM: what useradd accepts (letters, digits, `_ - .`, a trailing `$`), not starting with `-`,
/// at most 64 bytes. Anything else gets a password prompt and fails like an unknown user, without PAM.
pub fn valid_username(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0] != b'-'
        && bytes.iter().enumerate().all(|(i, &c)| {
            c.is_ascii_alphanumeric() || c == b'_' || c == b'-' || c == b'.' || (c == b'$' && i == bytes.len() - 1)
        })
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

/// Run one attempt on a login.sock connection. Ok(Some) when it started a desktop (the caller waits for it, then
/// closes the PAM session); Ok(None) when it is over (signed in to a running desktop, refused, or the connection
/// never became a sign-in: closed or idle before Begin); Err when the connection broke after Begin, before a result
/// could be sent.
pub fn sign_in<H: Host>(
    host: &H,
    limits: &Limits,
    policy: &Policy,
    connection: UnixStream,
) -> io::Result<Option<Started<H::Pam>>> {
    let mut channel = Channel::new(connection);
    let client = match channel.read(limits.begin_timeout)? {
        (Record::ClientAddress(ip), _) => ip,
        _ => return Err(invalid("expected the client address")),
    };
    let username = match channel.read(limits.begin_timeout) {
        Ok((Record::Begin { username }, _)) => username,
        // the web listener opens a connection for every TCP connection (step 6), and most never become a sign-in (the
        // page's files): their worker exits, or keeps its connection idle, without writing Begin
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof || e.kind() == io::ErrorKind::TimedOut => return Ok(None),
        Ok(_) => return Err(invalid("expected Begin")),
        Err(e) => return Err(e),
    };
    let mut relay = Relay::new(channel, limits.answer_timeout);

    // an unusable name (an empty one: the web process sends that for a name over the limit) and accounts the policy
    // refuses (root, system accounts, no login shell) are asked for a password like anyone else and refused the same
    // way, without PAM ever seeing them
    let usable = valid_username(&username);
    let refused = if usable { host.user(&username).and_then(|user| policy.check(&user).err()) } else { None };
    if !usable || refused.is_some() {
        let answers = relay.converse(&[(PAM_PROMPT_ECHO_OFF, PASSWORD_PROMPT.into())]);
        if let Ok(answers) = answers {
            answers.into_iter().flatten().for_each(crate::relay::wipe);
        }
        match refused {
            Some(reason) => log::warn(&format!("Refused a sign-in as {username} from {client}: {reason}.")),
            None => log::info(&format!("Failed sign-in from {client}: unusable user name.")),
        }
        return finish(&mut relay, limits, Outcome::Refused, WRONG).map(|_| None);
    }

    let mut pam = match host.start_pam(&username, client, relay) {
        Ok(pam) => pam,
        Err((mut relay, e)) => {
            log::error(&format!("PAM could not be started: {e}"));
            return finish(&mut relay, limits, Outcome::Failed, UNAVAILABLE).map(|_| None);
        }
    };
    let expired = match pam.authenticate() {
        Ok(()) => false,
        Err(Refusal::Expired) => true,
        Err(Refusal::Denied(reason)) => {
            log::info(&format!("Failed sign-in from {client}: {reason}."));
            return finish(pam.relay(), limits, Outcome::Refused, WRONG).map(|_| None);
        }
    };

    // PAM may have mapped the name: the session is the canonical user's, and the policy applies to that user too
    let canonical = pam.user().unwrap_or_else(|| username.clone());
    let Some(user) = host.user(&canonical) else {
        log::error(&format!("Signed in as {canonical}, who is not in the passwd database."));
        return finish(pam.relay(), limits, Outcome::Refused, WRONG).map(|_| None);
    };
    if let Err(reason) = policy.check(&user) {
        log::warn(&format!("Refused a sign-in as {canonical} (PAM user of {username:?}) from {client}: {reason}."));
        return finish(pam.relay(), limits, Outcome::Refused, WRONG).map(|_| None);
    }

    // an expired password is changed on the spot, through the same conversation, then the sign-in goes on
    if expired {
        log::info(&format!("The password of {canonical} has expired: asking for a new one."));
        if let Err(e) = pam.change_password() {
            log::info(&format!("Failed sign-in from {client}: {canonical}'s expired password was not changed ({e})."));
            return finish(pam.relay(), limits, Outcome::Refused, NOT_CHANGED).map(|_| None);
        }
        log::info(&format!("Changed the expired password of {canonical}."));
    }

    let attached = host.user_dir(user.uid).and_then(|dir| {
        desktop::attach_or_create(&dir, client, |listener| {
            pam.open_session().map_err(|e| io::Error::other(format!("opening the PAM session failed: {e}")))?;
            let environment = pam.environment();
            host.start_desktop(&user, environment, listener).inspect_err(|_| pam.close_session())
        })
    });
    let (web_end, desktop) = match attached {
        Ok(attached) => attached,
        Err(e) => {
            log::error(&format!("Attaching to or starting the desktop of {} failed: {e}", user.name));
            return finish(pam.relay(), limits, Outcome::Failed, NO_DESKTOP).map(|_| None);
        }
    };
    let result = Record::Result { outcome: Outcome::SignedIn, text: user.name.clone() };
    let sent = pam.relay().channel().and_then(|channel| channel.write(&result, Some(web_end.as_raw_fd())));
    pam.relay().close();
    drop(web_end);
    match desktop {
        Desktop::Attached => {
            log::info(&format!("Signed in: {} from {client}, attached to the running desktop.", user.name));
            sent.map(|_| None)
        }
        Desktop::Created(pid) => {
            log::info(&format!("Signed in: {} from {client}, started a desktop ({pid}).", user.name));
            // the desktop runs whether or not the web process got its end (it then waits for the next sign-in)
            if let Err(e) = sent {
                log::warn(&format!("The web process did not get the new desktop's connection: {e}"));
            }
            Ok(Some(Started { pam, pid, username: user.name }))
        }
    }
}

/// End a failed attempt: refusals take at least the minimum time from the last answer (whatever the reason, so a
/// refusal's timing tells nothing), then the Result.
fn finish(relay: &mut Relay, limits: &Limits, outcome: Outcome, text: &str) -> io::Result<()> {
    if outcome == Outcome::Refused {
        let since = Instant::now().saturating_duration_since(relay.last_answer());
        std::thread::sleep(limits.min_failure.saturating_sub(since));
    }
    let result = Record::Result { outcome, text: text.to_string() };
    let sent = relay.channel().and_then(|channel| channel.write(&result, None));
    relay.close();
    sent
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::{PAM_ERROR_MSG, PAM_PROMPT_ECHO_ON, PAM_TEXT_INFO};
    use nebula_login_protocol::PromptStyle;
    use std::cell::RefCell;
    use std::os::unix::net::UnixListener;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::thread;

    const LIMITS: Limits = Limits {
        begin_timeout: Duration::from_secs(5),
        answer_timeout: Duration::from_secs(5),
        min_failure: Duration::from_millis(300),
    };

    /// What the fake PAM did, for the checks.
    #[derive(Default)]
    struct Log {
        started: Vec<(String, IpAddr)>,
        opened: u32,
        closed: u32,
        /// the new password of a change
        changed: Option<String>,
    }

    /// PAM with the users "alice" and "svc" (also known capitalized), whose password is "secret" and who also need a
    /// one-time code "123456" (a second prompt, shown after an info message). An expired password is changed like
    /// pam_unix does, with three tries for the new one.
    struct FakePam {
        relay: Relay,
        log: Rc<RefCell<Log>>,
        username: String,
        authenticated: bool,
        expired: bool,
    }

    impl Pam for FakePam {
        fn authenticate(&mut self) -> Result<(), Refusal> {
            let answers = self
                .relay
                .converse(&[(PAM_PROMPT_ECHO_OFF, "Password: ".into())])
                .map_err(|e| Refusal::Denied(format!("{e:?}")))?;
            let answers2 = self
                .relay
                .converse(&[(PAM_TEXT_INFO, "Check your phone".into()), (PAM_PROMPT_ECHO_ON, "Code: ".into())])
                .map_err(|e| Refusal::Denied(format!("{e:?}")))?;
            let known = ["alice", "svc"].contains(&self.username.to_lowercase().as_str());
            if !(known && answers[0].as_deref() == Some("secret") && answers2[1].as_deref() == Some("123456")) {
                return Err(Refusal::Denied("Authentication failure".into()));
            }
            if self.expired {
                // pam_unix's account check tells the user
                let _ = self.relay.converse(&[(PAM_ERROR_MSG, EXPIRED_NOTICE.into())]);
                return Err(Refusal::Expired);
            }
            self.authenticated = true;
            Ok(())
        }
        fn change_password(&mut self) -> Result<(), String> {
            let ask = |relay: &mut Relay, messages: &[(i32, String)]| {
                let answers = relay.converse(messages).map_err(|e| e.to_string())?;
                Ok::<_, String>(answers.into_iter().flatten().collect::<Vec<_>>())
            };
            let user = self.username.to_lowercase();
            let current = ask(
                &mut self.relay,
                &[(PAM_TEXT_INFO, format!("Changing password for {user}.")), (PAM_PROMPT_ECHO_OFF, "Current password: ".into())],
            )?;
            if current != ["secret"] {
                return Err("Authentication token manipulation error".into());
            }
            for _ in 0..3 {
                let new = ask(&mut self.relay, &[(PAM_PROMPT_ECHO_OFF, "New password: ".into())])?;
                let again = ask(&mut self.relay, &[(PAM_PROMPT_ECHO_OFF, "Retype new password: ".into())])?;
                if new == again {
                    self.log.borrow_mut().changed = Some(new[0].clone());
                    self.authenticated = true;
                    return Ok(());
                }
                ask(&mut self.relay, &[(PAM_ERROR_MSG, "Sorry, passwords do not match.".into())])?;
            }
            Err("Have exhausted maximum number of retries for service".into())
        }
        fn user(&self) -> Option<String> {
            Some(self.username.to_lowercase())
        }
        fn open_session(&mut self) -> Result<(), String> {
            assert!(self.authenticated);
            self.log.borrow_mut().opened += 1;
            Ok(())
        }
        fn environment(&self) -> Vec<String> {
            vec!["XDG_RUNTIME_DIR=/run/user/1000".into()]
        }
        fn close_session(&mut self) {
            self.log.borrow_mut().closed += 1;
        }
        fn relay(&mut self) -> &mut Relay {
            &mut self.relay
        }
    }

    struct FakeHost {
        runtime: PathBuf,
        log: Rc<RefCell<Log>>,
        /// the running desktop's listening socket (a stand-in for the desktop)
        desktop: RefCell<Option<UnixListener>>,
        expired: bool,
    }

    static NEXT_DIR: AtomicU32 = AtomicU32::new(0);

    impl FakeHost {
        fn new() -> FakeHost {
            let n = NEXT_DIR.fetch_add(1, Ordering::SeqCst);
            let runtime = std::env::temp_dir().join(format!("nebula-login-attempt-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&runtime).unwrap();
            std::fs::write(runtime.join("shells"), "/bin/sh\n").unwrap();
            FakeHost { runtime, log: Default::default(), desktop: RefCell::new(None), expired: false }
        }
    }

    impl FakeHost {
        /// the default policy: UID_MIN 1000, the shells listed in our own /etc/shells
        fn policy(&self) -> Policy {
            Policy { min_uid: 1000, shells: Some(self.runtime.join("shells")) }
        }
    }

    impl Drop for FakeHost {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.runtime);
        }
    }

    impl Host for FakeHost {
        type Pam = FakePam;
        fn start_pam(&self, username: &str, client: IpAddr, relay: Relay) -> Result<FakePam, (Relay, String)> {
            self.log.borrow_mut().started.push((username.into(), client));
            let log = self.log.clone();
            Ok(FakePam { relay, log, username: username.into(), authenticated: false, expired: self.expired })
        }
        fn user(&self, name: &str) -> Option<User> {
            let user =
                |uid, shell: &str| User { name: name.into(), uid, gid: uid, home: "/".into(), shell: shell.into() };
            match name {
                "alice" => Some(user(1000, "/bin/sh")),
                "root" | "toor" => Some(user(0, "/bin/sh")),
                // a system account, one below UID_MIN and one without a login shell
                "daemon" => Some(user(1, "/usr/sbin/nologin")),
                "svc" => Some(user(999, "/bin/sh")),
                "kiosk" => Some(user(1001, "/usr/sbin/nologin")),
                _ => None,
            }
        }
        fn user_dir(&self, uid: libc::uid_t) -> io::Result<PathBuf> {
            let dir = desktop::user_dir(&self.runtime, uid);
            std::fs::create_dir_all(&dir)?;
            Ok(dir)
        }
        fn start_desktop(&self, user: &User, environment: Vec<String>, listener: OwnedFd) -> io::Result<libc::pid_t> {
            assert!(user.name == "alice" || user.name == "svc");
            assert_eq!(environment, ["XDG_RUNTIME_DIR=/run/user/1000"]);
            *self.desktop.borrow_mut() = Some(UnixListener::from(listener));
            Ok(4242)
        }
    }

    /// The web process's side: what it is asked, and the outcome. `answers` answers the questions in order.
    fn web(username: &str, answers: Vec<&'static str>) -> (UnixStream, thread::JoinHandle<(Vec<Record>, Option<OwnedFd>)>) {
        let (helper_end, web_end) = UnixStream::pair().unwrap();
        let username = username.to_string();
        let page = thread::spawn(move || {
            let mut channel = Channel::new(web_end);
            channel.write(&Record::ClientAddress("192.0.2.7".parse().unwrap()), None).unwrap();
            channel.write(&Record::Begin { username }, None).unwrap();
            let mut seen = Vec::new();
            let mut answers = answers.into_iter();
            loop {
                let (record, fd) = channel.read(Duration::from_secs(5)).unwrap();
                seen.push(record.clone());
                match record {
                    Record::Prompt { style: PromptStyle::EchoOff | PromptStyle::EchoOn, .. } => {
                        let text = answers.next().unwrap_or("").to_string();
                        channel.write(&Record::Answer { text }, None).unwrap();
                    }
                    Record::Result { .. } => return (seen, fd),
                    _ => {}
                }
            }
        });
        (helper_end, page)
    }

    fn result_of(seen: &[Record]) -> (Outcome, String) {
        match seen.last() {
            Some(Record::Result { outcome, text }) => (*outcome, text.clone()),
            other => panic!("no result: {other:?}"),
        }
    }

    #[test]
    fn signs_in_relaying_every_prompt_then_creates_and_attaches() {
        let host = FakeHost::new();
        let (connection, page) = web("Alice", vec!["secret", "123456"]);
        let started = sign_in(&host, &LIMITS, &host.policy(), connection).unwrap().expect("a desktop was started");
        let (seen, fd) = page.join().unwrap();
        assert_eq!(
            seen,
            [
                Record::Prompt { style: PromptStyle::EchoOff, text: "Password: ".into() },
                Record::Prompt { style: PromptStyle::Info, text: "Check your phone".into() },
                Record::Prompt { style: PromptStyle::EchoOn, text: "Code: ".into() },
                // the canonical name
                Record::Result { outcome: Outcome::SignedIn, text: "alice".into() },
            ]
        );
        assert!(fd.is_some());
        assert_eq!(started.pid, 4242);
        assert_eq!(started.username, "alice");
        assert_eq!(host.log.borrow().started, [("Alice".to_string(), "192.0.2.7".parse().unwrap())]);
        assert_eq!(host.log.borrow().opened, 1);
        // the desktop got the connection, with the client's address
        let listener = host.desktop.borrow_mut().take().unwrap();
        let (handover, _) = listener.accept().unwrap();
        let (record, desktop_end) = Channel::new(handover).read(Duration::from_secs(5)).unwrap();
        assert_eq!(record, Record::Handover("192.0.2.7".parse().unwrap()));
        assert!(desktop_end.is_some());

        // signing in again attaches to it, without opening another session
        let (connection, page) = web("alice", vec!["secret", "123456"]);
        assert!(sign_in(&host, &LIMITS, &host.policy(), connection).unwrap().is_none());
        assert_eq!(result_of(&page.join().unwrap().0), (Outcome::SignedIn, "alice".into()));
        assert!(listener.accept().is_ok());
        assert_eq!(host.log.borrow().opened, 1);
        drop(started);
    }

    #[test]
    fn a_wrong_answer_is_refused_after_the_minimum_time() {
        let host = FakeHost::new();
        let (connection, page) = web("alice", vec!["wrong", "123456"]);
        let begun = Instant::now();
        assert!(sign_in(&host, &LIMITS, &host.policy(), connection).unwrap().is_none());
        let (seen, fd) = page.join().unwrap();
        assert!(begun.elapsed() >= LIMITS.min_failure);
        assert_eq!(result_of(&seen), (Outcome::Refused, WRONG.into()));
        assert!(fd.is_none());
        assert_eq!(host.log.borrow().opened, 0);
    }

    #[test]
    fn unknown_unusable_and_root_users_fail_the_same_way() {
        for name in ["bob", "", "-x", "a b", "root", "toor"] {
            let host = FakeHost::new();
            let (connection, page) = web(name, vec!["secret", "123456"]);
            let begun = Instant::now();
            assert!(sign_in(&host, &LIMITS, &host.policy(), connection).unwrap().is_none(), "{name}");
            let (seen, _) = page.join().unwrap();
            assert!(begun.elapsed() >= LIMITS.min_failure, "{name}");
            // every one was asked for a password first
            assert_eq!(seen[0], Record::Prompt { style: PromptStyle::EchoOff, text: "Password: ".into() }, "{name}");
            assert_eq!(result_of(&seen), (Outcome::Refused, WRONG.into()), "{name}");
            // root and unusable names never reach PAM
            let reached_pam = !host.log.borrow().started.is_empty();
            assert_eq!(reached_pam, name == "bob", "{name}");
        }
    }

    const EXPIRED_NOTICE: &str = "You are required to change your password immediately (administrator enforced).";

    fn prompt(style: PromptStyle, text: &str) -> Record {
        Record::Prompt { style, text: text.into() }
    }

    #[test]
    fn an_expired_password_is_changed_then_the_sign_in_goes_on() {
        let mut host = FakeHost::new();
        host.expired = true;
        // the new passwords don't match the first time
        let answers = vec!["secret", "123456", "secret", "new-one", "typo", "new-one", "new-one"];
        let (connection, page) = web("alice", answers);
        let started = sign_in(&host, &LIMITS, &host.policy(), connection).unwrap().expect("a desktop was started");
        let (seen, fd) = page.join().unwrap();
        assert_eq!(
            seen,
            [
                prompt(PromptStyle::EchoOff, "Password: "),
                prompt(PromptStyle::Info, "Check your phone"),
                prompt(PromptStyle::EchoOn, "Code: "),
                prompt(PromptStyle::Error, EXPIRED_NOTICE),
                prompt(PromptStyle::Info, "Changing password for alice."),
                prompt(PromptStyle::EchoOff, "Current password: "),
                prompt(PromptStyle::EchoOff, "New password: "),
                prompt(PromptStyle::EchoOff, "Retype new password: "),
                prompt(PromptStyle::Error, "Sorry, passwords do not match."),
                prompt(PromptStyle::EchoOff, "New password: "),
                prompt(PromptStyle::EchoOff, "Retype new password: "),
                Record::Result { outcome: Outcome::SignedIn, text: "alice".into() },
            ]
        );
        assert!(fd.is_some());
        assert_eq!(host.log.borrow().changed.as_deref(), Some("new-one"));
        assert_eq!(host.log.borrow().opened, 1);
        drop(started);
    }

    #[test]
    fn an_expired_password_that_isnt_changed_is_refused() {
        // a wrong current password; new passwords that never match
        for answers in [
            vec!["secret", "123456", "wrong"],
            vec!["secret", "123456", "secret", "a", "b", "c", "d", "e", "f"],
        ] {
            let mut host = FakeHost::new();
            host.expired = true;
            let (connection, page) = web("alice", answers);
            let begun = Instant::now();
            assert!(sign_in(&host, &LIMITS, &host.policy(), connection).unwrap().is_none());
            assert!(begun.elapsed() >= LIMITS.min_failure);
            assert_eq!(result_of(&page.join().unwrap().0), (Outcome::Refused, NOT_CHANGED.into()));
            assert_eq!(host.log.borrow().changed, None);
            assert_eq!(host.log.borrow().opened, 0);
        }
    }

    #[test]
    fn accounts_the_policy_refuses_fail_like_a_wrong_password() {
        // system accounts and accounts without a login shell never reach PAM; "Svc" does (PAM maps it to "svc", uid
        // 999), and is refused after it, even with the right password
        for (name, reaches_pam) in [("daemon", false), ("kiosk", false), ("svc", false), ("Svc", true)] {
            let host = FakeHost::new();
            let (connection, page) = web(name, vec!["secret", "123456"]);
            let begun = Instant::now();
            assert!(sign_in(&host, &LIMITS, &host.policy(), connection).unwrap().is_none(), "{name}");
            let (seen, _) = page.join().unwrap();
            assert!(begun.elapsed() >= LIMITS.min_failure, "{name}");
            assert_eq!(seen[0], prompt(PromptStyle::EchoOff, "Password: "), "{name}");
            assert_eq!(result_of(&seen), (Outcome::Refused, WRONG.into()), "{name}");
            assert_eq!(!host.log.borrow().started.is_empty(), reaches_pam, "{name}");
            assert_eq!(host.log.borrow().opened, 0, "{name}");
        }

        // with the policy relaxed (a lower UID_MIN, any shell) they may sign in; root still may not
        let host = FakeHost::new();
        let relaxed = Policy { min_uid: 500, shells: None };
        let (connection, page) = web("svc", vec!["secret", "123456"]);
        let started = sign_in(&host, &LIMITS, &relaxed, connection).unwrap().expect("a desktop was started");
        assert_eq!(result_of(&page.join().unwrap().0), (Outcome::SignedIn, "svc".into()));
        drop(started);
        let open = Policy { min_uid: 0, shells: None };
        let (connection, page) = web("root", vec!["secret", "123456"]);
        assert!(sign_in(&host, &LIMITS, &open, connection).unwrap().is_none());
        assert_eq!(result_of(&page.join().unwrap().0), (Outcome::Refused, WRONG.into()));
    }

    #[test]
    fn a_page_that_doesnt_answer_is_refused() {
        let host = FakeHost::new();
        let limits = Limits { answer_timeout: Duration::from_millis(100), ..LIMITS };
        let (connection, web_end) = UnixStream::pair().unwrap();
        let mut channel = Channel::new(web_end);
        channel.write(&Record::ClientAddress("::1".parse().unwrap()), None).unwrap();
        channel.write(&Record::Begin { username: "alice".into() }, None).unwrap();
        // the relay is closed after the timeout, so no Result can be sent: the web process sees the connection end
        assert!(sign_in(&host, &limits, &host.policy(), connection).is_err());
        assert!(matches!(channel.read(Duration::from_secs(5)).unwrap().0, Record::Prompt { .. }));
        assert!(channel.read(Duration::from_secs(5)).is_err());
    }

    #[test]
    fn the_connection_must_start_with_the_address_and_begin() {
        let host = FakeHost::new();
        let (connection, web_end) = UnixStream::pair().unwrap();
        Channel::new(web_end).write(&Record::Begin { username: "alice".into() }, None).unwrap();
        assert!(sign_in(&host, &LIMITS, &host.policy(), connection).is_err());
        assert!(host.log.borrow().started.is_empty());
    }

    #[test]
    fn a_connection_that_never_becomes_a_sign_in_ends_quietly() {
        let host = FakeHost::new();
        // closed after the address (a worker that only served files)
        let (connection, web_end) = UnixStream::pair().unwrap();
        Channel::new(web_end).write(&Record::ClientAddress("::1".parse().unwrap()), None).unwrap();
        assert!(sign_in(&host, &LIMITS, &host.policy(), connection).unwrap().is_none());
        // idle until the Begin timeout
        let limits = Limits { begin_timeout: Duration::from_millis(50), ..LIMITS };
        let (connection, web_end) = UnixStream::pair().unwrap();
        let mut channel = Channel::new(web_end);
        channel.write(&Record::ClientAddress("::1".parse().unwrap()), None).unwrap();
        assert!(sign_in(&host, &limits, &host.policy(), connection).unwrap().is_none());
        assert!(host.log.borrow().started.is_empty());
    }

    #[test]
    fn user_names() {
        for name in ["alice", "a.b-c_d", "machine$", "A1"] {
            assert!(valid_username(name), "{name}");
        }
        for name in ["", "-x", "a b", "a$b", "a/b", "é", &"a".repeat(65), "a\0"] {
            assert!(!valid_username(name), "{name}");
        }
    }
}
