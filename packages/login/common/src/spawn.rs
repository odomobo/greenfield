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
    spawn_as(command, fds, None, parent_death_signal)
}

/// `spawn_with_fds`, and the child drops from root to `credentials` before it execs (see `sys::become_user`; the
/// command's working directory is theirs, set after the drop).
pub fn spawn_as(
    command: &mut Command,
    fds: Vec<(OwnedFd, RawFd)>,
    credentials: Option<sys::Credentials>,
    parent_death_signal: Option<libc::c_int>,
) -> io::Result<Child> {
    // first above every target, then dup2 to the targets in the child: no source can be a target
    let staged = fds
        .iter()
        .map(|(fd, target)| Ok((sys::duplicate_above(fd.as_raw_fd(), STAGING_FD)?, *target)))
        .collect::<io::Result<Vec<_>>>()?;
    drop(fds);
    let moves: Vec<(RawFd, RawFd)> = staged.iter().map(|(fd, target)| (fd.as_raw_fd(), *target)).collect();
    let parent = sys::getpid();
    unsafe {
        command.pre_exec(move || sys::child_setup(&moves, credentials.as_ref(), parent_death_signal, parent));
    }
    let child = command.spawn();
    drop(staged);
    child
}

/// As a child's parent (a desktop's): wait for it to exit, passing SIGTERM / SIGINT on to it. Its exit status.
pub fn wait_passing_terminate(pid: libc::pid_t) -> io::Result<libc::c_int> {
    sys::catch_terminate()?;
    let mut passed_on = false;
    loop {
        if let Some((_, status)) = sys::wait_child(pid, false)? {
            return Ok(status);
        }
        if sys::terminate_requested() && !passed_on {
            sys::kill(pid, libc::SIGTERM);
            passed_on = true;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}
