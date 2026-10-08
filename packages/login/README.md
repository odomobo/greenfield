# Login helpers

The programs that sign users in and connect their browser to their desktop (see
[SIGNIN-ROADMAP.md](../../SIGNIN-ROADMAP.md)). Rust, one Cargo workspace, std and the `libc` crate only:

- `protocol` (`nebula-login-protocol`, `#![forbid(unsafe_code)]`): the records on `login.sock` (web process ↔ helper)
  and `desktop.sock` (helper → desktop), with fixed layouts and hard length limits. The byte layout is documented in
  `protocol/src/lib.rs`; the TypeScript side is `packages/gateway/src/login-protocol.ts`.
- `common` (`nebula-login-common`): what both helpers share. Record channels with fd passing, attach-or-create of a
  user's desktop (`desktop.rs`, parametrised over how a desktop is started), starting processes with fds at fixed
  numbers, logging. All `unsafe` code is in `common/src/sys.rs`.
- `dev-login` (`nebula-dev-login`): the dev login helper, the dev entry point. `GREENFIELD_DEV_PASSWORD` instead of PAM,
  loopback clients only, no setuid, desktops run as the current user; owns the `--dev-*` options. See the header of
  `dev-login/src/main.rs` and `nebula-dev-login --help`.
- (step 5) `nebula-login`, the production helper with PAM, a separate binary: it contains no dev code.

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
   Failures take at least 3 s from the last answer and end with `Result` refused.
4. On success it attaches or creates (`common/src/desktop.rs`): flock `<runtime>/users/<uid>/lock`, connect to
   `desktop.sock`; if nothing accepts, remove the stale path, bind it, and start the desktop with the listening socket
   inherited (`SessionConfig.listenFd`, fd 4; the config record is on fd 3). Either way it makes a socket pair,
   sends one end to the desktop in a `Handover` (with the client's address, for the takeover message) and the other
   to the web process in `Result` signed in. A connection to a desktop that is still starting waits in its listen
   backlog: there is no ready signal.
5. A child that started a desktop stays as its parent until it exits (SIGTERM is passed on; the desktop has
   `PR_SET_PDEATHSIG`). Log out closes the desktop's listening socket, so the next sign-in creates a new desktop.

The runtime directory (dev: `--runtime-dir`, default `$XDG_RUNTIME_DIR/nebula-dev-<port>`; production `/run/nebula`)
holds `login.sock` and the helper-owned `users/<uid>/` directories. The helper's main loop keeps no per-user state:
whether a desktop runs is whether its socket accepts.
