# Login helpers

The programs that sign users in and connect their browser to their desktop (see
[SIGNIN-ROADMAP.md](../../SIGNIN-ROADMAP.md)). Rust, one Cargo workspace, std and the `libc` crate only (the
production helper adds libpam):

- `protocol` (`nebula-login-protocol`, `#![forbid(unsafe_code)]`): the records on `login.sock` (web process ↔ helper)
  and `desktop.sock` (helper → desktop), with fixed layouts and hard length limits. The byte layout is documented in
  `protocol/src/lib.rs`; the TypeScript side is `packages/gateway/src/login-protocol.ts`.
- `common` (`nebula-login-common`): what both helpers share. Record channels with fd passing, attach-or-create of a
  user's desktop (`desktop.rs`, parametrised over how a desktop is started), starting processes with fds at fixed
  numbers, logging. All `unsafe` code is in `common/src/sys.rs`.
- `dev-login` (`nebula-dev-login`): the dev login helper, the dev entry point. `GREENFIELD_DEV_PASSWORD` instead of PAM,
  loopback clients only, no setuid, desktops run as the current user; owns the `--dev-*` options. See the header of
  `dev-login/src/main.rs` and `nebula-dev-login --help`.
- `login` (`nebula-login`): the production login helper and the service's entry point, run as root. PAM through a
  small hand-written binding (`login/src/pam.rs`, linked against `libpam.so.0`; the crate's only unsafe code), a
  separate binary with no dev code. The flow is `#![forbid(unsafe_code)]`: the command line (`args.rs`), PAM's
  conversation relayed to the page (`relay.rs`), one sign-in attempt behind `Pam` / `Host` traits (`attempt.rs`, unit
  tested with fakes), startup and the accept loop (`main.rs`). See the header of `login/src/main.rs` and
  `nebula-login --help`; installing and running it is in [packages/gateway/README.md](../gateway/README.md).
- `pam/nebula`: the PAM service file, installed as `/etc/pam.d/nebula`.

Build: `yarn build` (here or at the root) runs `cargo build --release --locked`; `scripts/test-gateway.sh` builds it
too. Tests: `yarn test` (`cargo test`).

## How a sign-in goes

1. The helper binds the TCP port and starts the web process with the listening socket as fd 3 and
   `--login-socket <runtime>/login.sock`.
2. For each TCP connection the web listener connects to `login.sock`, writes `ClientAddress` (the accepted socket's
   peer address) and hands the connection to that TCP connection's worker, which writes `Begin` if the connection
   becomes a sign-in (the page's WebSocket). The helper forks a child for each connection; most never get a `Begin`
   (the page's files) and end quietly when the worker exits.
3. The child sends `Prompt`s and reads `Answer`s (the web process relays them to and from the page), then decides.
   Failures take at least 3 s from the last answer and end with `Result` refused. In production the prompts are
   PAM's: one handle per attempt (`pam_start` with `PAM_RHOST` = the client's address and `PAM_TTY` = `nebula`,
   `pam_authenticate`, `pam_acct_mgmt`), each message of PAM's conversation becomes a `Prompt` (hidden and visible
   questions, info and error texts), each question's `Answer` its response (refused over `PAM_MAX_RESP_SIZE`, 512
   bytes). An unusable user name (empty, which the web process sends for an over-long one, or not what useradd
   accepts) and root are asked `Password: ` and refused without PAM; a canonical PAM user that is root too. An expired
   password is refused with its own message (changing it is step 11).
