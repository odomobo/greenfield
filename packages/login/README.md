# Login helpers and the web front

The programs that sign users in and connect their browser to their desktop. Rust, one Cargo workspace. The helpers use std and the `libc` crate only
(the production helper adds libpam); the web front adds rustls and ring (TLS), pinned in `Cargo.lock`:

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
  tested with fakes), the account policy (`policy.rs`), startup and the accept loop (`main.rs`). See the header of `login/src/main.rs` and
  `nebula-login --help`; installing and running it is in [packages/gateway/README.md](../gateway/README.md).
- `web` (`nebula-web`): the web front, unprivileged, the only network-facing code. Two binaries: the listener
  `nebula-web` (`src/bin/listener.rs`) accepts TCP connections without reading them and starts a worker
  `nebula-web-worker` (`src/bin/worker.rs`) for each with fork + exec. The listener opens the worker's `login.sock`
  connection and writes the client's address, caps workers (256 in all, 32 per IP), throttles failed sign-ins per IP
  (20 free, then doubling blocks up to 15 minutes; workers report refusals on a socket of their own), and loads the
  TLS certificate and key (or generates a self-signed pair with openssl) and the page with its files once. The
  certificate chain and the page go into sealed read-only memfds every worker maps; the key stays in the listener,
  which signs each worker's TLS 1.3 CertificateVerify over a per-worker signing channel, checking the layout strictly,
  once per worker (`src/signing.rs`). The worker (not dumpable) does TLS 1.3 (rustls with ring), a minimal
  HTTP/1.1 (GET/HEAD of the page and its files, the security headers, `src/http.rs`), the WebSocket upgrade with the
  Origin check, the sign-in frames (`src/websocket.rs`) translated to and from login records, and then relays the raw
  WebSocket bytes to the desktop. The fds and arguments a worker gets are documented in `src/lib.rs`, the page
  bundle's layout in `src/assets.rs`. Once set up, the worker enters its sandbox (`src/sandbox.rs`): rlimits (no
  processes, 9 fds, bounded memory), no_new_privs and a seccomp allowlist (reading, writing and polling its fds,
  memory, random numbers, exiting; anything else kills it with SIGSYS, which the listener logs). The helpers start
  `nebula-web` with no inheritable or ambient capabilities and no_new_privs. All its unsafe code is in `src/sys.rs`
  (memfds, mmap, poll, socket options, the sandbox's system calls).
- `pam/nebula`: the PAM service file, installed as `/etc/pam.d/nebula`.

Build: `yarn build` (here or at the root) runs `cargo build --release --locked`; `scripts/test-gateway.sh` builds it
too. Tests: `yarn test` (`cargo test`).

## How a sign-in goes

1. The helper binds the TCP port and starts the web front (`nebula-web`, next to the helper) with the listening socket
   as fd 3, `--login-socket <runtime>/login.sock` and where the page is (`common/src/web.rs`).
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
   accepts) and accounts the policy refuses (`login/src/policy.rs`: root, uids below `UID_MIN` from
   `/etc/login.defs` or `--min-uid`, login shells not listed in `/etc/shells` unless `--allow-any-shell`) are asked
   `Password: ` and refused like a wrong password without PAM; the canonical PAM user is checked again after PAM (a
   module may map names). The log says why. An expired password (`pam_acct_mgmt` says `PAM_NEW_AUTHTOK_REQD`) is
   changed with `pam_chauthtok(PAM_CHANGE_EXPIRED_AUTHTOK)` on the same handle and relay (PAM asks for the current and
   the new password and retries as configured), after the policy check; if it isn't changed the attempt is refused
   ("The password has expired and was not changed."), else the sign-in goes on. The dev helper's
   `--dev-expired-password` plays pam_unix's side of that conversation, for the page's e2e test
   (`scripts/e2e/password.sh`).
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

Per-IP failure backoff (`common/src/backoff.rs`, both helpers): see "Per-IP backoff" below.

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
  `login.sock` access, non-dumpable workers (step 6); the helper clears the inheritable and ambient capabilities and
  sets `no_new_privs` when it starts the front (`spawn::without_capabilities`; the drop to the web user clears the
  other sets), and the workers sandbox themselves (step 8: seccomp, no filesystem access, rlimits,
  `web/src/sandbox.rs`).

