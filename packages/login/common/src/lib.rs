//! What the dev and production login helpers share: record channels with fd passing (`channel`), attach-or-create of
//! a user's desktop (`desktop`), the desktop's SessionConfig (`session_config`), starting processes with inherited fds
//! and as another user (`spawn`), logging, and the system calls std doesn't wrap (`sys`).
pub mod channel;
pub mod desktop;
pub mod log;
pub mod session_config;
pub mod spawn;
pub mod sys;
