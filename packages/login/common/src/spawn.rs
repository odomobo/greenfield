//! Starting a process with some fds at fixed numbers (a desktop's config pipe and listening socket, the web process's
//! listening socket).
use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};

use crate::sys;

/// Above the numbers fds are moved to, so moving one never overwrites another.
const STAGING_FD: RawFd = 64;

/// Spawn `command` with each `(fd, number)` at that number in the child (everything else of ours is close-on-exec),
/// and `parent_death_signal` sent to it when this process dies. The fds are closed here once the child has them.
pub fn spawn_with_fds(command: &mut Command, fds: Vec<(OwnedFd, RawFd)>, parent_death_signal: Option<libc::c_int>) -> io::Result<Child> {
    // first above every target, then dup2 to the targets in the child: no source can be a target
    let staged = fds
        .iter()
        .map(|(fd, target)| Ok((sys::duplicate_above(fd.as_raw_fd(), STAGING_FD)?, *target)))
        .collect::<io::Result<Vec<_>>>()?;
    drop(fds);
    let moves: Vec<(RawFd, RawFd)> = staged.iter().map(|(fd, target)| (fd.as_raw_fd(), *target)).collect();
    let parent = sys::getpid();
    unsafe {
        command.pre_exec(move || sys::child_setup(&moves, parent_death_signal, parent));
    }
    let child = command.spawn();
    drop(staged);
    child
}