## Per-IP backoff

Both helpers keep a fixed-size table (4096 addresses) of failed sign-ins per client address in their main loop
(`common/src/backoff.rs`). Each sign-in child sends one fixed-size report, `{address, signed in or not}` (18 bytes),
on its per-attempt pipe as soon as its attempt is decided, before the web process hears the result; the main loop reads
the reports before it forks the next child, and the child decides with its copy of the table (no query back).

- 10 failures from an address are free; each further one blocks the address for 30 s, doubling with every failure, up
  to 15 min. An address with no failure for 15 min after its block ends is forgotten. A successful sign-in changes
  nothing (users may share an address, and an attacker's own account mustn't reset the count).
- IPv4 counts per address, IPv6 per /64 (IPv4-mapped addresses as IPv4).
- A blocked attempt looks like any failure: the `Password: ` prompt, then "The username or password is incorrect."
  after the 3 s minimum. PAM never sees it, and it doesn't extend the block.
- Attempts forked before a block started (at most the connections open then) still run.
- The dev helper divides the times by `--dev-time-scale` (`scripts/e2e/auth.sh` checks the block).

The web listener (`packages/gateway/src/web.ts`) still has its own per-IP limiter (20 free failures, then "Too many
failed attempts" without contacting the helper). It is a cheap first line and duplicates this table; whether it stays
is left to the Rust front.

## Per-account lockout: pam_faillock

The helpers throttle per address only. Locking an account after failed attempts is PAM's job, with `pam_faillock`,
which sees the client's address as `PAM_RHOST` (lockouts are logged with it). In `/etc/pam.d/nebula`, around the
authentication (Debian/Ubuntu; other distributions include their own stacks, e.g. `system-auth`):

```
auth     required   pam_faillock.so preauth
@include common-auth
auth     [default=die] pam_faillock.so authfail
account  required   pam_faillock.so
@include common-account
```

Settings (attempts, unlock time, whether root is covered) are in `/etc/security/faillock.conf`, e.g. `deny = 5`,
`unlock_time = 600`. `faillock --user <name>` shows an account's failures and `faillock --user <name> --reset`
unlocks it. A locked account fails like a wrong password, so an attacker can't tell. Note that a lockout is also a way
for anyone to keep a known user name locked out; the per-IP backoff above limits how fast one address can do that.

## fail2ban

To block addresses at the firewall, fail2ban can watch the helper's log (stderr: the journal under systemd, otherwise
wherever the service's output goes). The lines, with the client's address:

```
<ISO time> [nebula-login] info: Failed sign-in from <ip>: <PAM's reason>.
<ISO time> [nebula-login] info: Failed sign-in from <ip>: unusable user name.
<ISO time> [nebula-login] warn: Refused a sign-in as root from <ip>.
<ISO time> [nebula-login] info: Refused a sign-in from <ip>: too many failed attempts from this address.
<ISO time> [nebula-login] warn: Blocking sign-ins from <ip> for <n> s after <k> failed attempts.
```

(`Blocking ...` names the counted address: for IPv6 its /64 prefix, `<prefix>::`.) A filter,
`/etc/fail2ban/filter.d/nebula.conf`:

```
[Definition]
failregex = ^\S+ \[nebula-login\] \w+: Failed sign-in from <HOST>:
            ^\S+ \[nebula-login\] \w+: Refused a sign-in (?:as root )?from <HOST>
ignoreregex =
```

and a jail in `/etc/fail2ban/jail.d/nebula.conf` (the port the helper binds; `backend = systemd` with
`journalmatch = _SYSTEMD_UNIT=nebula.service` under systemd, or `logpath` naming the log file otherwise):

```
[nebula]
enabled  = true
port     = 443
filter   = nebula
backend  = systemd
journalmatch = _SYSTEMD_UNIT=nebula.service
maxretry = 10
findtime = 10m
bantime  = 1h
```

PAM modules log failures with `rhost=<ip>` too (e.g. `pam_unix(nebula:auth): authentication failure; ... rhost=...`),
so fail2ban's stock filters that match those lines work as well.
