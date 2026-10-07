# Sign-in Separation Roadmap

A separate roadmap for restructuring how nebula signs users in and connects their browser to their desktop. The main
[ROADMAP.md](ROADMAP.md) covers everything else. Where they disagree (one desktop per user, sessions surviving a
gateway restart, which is no longer
required), this document is newer and wins for sign-in and session lifetime.

Decided 2026-10-07. Step 1 is implemented.

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

### 3. Sign-in over the WebSocket

- The web process runs the sign-in on the page's one WebSocket (a single "Password" prompt for now), still calling the
  monitor's `auth`. On success it relays that same WebSocket to the user's desktop.
- Remove tokens, `/control` presence, `/api/*` and the viewer's token code (`auth.ts`). Log out becomes an in-band
  message to the desktop. The takeover message carries the new connection's IP.
- A dropped connection shows the sign-in form.
- Remove `--insecure-plaintext` (config, README, its check in `auth.sh`, the `http` case in `lib.sh`).
- Rewrite the e2e sign-in helper in `scripts/e2e/lib.sh` (and `probe.js`, `auth.sh`, `desktop.sh`, `audio.sh`).

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

### 7. Port the listener and worker to Rust

- rustls for TLS (TLS 1.3 only), a minimal HTTP layer for static files and the WebSocket upgrade, the same helper
  protocol, the same relay. Workers are started with fork + exec, so each gets a fresh memory layout.
- Page assets loaded once by the listener into a sealed read-only memfd that each worker maps.

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

### 11. Account policy

- Refuse uids below `UID_MIN` (`/etc/login.defs`) and shells not in `/etc/shells` by default, both configurable.
- Expired passwords: `PAM_NEW_AUTHTOK_REQD` → `pam_chauthtok` through the same prompt relay, with a page UI for it.

### 12. Immutable caching for page assets

- Serve content-hashed asset files with a long `immutable` cache lifetime, so repeat visits only fetch `index.html`
  and open the WebSocket. Fewer connections means fewer workers.

### 13. systemd units and hardening

- Socket activation for the listener (so nothing has to bind port 443 as root), unit hardening (`ProtectSystem`,
  `NoNewPrivileges` on the front, an empty capability set, `RestrictAddressFamilies`), a unit for the helper.
- systemd stays optional: without it, the helper binds the port as in step 5.
- Stopping the service ends the running desktops (see "Why this shape"); nothing extra is built for it.
- Ties in with the install script item in ROADMAP.md.

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
- a killed PAM parent ending its desktop.

## Not planned

- Built-in ACME for real certificates. Admins bring their own certificate (`--cert` / `--key`) or use the generated
  self-signed one.
