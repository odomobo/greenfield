# Sign-in Separation Roadmap

A separate roadmap for restructuring how nebula signs users in and connects their browser to their desktop. The main
[ROADMAP.md](ROADMAP.md) covers everything else. Where they disagree (one desktop per user, sessions surviving a
gateway restart, which is no longer
required), this document is newer and wins for sign-in and session lifetime.

Decided 2026-10-07. Steps 1–7, 10, 11 and 13 are implemented; the rest is not.

## Why

Nebula's gateway is the only thing between the internet and a full desktop on the server. Today it works, but its
structure puts too much in the wrong places:

- **Root runs Node.** The privileged monitor (`packages/gateway/src/monitor.ts`) is V8 and the Node runtime, parsing
  JSON from the web process. Root code should be small enough to read in an afternoon.
- **One web process holds everything.** `web.ts` terminates TLS for everyone, holds every sign-in token, relays every
  live desktop connection and serves the JavaScript every visitor runs. One exploitable bug there gives an attacker
  every connected user's desktop (keystrokes are code execution as that user), every later visitor's password, and
  the TLS key. It also loads npm dependencies.
- **PAM is used in a way that breaks real setups.** Authentication and the session use separate PAM handles, so
  `pam_mount`, systemd-homed, keyring unlock and Kerberos don't get the password. Every hidden prompt is answered with
  the password, expired passwords can't be handled, and `PAM_RHOST` is never set (so `pam_access`, faillock records
  and fail2ban can't see the client IP).
- **GStreamer runs as root** at startup (encoder detection with `gst-inspect-1.0`).
- **Dev flags are parsed by the production gateway.** Production code has dev paths in it.

## Goals

In priority order:

1. **Security:** small root code with fixed-format input; an exploit in network-facing code reaches only the
   attacker's own connection.
2. **Auditability:** the privileged part has no dependencies beyond std, libc and libpam, and no dev code.
3. **Installable on most Linux servers:** no kernel modules, no required reverse proxy, no required init system.
4. **Clarity:** each process has one job that fits in a sentence.
5. **PAM flexibility:** whatever the admin configures in PAM works (mounts, homed, keyrings, Kerberos, faillock,
   expired passwords; 2FA later through the same path).

## Decisions

- **One desktop per user, one connection per user.** A new connection takes over; the old page is told it was taken
  over and from which IP. The session list, naming and rename go away.
- **Disconnect keeps the desktop.** Signing in again reattaches. Only Log out ends the desktop.
- **The open WebSocket is the sign-in.** No tokens, no presence connection, no REST API.
- **TLS always.** There is no plain-HTTP mode (`--insecure-plaintext` goes away in step 3); without a certificate the
  gateway generates a self-signed one.
- **TLS is done by a TLS library.** We write no TLS or crypto code. No kernel TLS, no handing TLS state around.
- **The production login helper never contains dev code.** The dev helper is a separate project. The session has no
  dev mode of its own: it is driven by dev flags in its config, which only the dev helper writes. The production helper
  doesn't know they exist.
- **The dev helper mirrors the production helper's stack.** Both are Rust (std, libc; production adds libpam), in one
  Cargo workspace: a shared protocol crate and two separate binaries, so production still contains no dev code.
- **Desktop sockets live in helper-owned directories.** Each user's `desktop.sock` is in `<runtime>/users/<uid>/`,
  which the helper owns and the user can't write to. The helper binds the socket itself and the desktop inherits the
  listening fd, so the desktop never creates a path. Root never connects to a path a user can write to.
- **The client IP comes from the listener**, which reads it from the accepted socket and writes it to the helper
  connection before handing that connection to the worker. The worker can't choose the IP that PAM, the takeover
  message and the backoff see.
- **No per-user throttling in our code.** Per-account lockout is PAM's job (`pam_faillock`).
- **2FA is deferred.** The sign-in protocol carries PAM's prompts generically, so it needs no protocol change later.

## Security now and later

Security hardening is done once the whole roadmap is complete, and patched as needed then. Until then the requirement
is that the architecture supports it: every step builds the process boundaries, fd ownership and record formats of the
target design, so later hardening is a local change (a limit, a check, a filter) and never re-plumbing. When a step
has to choose, it picks the shape that keeps the hardening possible and leaves the hardening itself for later.

## Target architecture

```
Browser ──TCP──> listener ──starts──> worker (one per TCP connection) ──sign-in──> login helper (root)
   └────────────── TLS ──────────────────┘                                              │ starts
                                   worker <────── socket pair (relay) ──────> desktop <─┘ PAM parent (root)
```

- **Listener** (`nebula-web`, unprivileged): accepts TCP connections and starts a fresh worker for each. Never reads
  network data. Opens the worker's helper connection and writes the client IP to it. Holds the TLS key.
- **Worker** (`nebula-web`, one per TCP connection): TLS, serving the page, relaying the PAM prompts to the helper,
  and after sign-in relaying bytes between the browser and the desktop. Exits when its connection closes.
- **Login helper** (root): forks a child per sign-in that runs PAM with one handle, then either hands the
  connection to the user's running desktop (through its `desktop.sock`) or opens the PAM session and starts the
  desktop.
- **PAM parent** (root): the sign-in child that started a desktop. It waits for the desktop to exit, then closes the
  PAM session. Today's `pam-helper session` parent does the same.
- **Desktop** (the user): today's session process. Accepts handed-over connections on its inherited listening
  socket, closes the previous one on takeover.

Why this shape:

