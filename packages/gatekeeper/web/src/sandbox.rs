//! The worker's sandbox (SIGNIN-ROADMAP.md, step 8), entered once its setup is done (fds checked, memfds mapped, TLS
//! configuration built, the TCP socket tuned): from then on it only reads, writes and polls the fds it has, and can't
//! open, create, exec, fork, signal or trace anything.
//!
//! - **no_new_privs**: nothing it could exec would gain privileges (it can't exec anyway; the filter needs it).
//! - **rlimits** (`limits`): no new processes, no core dumps, no fds beyond the numbers it was given (plus the one
//!   the helper's `Result` brings), a bounded address space.
//!   The signing channel (fd 8, signing.rs) needs nothing more: the handshake's one request and reply are a write and
//!   a recvfrom, its timeouts were set before.
//! - **seccomp-BPF allowlist** (`ALLOWED`, the one list of what the worker may call): any other system call kills the
//!   worker (SIGSYS). Kill rather than an error: a call outside the list is a bug or an exploit, and either way the
//!   connection is better ended loudly (the listener logs the signal) than continued in a state nobody tested; an
//!   error return would also let exploit code probe the filter. No filesystem access follows from the list: no
//!   open/openat/creat, stat, mkdir, unlink, connect/bind, execve, clone/fork, kill, ptrace, process_vm_*.
//!
//! Finding the calls the worker makes (e.g. after a change, or on another architecture): temporarily set
//! `DEFAULT_ACTION` to `libc::SECCOMP_RET_LOG`, run the tests and the e2e suite, and read the kernel's log
//! (`dmesg | grep 'type=1326'`, or the audit log): each call outside the list is logged with `syscall=<number>`
//! (numbers in `/usr/include/asm/unistd_64.h`).
//!
//! The filter checks the architecture first (a call through another ABI, e.g. x32 or i386 on x86_64, has other
//! numbers) and is built for x86_64 and aarch64.
use std::io;

use crate::sys;

/// What happens to a call outside `ALLOWED` (see the module documentation).
const DEFAULT_ACTION: u32 = libc::SECCOMP_RET_KILL_PROCESS;

/// One allowed system call, with a condition on an argument (its low 32 bits: all those checked are ints).
#[derive(Clone, Copy)]
pub enum Allow {
    Call(libc::c_long),
    /// allowed if argument `.1` has none of the bits `.2`
    WithoutBits(libc::c_long, usize, u32),
    /// allowed if argument `.1` is one of `.2`
    OneOf(libc::c_long, usize, &'static [u32]),
}

/// Every system call the worker makes once sandboxed (std, rustls and ring, glibc's malloc). Not in it, among others:
/// `read` (std reads sockets with recvfrom), `futex` (one thread, no contention), `ioctl` (hence fcntl for
/// non-blocking), anything that opens, creates, starts, signals or inspects; an abort (tgkill) ends in SIGSYS too.
pub const ALLOWED: &[Allow] = &[
    // the fds it was given: the browser (TLS), the helper, the report socket, the desktop (received from the helper)
    Allow::Call(libc::SYS_write),
    Allow::Call(libc::SYS_writev),
    Allow::Call(libc::SYS_recvfrom),
    Allow::Call(libc::SYS_sendto),
    Allow::Call(libc::SYS_recvmsg),
    Allow::Call(libc::SYS_sendmsg),
    Allow::Call(libc::SYS_shutdown),
    Allow::Call(libc::SYS_close),
    #[cfg(target_arch = "x86_64")]
    Allow::Call(libc::SYS_poll),
    // (aarch64 has no poll: glibc uses ppoll)
    #[cfg(target_arch = "aarch64")]
    Allow::Call(libc::SYS_ppoll),
    // making the desktop's connection non-blocking; F_GETFD: in debug builds std checks an fd is open before it
    // closes it (OwnedFd's drop)
    Allow::OneOf(libc::SYS_fcntl, 1, &[libc::F_GETFL as u32, libc::F_SETFL as u32, libc::F_GETFD as u32]),
    // ring's and our random numbers; Instant and the log's time (normally in the vDSO, without a system call)
    Allow::Call(libc::SYS_getrandom),
    Allow::Call(libc::SYS_clock_gettime),
    // memory (malloc: brk, and mmap and mremap for large blocks), never executable
    Allow::Call(libc::SYS_brk),
    Allow::WithoutBits(libc::SYS_mmap, 2, libc::PROT_EXEC as u32),
    Allow::WithoutBits(libc::SYS_mprotect, 2, libc::PROT_EXEC as u32),
    Allow::Call(libc::SYS_mremap),
    Allow::Call(libc::SYS_munmap),
    Allow::Call(libc::SYS_madvise),
    // exiting (std::process::exit first removes the main thread's signal stack, for stack overflows); one thread only,
    // so no `exit`
    Allow::Call(libc::SYS_sigaltstack),
    Allow::Call(libc::SYS_exit_group),
];

/// The worker's resource limits (soft and hard). RLIMIT_FSIZE is not set to 0: the worker opens no files, but its
/// stdout and stderr (the log) may be a file (the e2e suite's gateway.log, a service's redirected output), and a limit
/// of 0 would kill it with SIGXFSZ at its first log line.
pub fn limits(mapped: usize) -> [(libc::__rlimit_resource_t, u64); 4] {
    [
        // no new processes (clone is not allowed either)
        (libc::RLIMIT_NPROC, 0),
        // no core dumps (it is not dumpable anyway)
        (libc::RLIMIT_CORE, 0),
        // fds 0–8: the ones the listener passed (see lib.rs); the desktop's connection takes the place of a closed one
        // (the page or TLS memfd)
        (libc::RLIMIT_NOFILE, 9),
        // the program, the libraries and the stack, the mapped page bundle (`mapped`), and room for TLS and the relay's
        // buffers
        (libc::RLIMIT_AS, (mapped as u64).saturating_add(ADDRESS_SPACE)),
    ]
}

/// The address space a worker may use besides its mapped memfds.
const ADDRESS_SPACE: u64 = 128 << 20;

/// Enter the sandbox (see the module documentation); `mapped` is the size of the memfds the worker has mapped. Fails
/// if any part can't be set up: the worker must not run without it.
pub fn enter(mapped: usize) -> io::Result<()> {
    apply(&filter(ALLOWED)?, &limits(mapped))
}

/// Set `limits`, no_new_privs and the filter `program` (system calls only: no allocation, for the tests' forked
/// children).
pub fn apply(program: &[libc::sock_filter], limits: &[(libc::__rlimit_resource_t, u64)]) -> io::Result<()> {
    for &(resource, value) in limits {
        sys::set_limit(resource, value)?;
    }
    sys::set_no_new_privs()?;
    sys::install_seccomp_filter(program)
}

#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH: u32 = 0xc000_003e; // AUDIT_ARCH_X86_64
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH: u32 = 0xc000_00b7; // AUDIT_ARCH_AARCH64
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
compile_error!("the worker's seccomp filter is built for x86_64 and aarch64 only (see sandbox.rs)");

/// x32 system calls on x86_64 are the x86_64 ones with this bit set (same AUDIT_ARCH)
const X32_SYSCALL_BIT: u32 = 0x4000_0000;

// offsets in struct seccomp_data: nr (int), arch (u32), instruction_pointer (u64), args (6 x u64)
const OFFSET_NR: u32 = 0;
const OFFSET_ARCH: u32 = 4;
/// the low 32 bits of argument `index` (little-endian on both architectures)
fn offset_arg(index: usize) -> u32 {
    16 + 8 * index as u32
}

fn statement(code: u32, k: u32) -> libc::sock_filter {
    libc::sock_filter { code: code as u16, jt: 0, jf: 0, k }
}

fn jump(code: u32, k: u32, jt: u8, jf: u8) -> libc::sock_filter {
    libc::sock_filter { code: (libc::BPF_JMP | code | libc::BPF_K) as u16, jt, jf, k }
}

fn load(offset: u32) -> libc::sock_filter {
    statement(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS, offset)
}

fn ret(action: u32) -> libc::sock_filter {
    statement(libc::BPF_RET | libc::BPF_K, action)
}

fn too_long() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "the seccomp filter is too long")
}

