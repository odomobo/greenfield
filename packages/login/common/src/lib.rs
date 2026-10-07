//! What the dev and production login helpers share: record channels with fd passing (`channel`), attach-or-create of
//! a user's desktop (`desktop`), starting processes with inherited fds (`spawn`), logging, and the system calls std
//! doesn't wrap (`sys`).
pub mod channel;
pub mod desktop;
pub mod log;
pub mod spawn;
pub mod sys;