- **Per-connection workers** limit an exploit in the network-facing code to the attacker's own connection: no other
  users' sessions or passwords, no altered JavaScript for anyone else, no TLS key once the key is held by the
  listener (step 9).
- **Root reads only short fixed-format records** from the worker, never network data.
- **One PAM handle from sign-in to Log out** makes PAM modules that need the password at session start work.
- **Desktops are independent** of the listener, so restarting the front leaves them running. Surviving a restart of
  the whole service is not required: a service restart may end the desktops too.

Things no design fixes:

- the process carrying a connection sees that connection's password;
- a self-signed certificate can be impersonated when users click through the warning (real certificates are the fix);
- signing in again doesn't refresh the running desktop's credentials: the reattach runs PAM in a new process, so
  `pam_setcred` can't reach the desktop, and e.g. Kerberos tickets obtained at desktop start expire regardless.

## Steps

Nebula is not production-ready until this roadmap is complete. The security goals apply to the end state only: an
intermediate step may be insecure (root parsing more than it will in the end, dev and production code side by side)
as long as it works and moves toward the target (see "Security now and later").

Each step leaves a working application: unit tests and `scripts/test-gateway.sh` pass after every step. Steps 1–6
reach the target shape: the helpers in Rust, the front still in Node. Later steps harden or port one piece at a time
without changing how the pieces connect.

### 1. One desktop per user

- The monitor's create-session reuses the user's desktop if one exists. The viewer drops the session list: sign in,
  then attach or create.
- Still works because the processes and the relay are unchanged.
- Adjust the e2e scripts that create several sessions.
- As built: monitor requests `desktop` (attach or create), `endDesktop`, `desktopSocket`; web routes `POST /api/desktop`,
  `POST /api/desktop/end` and `/ws` without a session parameter (4004 when no desktop is running). The viewer calls
  `/api/desktop` after sign-in, then opens `/ws`. Disconnect is sign out (desktop kept); a desktop that ended shows
  "Start a new desktop". The monitor still names its session directories by a random id (internal only).

### 2. Session config on fd 3

- The monitor passes a `SessionConfig` record on an extra pipe (fd 3) instead of the IPC `start` message. It has an
  optional `devFlags` section (`timeScale`, `linkKbps`, `patchOrder`, `patchShape`); when it's missing the session
  uses the defaults. Until step 5 the monitor fills it from today's dev flags.
- Site settings (encoder, render device) move to a root-owned config file the session reads itself. Encoder detection
  moves into the session, so GStreamer no longer runs as root.
- No user-visible change.
- Done: the record is `SessionConfig` in `packages/gateway/src/session-config.ts` (JSON, at most 16 KiB, read to EOF
  from fd 3; the format is documented in that file's header, for the Rust helpers to write). Fd 4 carries the Node IPC
  channel (ready signal, the session ends when it closes) until step 5 deletes the monitor; step 4's dev helper
  signals readiness and goes away differently (its own mechanism). The site settings file is `key = value` lines
  (`src/site-settings.ts`), default `/etc/nebula/nebula.conf`, named by `SessionConfig.siteSettingsPath` (the monitor
  writes one from `--encoder` / `--render-device`). `devFlags` is written only in `--dev-auth` mode.

### 3. Sign-in over the WebSocket

- The web process runs the sign-in on the page's one WebSocket (a single "Password" prompt for now), still calling the
  monitor's `auth`. On success it relays that same WebSocket to the user's desktop.
- Remove tokens, `/control` presence, `/api/*` and the viewer's token code (`auth.ts`). Log out becomes an in-band
  message to the desktop. The takeover message carries the new connection's IP.
- A dropped connection shows the sign-in form.
- Remove `--insecure-plaintext` (config, README, its check in `auth.sh`, the `http` case in `lib.sh`).
- Rewrite the e2e sign-in helper in `scripts/e2e/lib.sh` (and `probe.js`, `auth.sh`, `desktop.sh`, `audio.sh`).
- As built:
  - **The in-band messages** are specified in one place, "Sign-in" in `libs/scene-protocol/src/index.ts` (types
    `SignInClientMessage` / `SignInServerMessage`): JSON text frames `begin {username}`, then any number of
    `prompt {text, echo}` (answered by `answer {text}`, in order), `info {text}` and `error {text}`, ended by
    `result {ok, username | message}`; after `result ok` the same WebSocket is the desktop connection. These map
    one to one onto PAM's conversation (`PAM_PROMPT_ECHO_OFF`/`_ON`, `PAM_TEXT_INFO`, `PAM_ERROR_MSG`), so step 4's
    web process only translates them to and from the `login.sock` records. Frames are at most 4 KiB, one attempt
    per WebSocket (a failure closes it with 4001), `begin` within 10 s, each answer within 60 s, and the 3 s
    failure minimum counts from the last answer. The page answers the first hidden prompt with the form's password
    and shows any further prompt in a field of its own (`#prompt-form`), so 2FA needs no page change either.
  - The web process (`handleWebSocket` in `web.ts`) sends one `Password: ` prompt, calls the monitor's `auth`, then
    its `desktop` (attach or create, returns the socket path, uses up the ticket; tickets live 60 s). The monitor's
    `logout`, `endDesktop` and `desktopSocket` requests are gone.
  - **Takeover IP**: the web process tells the session the client's IP in its relay handshake (`X-Client-IP`
    header on `GET /viewer`); the session closes the previous viewer with 4100 and the IP as the close reason, and
    the old page shows the sign-in form saying "opened somewhere else (from <ip>)". In step 4 the IP comes in the
    fixed-format record that hands the connection over instead of the header.
  - **Log out** is the viewer message `session.logout`, handled by the session: it closes its listening socket,
    tells its starter (`{type: 'ending'}` on the IPC channel, so the monitor starts a new desktop on the next
    sign-in), closes the viewer with 4101 (`CLOSE_LOGGED_OUT`) and ends its apps. With the helper (step 4) the closed
    listening socket alone is the signal: the next sign-in can't connect, so it creates.
  - Every close shows the sign-in form (the overlay, the reconnect loop and "Start a new desktop" are gone).
  - Throttling: the per-IP `RateLimiter` (20 free failures) stays in `web.ts` until step 10; the per-user one is gone.

