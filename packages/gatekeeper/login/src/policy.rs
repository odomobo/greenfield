//! Which accounts may sign in at all, whatever PAM says: not root, not system accounts (uids below UID_MIN, from
//! /etc/login.defs), and only users whose login shell is listed in /etc/shells (accounts with /usr/sbin/nologin and the
//! like are not for people). Both are on by default; `--min-uid` and `--allow-any-shell` change them. A refused account
//! fails like a wrong password on the page; the log has the reason.
#![forbid(unsafe_code)]

use nebula_login_common::sys::User;
use std::io;
use std::path::PathBuf;

/// Where UID_MIN is read from, and what it is when the file doesn't set it (shadow-utils' default).
pub const LOGIN_DEFS: &str = "/etc/login.defs";
pub const DEFAULT_UID_MIN: libc::uid_t = 1000;
/// The login shells users may have.
pub const SHELLS: &str = "/etc/shells";
/// What glibc's getusershell() takes when /etc/shells is missing.
const SHELLS_WITHOUT_FILE: [&str; 2] = ["/bin/sh", "/bin/csh"];

#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    /// the lowest uid that may sign in (root never may)
    pub min_uid: libc::uid_t,
    /// the list of allowed login shells (read at every check, so a newly installed shell counts at once); None: any
    pub shells: Option<PathBuf>,
}

impl Policy {
    /// Ok if `user` may sign in, else why not (for the log).
    pub fn check(&self, user: &User) -> Result<(), String> {
        if user.uid == 0 {
            return Err("root".into());
        }
        if user.uid < self.min_uid {
            return Err(format!("uid {} is below the lowest allowed ({})", user.uid, self.min_uid));
        }
        if let Some(file) = &self.shells {
            // an empty shell field means /bin/sh (passwd(5))
            let shell = if user.shell.is_empty() { "/bin/sh" } else { user.shell.as_str() };
            let listed = match std::fs::read_to_string(file) {
                Ok(text) => shells(&text).any(|listed| listed == shell),
                Err(e) if e.kind() == io::ErrorKind::NotFound => SHELLS_WITHOUT_FILE.contains(&shell),
                Err(e) => return Err(format!("{} could not be read: {e}", file.display())),
            };
            if !listed {
                return Err(format!("the login shell {shell} is not listed in {}", file.display()));
            }
        }
        Ok(())
    }
}

/// The shells in /etc/shells's text: one path per line, `#` comments.
pub fn shells(text: &str) -> impl Iterator<Item = &str> {
    text.lines().map(|line| line.split('#').next().unwrap_or("").trim()).filter(|line| !line.is_empty())
}

/// UID_MIN from /etc/login.defs's text (`NAME value` lines, `#` comments), if it is set to a number.
pub fn uid_min(login_defs: &str) -> Option<libc::uid_t> {
    login_defs.lines().find_map(|line| {
        let mut words = line.split_whitespace();
        match (words.next(), words.next()) {
            (Some("UID_MIN"), Some(value)) => value.parse().ok(),
            _ => None,
        }
    })
}

/// UID_MIN of this system: /etc/login.defs's, else 1000.
pub fn system_uid_min() -> libc::uid_t {
    std::fs::read_to_string(LOGIN_DEFS).ok().and_then(|text| uid_min(&text)).unwrap_or(DEFAULT_UID_MIN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn user(uid: libc::uid_t, shell: &str) -> User {
        User { name: "u".into(), uid, gid: uid, home: "/".into(), shell: shell.into() }
    }

    static NEXT: AtomicU32 = AtomicU32::new(0);

    fn shells_file(text: &str) -> PathBuf {
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let file = std::env::temp_dir().join(format!("nebula-login-shells-{}-{n}", std::process::id()));
        std::fs::write(&file, text).unwrap();
        file
    }

    #[test]
    fn system_accounts_and_shells_not_listed_are_refused() {
        let file = shells_file("# /etc/shells: valid login shells\n/bin/sh\n/usr/bin/bash  # bash\n\n/usr/bin/zsh\n");
        let policy = Policy { min_uid: 1000, shells: Some(file.clone()) };
        assert_eq!(policy.check(&user(1000, "/usr/bin/bash")), Ok(()));
        assert_eq!(policy.check(&user(60000, "/usr/bin/zsh")), Ok(()));
        // an empty shell is /bin/sh
        assert_eq!(policy.check(&user(1000, "")), Ok(()));
        assert!(policy.check(&user(0, "/usr/bin/bash")).unwrap_err().contains("root"));
        assert!(policy.check(&user(999, "/usr/bin/bash")).unwrap_err().contains("uid 999"));
        assert!(policy.check(&user(1000, "/usr/sbin/nologin")).unwrap_err().contains("/usr/sbin/nologin"));
        assert!(policy.check(&user(1000, "/bin/false")).is_err());
        // a comment's text is not a shell
        assert!(policy.check(&user(1000, "bash")).is_err());

        // configured: any uid above root, any shell
        let open = Policy { min_uid: 1, shells: None };
        assert_eq!(open.check(&user(5, "/usr/sbin/nologin")), Ok(()));
        assert!(open.check(&user(0, "/bin/sh")).is_err());
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn without_etc_shells_only_the_traditional_shells_count() {
        let policy = Policy { min_uid: 1000, shells: Some("/nonexistent/nebula-shells".into()) };
        assert_eq!(policy.check(&user(1000, "/bin/sh")), Ok(()));
        assert_eq!(policy.check(&user(1000, "/bin/csh")), Ok(()));
        assert!(policy.check(&user(1000, "/bin/bash")).is_err());
    }

    #[test]
    fn uid_min_from_login_defs() {
        let text = "# UID_MIN 5\n#UID_MIN\t\t\t 7\nSYS_UID_MIN\t\t  100\nUID_MIN\t\t\t 1000\nUID_MAX 60000\n";
        assert_eq!(uid_min(text), Some(1000));
        assert_eq!(uid_min("UID_MIN 500\n"), Some(500));
        assert_eq!(uid_min("UID_MAX 60000\n"), None);
        assert_eq!(uid_min("UID_MIN lots\n"), None);
        assert_eq!(uid_min(""), None);
    }
}