4. On success it attaches or creates (`common/src/desktop.rs`): flock `<runtime>/users/<uid>/lock`, connect to
   `desktop.sock`; if nothing accepts, remove the stale path, bind it, and start the desktop with the listening socket
   inherited (`SessionConfig.listenFd`, fd 4; the config record is on fd 3). Either way it makes a socket pair,
   sends one end to the desktop in a `Handover` (with the client's address, for the takeover message) and the other
   to the web process in `Result` signed in. A connection to a desktop that is still starting waits in its listen
   backlog: there is no ready signal.
   In production, creating opens the PAM session on the attempt's handle first (`pam_setcred(PAM_ESTABLISH_CRED)`,
   `pam_open_session`), and the desktop drops to the user before it execs (supplementary groups, gid, uid, then a
   check that root can't be regained), with PAM's environment plus `HOME`, `USER`, `LOGNAME`, `SHELL`.
5. A child that started a desktop stays as its parent until it exits (SIGTERM is passed on; the desktop has
   `PR_SET_PDEATHSIG`, set after the uid change, which clears it). In production that is the PAM parent: it then
   closes the PAM session (`pam_close_session`, `pam_setcred(PAM_DELETE_CRED)`, `pam_end`). Log out closes the
   desktop's listening socket, so the next sign-in creates a new desktop.

Production limits (`login/src/main.rs`): `login.sock` is `root:<web group>` 0660 and only the web user's uid is
accepted (`SO_PEERCRED`); at most 256 connections at a time, the web listener's cap, since it opens one per TCP
connection (more are closed at once; a connection that ends or idles before `Begin` ends quietly); `ClientAddress` and `Begin` within 10 s, each answer within 75 s (the web process gives the page 60 s), a
whole attempt within 180 s (`alarm`; not once it is a PAM parent).

The runtime directory (dev: `--runtime-dir`, default `$XDG_RUNTIME_DIR/nebula-dev-<port>`; production `/run/nebula`,
root's, 0755) holds `login.sock` and the helper-owned `users/<uid>/` directories (production: root's, 0755; the
socket and the lock are root's, 0600). The helper's main loop keeps no per-user state:
whether a desktop runs is whether its socket accepts.

## systemd

`systemd/nebula.socket` and `systemd/nebula.service` (install steps in [packages/gateway/README.md](../gateway/README.md#as-a-systemd-service)).
systemd stays optional: without it `nebula-login` binds `--bind-ip` / `--bind-port` itself.

- **Socket activation.** `nebula.socket` listens (`ListenStream=443`); when it starts the service, systemd sets
  `LISTEN_PID` (the helper's pid) and `LISTEN_FDS=1` and passes the socket as fd 3. `nebula-login` parses that by hand
  (`login/src/activation.rs`: ignored if `LISTEN_PID` is not its own pid, an error for nonsense or more than one
  socket), checks the descriptor is a listening TCP socket (`sys::adopt_tcp_listener`) and uses it instead of
  binding; from there the web process gets it exactly as before. The helper still runs as root (it has to start user
  sessions); the benefit is one place for the port and address, and starting on demand.
- **Stopping ends the desktops.** `KillMode=mixed`: SIGTERM goes to `nebula-login` only; it stops the web process and
  its sign-in children, which pass SIGTERM to their desktops (apps get 5 s to quit); it waits 8 s, then kills the
  rest. `TimeoutStopSec=20` covers that. A control-group kill would not reach the desktops: `pam_systemd` moves each PAM
  parent into the user's session scope. A desktop also has `PR_SET_PDEATHSIG`, so a killed PAM parent ends it.
  `RuntimeDirectory=nebula` removes `/run/nebula` (stale sockets) when the service stops.
- **Hardening, and why so little.** The unit's restrictions are inherited by every desktop and app (they descend from
  the helper, whatever cgroup they are in), and the helper must run PAM modules (`pam_unix`, `pam_systemd`,
  `pam_mount`), `setuid`, and `pam_limits`. So these are *not* used: `NoNewPrivileges` (breaks sudo, polkit, bwrap,
  `unix_chkpwd`), `CapabilityBoundingSet` (needs at least setuid/setgid/chown/dac_*/sys_admin for pam_mount, and
  limits users' setuid programs), `ProtectSystem` / `ProtectHome` / `PrivateTmp` / `PrivateDevices` (mount namespace
  shared with every desktop: read-only `/usr` and `/etc`, no homes, no `/dev/dri`, a private `/tmp`),
  `ProtectKernel*`, `SystemCallFilter`, `MemoryDenyWriteExecute` (node's JIT), `RestrictNamespaces` (browsers, flatpak),
  `RestrictRealtime`. Used: `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK` (a seccomp filter; netlink
  for logind/resolver; drop the line if users' apps need AF_PACKET or Bluetooth).
- **The front (web process and workers).** The roadmap names `NoNewPrivileges`, an empty capability set and
  `ProtectSystem` for it, but the front is started by the helper, not by systemd, so those can't apply to it without
  also applying to the desktops. It is hardened where it is started and in itself: an unprivileged user (groups,
  gid, uid dropped and verified), a cleared environment, `PR_SET_PDEATHSIG`, only the listening socket and
  `login.sock` access, non-dumpable workers (step 6); the sandbox of step 8 (`no_new_privs`, seccomp, no filesystem
  access, rlimits) is applied by the workers themselves, and is where `NoNewPrivileges` and an empty capability set
  for the front belong. Dropping the helper's inheritable/ambient caps for the front when it starts it can go with
  that step.