### 4. The login protocol and the dev helper

- Add a small native addon for passing fds over Unix sockets (next to the existing `socket-options` code in
  compositor-proxy), used by the web process and the session.
- **The runtime directory.** Each helper has one, holding `login.sock` and a helper-owned `users/<uid>/` per user with
  `desktop.sock` and a `lock` file. Production uses `/run/nebula`. The dev helper takes a runtime-directory option,
  defaulting to a directory under `$XDG_RUNTIME_DIR`; each e2e instance passes its own, so parallel scripts running as
  the same OS user don't share or take over each other's desktops ("one desktop per user" holds per helper
  instance). Nothing hardcodes these paths: the helper tells the web process where `login.sock` is when it starts it.
- **Attach or create.** After a successful sign-in, the sign-in child takes `flock` on `users/<uid>/lock` and tries
  to connect to `desktop.sock`:
  - it connects (reattach): it sends the connection's fd with a fixed-format record (the client IP, for the takeover
    message), releases the lock and exits;
  - it can't (create): it removes any stale socket, binds `desktop.sock` itself, starts the desktop with the
    listening socket inherited (its fd number is in `SessionConfig`), hands over the first connection the same way,
    releases the lock and stays as the desktop's parent (the PAM parent in production).

  The helper's main loop keeps no per-user state: whether a desktop is alive is whether its socket accepts. The
  session accepts handed-over connections on the inherited socket next to its old `viewer.sock`.
- Define the `login.sock` record protocol: a first record with the client IP, then `Begin`, `Prompt`, `Answer`,
  `Result`, with fixed layouts and hard length limits. Until step 6 the web process writes the IP record itself. On
  success the helper creates a socket pair, passes one end to the desktop and the other to the web process.
- **New project: the Rust helper workspace** (std and libc only so far): the shared protocol crate, and the dev login
  helper. It implements the protocol with `GREENFIELD_DEV_PASSWORD`, loopback-only client IPs, no PAM and no setuid,
  fills `devFlags` from its command line, owns the dev time scale, and starts the desktop as the current user.
- The dev helper is the dev entry point, started the same way as the production one: it binds the port and starts
  the web process with the listening socket (as in step 5). The `--dev-*` options move to it, the web process no
  longer takes any, and the e2e scripts start the dev helper instead of `main.js`. The build (and the e2e runner)
  builds the workspace.
- The web process uses `login.sock` when started by the dev helper. Production still uses the monitor.
- Still works because the e2e suite (always dev mode) now exercises the new path end to end, and production is
  untouched. Temporary duplication until step 5: two backends in the web process, two connection styles in the session.