/// The BPF program allowing `allowed` and nothing else: check the architecture, then one block per entry (compare the
/// call's number; for a condition, load the argument and return from within the block), then `DEFAULT_ACTION`.
pub fn filter(allowed: &[Allow]) -> io::Result<Vec<libc::sock_filter>> {
    let kill = libc::SECCOMP_RET_KILL_PROCESS;
    let allow = libc::SECCOMP_RET_ALLOW;
    let mut program = vec![load(OFFSET_ARCH), jump(libc::BPF_JEQ, AUDIT_ARCH, 1, 0), ret(kill), load(OFFSET_NR)];
    if cfg!(target_arch = "x86_64") {
        program.extend([jump(libc::BPF_JGE, X32_SYSCALL_BIT, 0, 1), ret(kill)]);
    }
    for entry in allowed {
        match *entry {
            Allow::Call(nr) => program.extend([jump(libc::BPF_JEQ, nr as u32, 0, 1), ret(allow)]),
            Allow::WithoutBits(nr, index, bits) => program.extend([
                jump(libc::BPF_JEQ, nr as u32, 0, 4),
                load(offset_arg(index)),
                jump(libc::BPF_JSET, bits, 0, 1),
                ret(DEFAULT_ACTION),
                ret(allow),
            ]),
            Allow::OneOf(nr, index, values) => {
                let count = u8::try_from(values.len()).map_err(|_| too_long())?;
                // (the number's jump skips the argument's load, its comparisons and the two returns)
                program.push(jump(libc::BPF_JEQ, nr as u32, 0, count.checked_add(3).ok_or_else(too_long)?));
                program.push(load(offset_arg(index)));
                for (i, &value) in values.iter().enumerate() {
                    // to `ret(allow)`, past the remaining comparisons and `ret(DEFAULT_ACTION)`
                    program.push(jump(libc::BPF_JEQ, value, count - i as u8, 0));
                }
                program.extend([ret(DEFAULT_ACTION), ret(allow)]);
            }
        }
    }
    program.push(ret(DEFAULT_ACTION));
    if program.len() > libc::BPF_MAXINSNS as usize {
        return Err(too_long());
    }
    Ok(program)
}