- As built:
  - **The workspace** is `packages/login/` (also a yarn workspace, `@gfld/login`, whose `build` is
    `cargo build --release --locked`; `scripts/test-gateway.sh` runs cargo too). Crates: `protocol`
    (`nebula-login-protocol`, `forbid(unsafe_code)`, the record layout, documented in its `src/lib.rs`), `common`
    (`nebula-login-common`: record channels with fd passing, `desktop::attach_or_create` parametrised over a closure
    that starts the desktop with the listening fd, `spawn::spawn_with_fds`, logging, and all `unsafe` code in
    `sys.rs`) and `dev-login` (the `nebula-dev-login` binary). Step 5 adds its binary next to `dev-login` and reuses
    `protocol` and `common`.
  - **Records**: a 4-byte header (u8 kind, u8 reserved 0, u16 big-endian payload length) and a payload with a per-kind
    limit: `ClientAddress` 1 and `Handover` 6 (18 bytes: u8 family 4/6, u8 0, 16 address bytes), `Begin` 2 (user name,
    ≤ 256 bytes; the web process sends an empty name for a longer one, which must fail like an unknown user), `Prompt`
    3 (u8 style 1 echo off, 2 echo on, 3 info, 4 error, then ≤ 512 bytes), `Answer` 4 (≤ 1024 bytes, the page's
    limit; a production helper may refuse more than `PAM_MAX_RESP_SIZE`), `Result` 5 (u8 outcome 0 signed in, 1
    refused, 2 failed, then ≤ 256 bytes: the user name when signed in, else the message the page shows). A signed-in
    `Result` and a `Handover` carry one fd (`SCM_RIGHTS` on the record's first byte). The TypeScript side is
    `packages/gateway/src/login-protocol.ts`; both sides' tests check the same bytes.
  - **Desktop start**: `SessionConfig` gained `listenFd` (exactly one of `listenFd` and `socketPath`); the helpers put
    the config pipe at fd 3 and the listening socket at fd 4, start the desktop with `PR_SET_PDEATHSIG` = SIGTERM, and
    the desktop marks fd 4 close-on-exec first thing (or its apps would keep the socket open after Log out). No ready
    signal: the first handover waits in the backlog. Without IPC the session ends on SIGTERM. Socket and lock are
    0600, `users/<uid>/` 0700 in dev (production: root-owned 0755, as above).
  - **Dev helper**: `--bind-ip` (default 127.0.0.1, loopback only), `--bind-port`, `--runtime-dir`, `--gateway-dir`
    (default `packages/gateway/dist` relative to the binary), `--node`, `--site-config` / `--encoder` /
    `--render-device` (written to `<runtime>/nebula.conf` like the monitor did), the `--dev-*` options, and the web
    process's options, passed on. It starts the web process as `node web.js --listen-fd 3 --login-socket <path>
    [--cert --key --state-dir --hide-hostname --allowed-origin]` with a minimal environment; step 5 starts it the
    same way. One fork per sign-in, no cap and no per-prompt PAM timeout yet (the dev child gives the address and
    `Begin` 10 s, an answer 75 s). On SIGTERM it stops the web process and its children, which pass it on to their
    desktops, and waits up to 8 s / time scale. The dev user is the current user (`getpwuid`).
  - **Web process**: started with options (a helper) it reads the TLS key itself and uses `login.sock`; started
    without (by `main.js`) it waits for the monitor's `start` message as before. It no longer takes or receives any
    dev setting: `main.js` lost `--dev-auth` and every `--dev-*` option (it refuses them and runs as root only),
    `WebStart` lost `devMode` and `timeScale`. With a helper, an IP over the per-IP throttle is refused by the web
    process at once (after the page's password prompt, without contacting the helper or waiting the failure minimum).
  - **Native addon**: `packages/compositor-proxy/native/poll/src/fd_passing.c` in the existing small poll addon
    (`unixConnect`, `acceptConnection`, `sendWithFd`, `receiveWithFds`, `setCloseOnExec`, `closeFd`, non-blocking and
    close-on-exec, driven by the addon's `startPoll`), exposed as `@gfld/compositor-proxy/dist/fd-passing.js`. The
    gateway's `RecordChannel` wraps a raw fd with it; a received connection becomes a `net.Socket({ fd })`. The session
    feeds handed-over sockets to its HTTP server (`emit('connection')`), so the web process still does the same
    WebSocket handshake on the relay (without `X-Client-IP`: the address comes from the `Handover`).
  - **e2e**: `scripts/e2e/lib.sh` starts `nebula-dev-login` with `--runtime-dir "$WORK/run-$port"`; `session_pid`
    finds the desktop (the helper's grandchild). `auth.sh` checks the dev helper's refusals and that `main.js` and
    `web.js` refuse dev options.

### 5. The production login helper replaces the monitor

- `nebula-login`, a second binary in the Rust workspace (std, libc and libpam; parsing code uses
  `#![forbid(unsafe_code)]`), speaking the same protocol as the dev helper and replacing
  `packages/gateway/native/pam-helper.c`:
  - accept loop on `login.sock`, peer uid check (`SO_PEERCRED`), global cap on attempts, a timeout on each prompt, one
    fork per attempt (the implementer picks the cap and timeout values);
  - one PAM handle per attempt, prompts relayed to the page, `PAM_RHOST` and `PAM_TTY` set, a fixed 3 s minimum on
    failures, refusal of uid 0;
  - attach-or-create as in step 4 (`/run/nebula/users/<uid>/` owned by root, mode 0755); when creating, open the PAM
    session, bind the socket while still root, start the desktop and stay as its PAM parent (wait, then
    `pam_close_session`, as `pam-helper.c` does today);
  - a killed PAM parent ends its desktop: the desktop is started with `PR_SET_PDEATHSIG`. Otherwise a desktop could
    outlive its PAM session, which would then never be closed.
- It becomes the service entry point: it binds the port and starts the web process as `nebula-web` with the
  listening socket.
- Delete `monitor.ts`, `ipc.ts`, `pam-helper.c`, the web process's monitor backend and the session's `viewer.sock`.
- Manual check with real PAM as root (e2e can't run as root): deferred to the end (see "Manual checks"). The rest is
  already covered by step 4.
- As built:
  - **The binary** is `packages/login/login` (`nebula-login`). libpam through a hand-written binding (`src/pam.rs`, the
    crate's only unsafe code, linked against `libpam.so.0` with `+verbatim`, so no PAM dev package is needed); the
    rest is `forbid(unsafe_code)`: `args.rs`, `relay.rs` (PAM conversation ↔ Prompt/Answer), `attempt.rs` (one attempt
    behind `Pam` / `Host` traits, unit-tested with fakes; one test drives the real libpam's conversation without
    root). New system calls (`peer_uid`, `group_list`, `Credentials` / `become_user`, `alarm`) are in
    `common/src/sys.rs`; `spawn::spawn_as` starts a process as another user (groups, gid, uid, verified that root
    can't be regained, then `chdir` and `PR_SET_PDEATHSIG`, which a uid change would clear);
    `common/src/session_config.rs` writes the SessionConfig for both helpers.
  - **PAM**: service renamed to `nebula` (`packages/login/pam/nebula`, installed as `/etc/pam.d/nebula`; the helper
    warns when it is missing). `PAM_RHOST` = the client's address, `PAM_TTY` = `nebula`, `XDG_SESSION_TYPE=wayland`,
    `XDG_SESSION_CLASS=user`, `XDG_SESSION_DESKTOP=nebula` in PAM's environment for pam_systemd.
    `pam_authenticate` and `pam_acct_mgmt` with `PAM_DISALLOW_NULL_AUTHTOK`; `PAM_NEW_AUTHTOK_REQD` leads to
    `pam_chauthtok` (step 11). On create: `pam_setcred(ESTABLISH)`, `pam_open_session`, the desktop's
    environment is PATH, LANG, PAM's list, then HOME/USER/LOGNAME/SHELL; after it exits `pam_close_session`,
    `pam_setcred(DELETE)`, `pam_end`. An answer over `PAM_MAX_RESP_SIZE` (512) or with a NUL fails the conversation.
  - **Refusals without PAM**: a user name that isn't what useradd accepts (≤ 64 bytes; includes the empty name) and a
    name whose passwd entry is uid 0 get a fake `Password: ` prompt and the same refusal; a canonical PAM user with
    uid 0 is refused after PAM too.
  - **Limits** (step 10/11 may tune them): 256 login.sock connections at a time, the listener's `MAX_WORKERS`, since
    it opens one per TCP connection (the main loop counts children whose per-attempt pipe is still open; more are
    closed at once; EOF or the `Begin` timeout before `Begin` end a child quietly, as in the dev helper), `ClientAddress`/`Begin` within 10 s, each answer within 75 s, a
    whole attempt within 180 s (`alarm`, cancelled once the child becomes a PAM parent), 3 s failure minimum.
    `login.sock` is `root:<web group>` 0660 plus the `SO_PEERCRED` check (only the web user's uid).
  - **Entry point**: `nebula-login` as root takes `--bind-ip`, `--bind-port`, `--web-user` (default `nebula-web`),
    `--runtime-dir` (`/run/nebula`), `--gateway-dir`, `--node`, `--site-config` / `--encoder` / `--render-device`,
    and passes `--cert`, `--key`, `--state-dir` (default `/var/lib/nebula`; created for the web user, refused if
    someone else owns it, since the web process generates the self-signed certificate there), `--hide-hostname`,
    `--allowed-origin` on to the web process, started exactly like the dev helper does
    (`node web.js --listen-fd 3 --login-socket <runtime>/login.sock ...`), as the web user. `--dev-*` is refused.
  - **Deleted**: `monitor.ts`, `ipc.ts`, `main.ts`, `config.ts` (its options moved to `nebula-login`),
    `native/pam-helper.c` and its build, the web process's monitor backend (it is always started by a helper), the
    session's `socketPath` / `viewer.sock`, IPC ready/`ending`/disconnect handling, and the `X-Client-IP` header
    (`SessionConfig.listenFd` is now required). `auth.sh` checks that `nebula-login` refuses to run without root and
    refuses dev options.

### 6. Listener and per-connection workers

- Split `web.ts`: a listener (`net.Server` with `pauseOnConnect`, connection caps, never reads) that forks one worker
  per TCP connection and hands it the socket; the worker holds today's per-connection code (TLS, files, sign-in,
  relay).
- The listener opens each worker's `login.sock` connection, writes the client IP record (from the accepted socket's
  peer address) and passes the connection to the worker with the TCP socket. The worker no longer writes the IP.
- The fd addon marks workers as not dumpable, so workers can't inspect each other.
- Still works because the helper protocol, the session and the viewer are untouched; e2e covers it fully.

The target shape is reached here. Known limits until later steps: workers are separate processes but not sandboxed,
each worker holds the TLS key, and a Node process per connection costs roughly 50 ms and 30–50 MB.

- As built:
  - **Listener**: `packages/gateway/src/web.ts` (`nebula-web`), same command line as before (`--listen-fd 3
    --login-socket <path> ...`). A `net.Server` on the inherited fd with `pauseOnConnect`; caps of 256 workers in all
    and 32 per client IP (over them a connection is closed at once). It loads the TLS key and certificate (or
    generates the self-signed pair) and the page once. Per connection: `unixConnect(login.sock)`, `ClientAddress`
    from `socket.remoteAddress` (IPv4 without the `::ffff:` prefix), then `spawn(node, web-worker.js)` with stdio
    `[ignore, inherit, inherit, <TCP socket>, <helper fd>, 'ipc']`, and our copies of both closed.
  - **Worker**: `packages/gateway/src/web-worker.ts` (`nebula-web-worker`): fd 3 the TCP connection, fd 4 the helper
    connection, a Node IPC channel. It calls `setNotDumpable()` first (exits if that fails), waits for the
    listener's `WorkerStart` message (TLS cert and key, the page with the host name filled in, allowed origins, the
    viewer directory, and `signIn`: `helper`, `blocked` or `unavailable`), wraps fd 3 in an HTTPS server
    (`emit('connection')`) and serves every request on it (keep-alive) or one WebSocket. It exits when the TCP
    connection closes, or when the IPC channel does (the listener is gone, e.g. stopped by the helper's SIGTERM).
    One sign-in per worker. The monitor backend is gone from the web process (it can no longer be started by
    `main.js`; step 5 deletes the monitor).
  - **Per-IP throttle** (until step 10): the `RateLimiter` lives in the listener. A worker reports a refused sign-in
    (`{type: 'refused'}` on IPC, before the page hears of it, so the page's next attempt finds the throttle up to
    date); the listener counts at most one per worker, for the IP it accepted the connection from. For a throttled IP
    the listener opens no helper connection and the worker answers the page's password with "Too many failed
    attempts" by itself.
  - **The helper connection is opened eagerly**, for every TCP connection, as specified (the listener can't know
    which connection will become a sign-in). Cost: a helper child per TCP connection, waiting for `Begin`; most get
    EOF instead (the dev helper ends those quietly) when their worker exits (Node's 5 s keep-alive timeout closes an
    idle connection). Consequences for the production helper (step 5): its cap on concurrent children counts every
    open TCP connection, so it must be at least the listener's 256 (or the listener's cap lowered); EOF before
    `Begin` is a normal end, not an error worth logging; its wait for `Begin` counts from the TCP accept, which works
    because browsers open the WebSocket on a fresh connection and the page sends `begin` as soon as it opens
    (a sign-in on a keep-alive connection older than that wait would fail).
  - **Native addon**: `setNotDumpable()` (`prctl(PR_SET_DUMPABLE, 0)`) in `fd_passing.c`.
  - **Cost measured** (Chrome, loopback, fresh context per load): a page load (the page and its 4 files, 1–2
    connections) takes about 145 ms instead of 42 ms; a single HTTPS request with a fresh connection (curl) about
    44 ms instead of 2.5 ms, nearly all of it starting the worker. The e2e suite's total stayed at about 34 s.

### 7. Port the listener and worker to Rust

- rustls for TLS (TLS 1.3 only), a minimal HTTP layer for static files and the WebSocket upgrade, the same helper
  protocol, the same relay. Workers are started with fork + exec, so each gets a fresh memory layout.
- Page assets loaded once by the listener into a sealed read-only memfd that each worker maps.
- As built:
  - **The crate** is `packages/login/web` (`nebula-web`) in the login workspace, reusing `protocol` and `common`
    (`Channel`, `spawn_with_fds`, logging). Dependencies: rustls 0.23 without default features (`ring`, `std`: no
    TLS 1.2 code at all; configured TLS 1.3 only, ALPN `http/1.1`, no session tickets since every connection is a
    fresh process) and ring 0.17 (also SHA-1 for `Sec-WebSocket-Accept`); pinned in `Cargo.lock`. ring needs only a C
    compiler; a cold release build of the workspace takes about 10 s, an incremental one well under a second. All
    unsafe code is in `web/src/sys.rs`.
  - **Two binaries**: the listener `nebula-web` (`src/bin/listener.rs`) and the worker `nebula-web-worker`
    (`src/bin/worker.rs`), next to each other and to the helpers in `target/release`. The helpers start the listener
    through `common/src/web.rs` (`web_binary`, `web_command`): `nebula-web --listen-fd 3 --login-socket <path>
    --viewer-dir <gateway-dir>/../../viewer/dist --static-dir <gateway-dir>/../static [--cert --key --state-dir
    --hide-hostname --allowed-origin]`; `--gateway-dir` now names only where `session-process.js` and the page are.
  - **Listener**: one thread, a `poll` loop over the listening socket and each worker's report socket. Caps (256 in
    all, 32 per IP), the `ClientAddress` record and the per-IP throttle (20 free failures, doubling blocks from 30 s
    to 15 min) are as in step 6. It loads the certificate and key (or generates the self-signed pair with `openssl`,
    as before; the log shows the SHA-256 fingerprint) and builds a server configuration once to check them, and loads
    `index.html` (host name filled in), `viewer/dist/assets/**` and `gateway/static/**` into a page bundle. Both go
    into sealed memfds (`F_SEAL_SEAL|SHRINK|GROW|WRITE`).
  - **Worker start**: fork + exec (`spawn_with_fds`, `PR_SET_PDEATHSIG` = SIGTERM, empty environment) with fd 3 the
    TCP connection, fd 4 the helper connection (only with `--sign-in helper`), fd 5 a report socket (one byte for a
    refused sign-in; its EOF is how the listener learns the worker exited), fd 6 the page bundle memfd, fd 7 the TLS
    memfd (certificate chain and key, PEM); arguments `--sign-in helper|blocked|unavailable` and `--allowed-origin`.
    Documented in `web/src/lib.rs`; the bundle layout (length-prefixed path and content entries) in
    `web/src/assets.rs`. The worker refuses memfds without all the seals, marks itself not dumpable first thing
    (`prctl`, reset by exec, so it does it itself), opens no files and serves only from the mapped bundle (exact path
    lookup, so no path traversal is possible).
  - **Worker HTTP**: request heads of at most 16 KiB and 100 headers, HTTP/1.1 keep-alive (or HTTP/1.0), GET/HEAD
    only (405 with `Allow: GET` and close otherwise; a request announcing a body is answered and the connection
    closed), the same routes, security headers, CSP, HSTS, cache headers and error pages as the Node worker. Limits:
    TLS handshake 10 s, the first request head 20 s, a further request's first byte 5 s (keep-alive), each response
    30 s. The sign-in's limits are unchanged (`begin` 10 s, answers 60 s, helper 90 s), plus 60 s for the desktop's
    handshake. Sign-in JSON is parsed by a small strict parser (`web/src/websocket.rs`).
  - **Relay**: non-blocking, one `poll` loop; it reads from the desktop only once TLS has sent everything (at most
    64 KiB at a time), so data waits in the session's queue; TCP_NODELAY and TCP_NOTSENT_LOWAT 32 KiB on the browser's
    socket as before. When the desktop closes, what it sent last (e.g. the takeover close frame) is flushed, then
    close_notify.
  - **Deleted**: `web.ts`, `web-worker.ts`, `tls.ts`, `pages.ts`, `rate-limit.ts` and `test/web.test.ts` in the
    gateway (their tests are now Rust unit tests and `web/tests/listener.rs`), and `setNotDumpable` from the poll
    addon. The gateway keeps `login-protocol.ts` (the session's `Handover`; `unixConnect`, `sendWithFd` and
    `RecordChannel.write` stay for its test of the shared layout).
  - **Cost measured** (Chrome, loopback, fresh context per load): a page load takes about 41 ms (Node workers: 145 ms,
    before step 6: 42 ms); a single HTTPS request with a fresh connection (curl) about 2 ms (Node workers: 44 ms). The
    e2e suite's total stayed at about 33 s. `auth.sh` checks that TLS 1.2 is refused and that `nebula-web` refuses dev
    options.
  - **For later steps**: step 8 can sandbox the worker after it has mapped its memfds and built its TLS
    configuration (it needs read/write/sendmsg/recvmsg/poll/close/getrandom/exit and nothing that opens files); step 9
    replaces fd 7 (the key) with a signing channel to the listener; step 12 changes only `http::route` (cache headers)
    and the bundle; for step 13's socket activation, `nebula-web` takes the listening socket as an inherited fd at any
    number (`--listen-fd`).

### 8. Sandbox the workers

- `no_new_privs`, a seccomp allowlist (read, write, sendmsg/recvmsg, poll, close, timers, exit), rlimits, no
  filesystem access, timeouts at every stage. The worker never opens anything itself: the listener passes it the
  helper channel.
- Not planned: a separate uid per worker from a reserved pool. Non-dumpable workers (step 6) and the seccomp
  allowlist already keep workers apart, and a uid pool would need root to start every worker.

### 9. Keep the TLS key in the listener

- Workers ask the listener to sign their handshake through rustls's signing-key interface. The listener signs only
  the exact TLS 1.3 CertificateVerify layout, once per worker. An exploited worker can't copy the key.

### 10. Per-IP failure backoff

- A fixed-size table in the helper's main loop, fed by fixed-size `{ip, ok}` reports from its own children. Per-account
  lockout stays with `pam_faillock`; document it and fail2ban in the README.
- As built:
  - **The table** is `common/src/backoff.rs` (`Table`, `Policy`, `Report`, `drain`), used by both helpers: 4096 slots
    (a full table replaces an unblocked entry with the oldest failure, else the block that ends first). Policy: 10 free
    failures per address, then a block of 30 s doubling with each further failure up to 15 min; an address is
    forgotten 15 min after its last failure or block end. Successes change nothing (shared addresses; an attacker's own
    account mustn't reset the count). IPv6 counts per /64, IPv4-mapped as IPv4. The dev helper divides the times by
    `--dev-time-scale`.
  - **Reports**: 18 bytes (u8 family 4/6, u8 ok, 16 address bytes) on the existing per-attempt pipe (the dev helper
    got one too), written when the attempt is decided and before the `Result` goes to the web process, so the page's
    next attempt is forked after the main loop has read it (it drains every pipe right before each fork, and a reaped
    child's pipe before dropping it).
  - **The decision is the child's**, with the copy of the table it was forked with (no query back to the parent; the
    pipes stay one-way). Attempts forked before a block started still run (bounded by the connections open then).
    A blocked attempt gets the normal failure: the `Password: ` prompt, the 3 s minimum and the wrong-password
    message; PAM never sees it and it isn't reported (it doesn't extend the block). In `nebula-login` this is two
    `Host` methods (`throttled`, `report`) called from `attempt.rs`.
  - **Log lines** for fail2ban: `Failed sign-in from <ip>: ...`, `Refused a sign-in [as root] from <ip>...`,
    `Blocking sign-ins from <ip> for <n> s after <k> failed attempts.` The README documents pam_faillock and a
    fail2ban filter and jail.
  - **The web listener's `RateLimiter` stays** (20 free failures, "Too many failed attempts", without contacting the
    helper) as a cheap first line; it duplicates the helper's table. Step 7 ports the listener as it is; whether the
    front's limiter goes (the helper's table is the one that matters) is a later cleanup. `auth.sh` checks both: the
    right password fails after 10 failures (the helper), "Too many failed attempts" after 20 (the listener).

### 11. Account policy

- Refuse uids below `UID_MIN` (`/etc/login.defs`) and shells not in `/etc/shells` by default, both configurable.
- Expired passwords: `PAM_NEW_AUTHTOK_REQD` → `pam_chauthtok` through the same prompt relay, with a page UI for it.
- As built:
  - **Policy** (`packages/login/login/src/policy.rs`): root never; uids below `--min-uid` (default `UID_MIN` from
    `/etc/login.defs`, read at start, else 1000); login shells not listed in `/etc/shells` (read at every check, so a
    newly installed shell counts at once; an empty shell field is `/bin/sh`; without the file only `/bin/sh` and
    `/bin/csh`, as glibc's `getusershell`) unless `--allow-any-shell`. Checked like root was: on the given name before
    PAM (a refused account gets the fake `Password: ` prompt and never reaches PAM, so system accounts can't be
    password-guessed through nebula), and on the canonical PAM user after `pam_authenticate`/`pam_acct_mgmt`. The page
    gets the wrong-password message after the same minimum time; the log has the reason.
  - **Backoff (step 10)**: policy refusals are reported as failures (before PAM like root and unusable names, so the
    backoff doesn't tell refused accounts from unknown names, which PAM fails and which are reported; after PAM like
    root). An expired password that wasn't changed is not reported: the password was right, and PAM's own retries
    limit the new ones. A successful change goes on to the success report.
  - **Expired passwords**: `Pam::change_password` = `pam_chauthtok(PAM_CHANGE_EXPIRED_AUTHTOK)` on the attempt's handle,
    whose conversation is the same `Relay`; called after the policy check, then the sign-in goes on (attach or create).
    Not changed (wrong current password, PAM's retries used up): refused with "The password has expired and was not
    changed." after the failure minimum. `pam_acct_mgmt` isn't run again (as login and sshd). No protocol change.
  - **Page**: PAM's info and error messages now accumulate (one per line) until the page answers the next prompt, then
    clear, so each prompt shows with the messages that came before it (the expiry notice and "Changing password for
    …" with "Current password:", a mismatch with the repeated "New password:").
  - **Dev helper**: `--dev-expired-password` makes every sign-in go through pam_unix's change conversation (the
    notice, the current password, the new one twice, three tries); the new password isn't kept. e2e:
    `scripts/e2e/password.sh` (its own gateway, in the runner).
  - Not changed: the whole-attempt limit (180 s, `ATTEMPT_TIMEOUT_SECONDS`) also covers a password change; a slow
    change with several retries could hit it (raise it if that matters).

### 12. Immutable caching for page assets

- Serve content-hashed asset files with a long `immutable` cache lifetime, so repeat visits only fetch `index.html`
  and open the WebSocket. Fewer connections means fewer workers.

### 13. systemd units and hardening

- Socket activation for the listener (so nothing has to bind port 443 as root), unit hardening (`ProtectSystem`,
  `NoNewPrivileges` on the front, an empty capability set, `RestrictAddressFamilies`), a unit for the helper.
- systemd stays optional: without it, the helper binds the port as in step 5.
- Stopping the service ends the running desktops (see "Why this shape"); nothing extra is built for it.
- Ties in with the install script item in ROADMAP.md.
- As built:
  - **Units** in `packages/login/systemd/` (`nebula.socket`, `nebula.service`); install steps in
    `packages/gateway/README.md` ("As a systemd service"), reasoning in `packages/login/README.md` ("systemd").
  - **Socket activation**: `login/src/activation.rs` parses `LISTEN_PID` / `LISTEN_FDS` (unit-tested), `main.rs`
    `listening_socket` adopts fd 3 (`sys::adopt_tcp_listener`: stream, listening, AF_INET/INET6, close-on-exec) instead
    of binding; exactly one socket. Without the variables it binds as before.
  - **Hardening**: the unit's settings reach every desktop and app, so only `RestrictAddressFamilies=AF_UNIX AF_INET
    AF_INET6 AF_NETLINK` is set; `NoNewPrivileges`, the capability set and `ProtectSystem` are left out of the helper's
    unit on purpose (they'd break PAM sessions and users' setuid programs, mounts, `/dev/dri`). The front gets those
    in step 8's sandbox (in the workers) and from the helper's drop to an unprivileged user, not from systemd.
  - **Stopping**: `KillMode=mixed`, `TimeoutStopSec=20` (the helper's own shutdown does the work; desktops sit in
    session scopes outside the unit's cgroup, so a cgroup kill wouldn't reach them).

## Order and parallelism

```
1 ──┐
    ├──> 3 ──> 4 ──┬──> 5 ──┬──> 10
2 ──┘              │        └──> 11
                   └──> 6 ──> 7 ──┬──> 8
                                  └──> 9
                        6 ──> 12, 13   (independent of each other and of 7–11)
```

- **1 and 2 can run in parallel.** Step 1 is the viewer flow and monitor; step 2 is the config path into the session.
- **3 needs 1** (both change the viewer's sign-in flow). **4 needs 2 and 3** (the dev helper writes `SessionConfig`
  and speaks the WebSocket sign-in).
- **5 and 6 can run in parallel after 4.** Step 5 is root code and the entry point; step 6 splits the web process.
  The only shared spot is the entry point that starts the front (the web process, then the listener).
- **After 5 and 6, two tracks and a set of independent items:**
  - helper track: 10 and 11 in parallel after 5;
  - front track: 7, then 8 and 9 in parallel (both are easiest in the Rust worker);
  - independent: 12 (caching) and 13 (systemd) can start any time after 6, in parallel with everything.
- **Security-critical steps** (5, 8, 9, 10, 11) each touch root code or a trust boundary. Review each one on its own
  rather than batching them.

## How the steps are run

- One agent per step, each on its own branch and worktree; a step is merged before the steps that depend on it start.
  Independent steps run in parallel.
- Where this document leaves a detail open and there is an obvious, simple approach, the agent takes it and notes it
  in its report (and in this document, if later steps rely on it).
- Where it hits a real gap (a core decision this document doesn't make and that has no straightforward answer, or a
  problem that breaks the design), the agent stops, reports the step as not completed and explains the gap. It does
  not invent a large design of its own. Steps that depend on a stopped step don't start until the gap is resolved;
  independent steps carry on.

## Manual checks

An agent works through all the steps on its own. Checks that need root are left to the user and done once, after the
last step. Step 5 counts as complete without them: implement the root code carefully, make it build, and cover
everything a non-root test can reach.

Once everything is done, the user checks with sudo and real PAM:

- signing in, a wrong password, and refusal of uid 0;
- reattaching to a running desktop, and takeover;
- Log out closing the PAM session (`pam_close_session` runs, `pam_mount` unmounts);
- `PAM_RHOST` showing the client IP in the auth log;
- a killed PAM parent ending its desktop;
- the systemd units (step 13): install them, `systemctl enable --now nebula.socket`, connect (the service starts and
  logs "Using the socket passed by systemd"), sign in, then `systemctl stop nebula.service`: the desktop ends, the
  session scope goes away (`loginctl list-sessions`), `/run/nebula` is removed, and a new connection restarts the
  service; also `systemctl start nebula.service` without the socket unit's help and a sign-in with
  `RestrictAddressFamilies` active (apps still reach the network, `getent hosts` works in a desktop terminal).

## Not planned

- Built-in ACME for real certificates. Admins bring their own certificate (`--cert` / `--key`) or use the generated
  self-signed one.
