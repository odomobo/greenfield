# Sign-in Separation Roadmap

A separate roadmap for restructuring how nebula signs users in and connects their browser to their desktop. The main
[ROADMAP.md](ROADMAP.md) covers everything else. Where they disagree (one desktop per user, sessions surviving a
gateway restart, which is no longer
required), this document is newer and wins for sign-in and session lifetime.

Decided 2026-10-07. Nothing here is implemented yet.

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
- **TLS is done by a TLS library.** We write no TLS or crypto code. No kernel TLS, no handing TLS state around.
- **The production login helper never contains dev code.** The dev helper is a separate project. The session has no
  dev mode of its own: it is driven by dev flags in its config, which only the dev helper writes. The production helper
  doesn't know they exist.
- **No per-user throttling in our code.** Per-account lockout is PAM's job (`pam_faillock`).
- **2FA is deferred.** The sign-in protocol carries PAM's prompts generically, so it needs no protocol change later.

## Target architecture

```
Browser ──TCP──> listener ──starts──> worker (one per TCP connection) ──sign-in──> login helper (root)
   └────────────── TLS ──────────────────┘                                              │ starts
                                   worker <────── socket pair (relay) ──────> desktop <─┘ PAM parent (root)
```

- **Listener** (`nebula-web`, unprivileged): accepts TCP connections and starts a fresh worker for each. Never reads
  network data. Holds the TLS key.
- **Worker** (`nebula-web`, one per TCP connection): TLS, serving the page, relaying the PAM prompts to the helper,
  and after sign-in relaying bytes between the browser and the desktop. Exits when its connection closes.
- **Login helper** (root): forks a child per sign-in that runs PAM with one handle, then either hands the
  connection to the user's running desktop or opens the PAM session and starts the desktop.
- **PAM parent** (root): the sign-in child that started a desktop. It waits for the desktop to exit, then closes the
  PAM session. Today's `pam-helper session` parent does the same.
- **Desktop** (the user): today's session process. Owns the user end of the connection, closes the previous one on
  takeover.

Why this shape:

- **Per-connection workers** limit an exploit in the network-facing code to the attacker's own connection: no other
  users' sessions or passwords, no altered JavaScript for anyone else, no TLS key once the key is held by the
  listener (step 10).
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

Each step leaves a working application: unit tests and `scripts/test-gateway.sh` pass after every step. Steps 1–6
reach the target shape with the languages already in the repo (Node, C). Later steps harden or port one piece at a
time without changing how the pieces connect.

### 1. One desktop per user

- The monitor's create-session reuses the user's desktop if one exists. The viewer drops the session list: sign in,
  then attach or create.
- Still works because the processes and the relay are unchanged.
- Adjust the e2e scripts that create several sessions.

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
- Rewrite the e2e sign-in helper in `scripts/e2e/lib.sh` (and `probe.js`, `auth.sh`, `desktop.sh`, `audio.sh`).

### 4. The login protocol and the dev helper

- Add a small native addon for passing fds over Unix sockets and reading `SO_PEERCRED` (next to the existing
  `socket-options` code in compositor-proxy).
- The session accepts handed-over connections on `/run/nebula/users/<uid>/desktop.sock` from uid 0 or the
  session's own uid, next to its old `viewer.sock`. This is the same check in both modes: the production helper is
  root, the dev helper runs as the user. Accepting the own uid grants nothing, since that user controls the desktop
  anyway.
- Define the `login.sock` record protocol: `Begin`, `Prompt`, `Answer`, `Result`, with fixed layouts and hard length
  limits. On success the helper creates a socket pair, passes one end to the desktop and the other to the web
  process.
- **New project: the dev login helper.** It implements the protocol with `GREENFIELD_DEV_PASSWORD`, loopback-only
  client IPs, no PAM and no setuid, fills `devFlags` from its command line, owns the dev time scale, and starts the
  desktop as the current user.
- The web process uses `login.sock` in dev mode. Production still uses the monitor.
- Still works because the e2e suite (always dev mode) now exercises the new path end to end, and production is
  untouched. Temporary duplication until step 5: two backends in the web process, two connection styles in the session.

### 5. The production login helper replaces the monitor

- `packages/gateway/native/pam-helper.c` grows into the `nebula-login` daemon, speaking the same protocol as the dev helper:
  - accept loop on `login.sock`, peer uid check, global cap on attempts, one fork per attempt;
  - one PAM handle per attempt, prompts relayed to the page, `PAM_RHOST` and `PAM_TTY` set, a fixed 3 s minimum on
    failures, refusal of uid 0;
  - attach-or-create under a per-user lock; when creating, open the PAM session, start the desktop and stay as its
    PAM parent (the existing wait-then-`pam_close_session` code).
- It becomes the service entry point: it binds the port and starts the web process as `nebula-web` with the
  listening socket.
- Delete `monitor.ts`, `ipc.ts`, the web process's monitor backend and the session's `viewer.sock`.
- Manual check with real PAM as root (e2e can't run as root). The rest is already covered by step 4.

### 6. Listener and per-connection workers

- Split `web.ts`: a listener (`net.Server` with `pauseOnConnect`, connection caps, never reads) that forks one worker
  per TCP connection and hands it the socket; the worker holds today's per-connection code (TLS, files, sign-in,
  relay).
- The fd addon marks workers as not dumpable, so workers can't inspect each other.
- Still works because the helper protocol, the session and the viewer are untouched; e2e covers it fully.

The target shape is reached here. Known limits until later steps: workers are separate processes but not sandboxed,
each worker holds the TLS key, and a Node process per connection costs roughly 50 ms and 30–50 MB.

### 7. Port the login helper to Rust

- `nebula-login` in Rust with only std, libc and libpam. Same protocol, same behaviour. Parsing code uses
  `#![forbid(unsafe_code)]`.
- Decide here what happens if a PAM parent is killed (leave the desktop running, or have it exit via
  `PR_SET_PDEATHSIG`).

### 8. Port the listener and worker to Rust

- rustls for TLS (TLS 1.3 only), a minimal HTTP layer for static files and the WebSocket upgrade, the same helper
  protocol, the same relay. Workers are started with fork + exec, so each gets a fresh memory layout.
- Page assets loaded once by the listener into a sealed read-only memfd that each worker maps.

### 9. Sandbox the workers

- `no_new_privs`, a seccomp allowlist (read, write, sendmsg/recvmsg, poll, close, timers, exit), rlimits, no
  filesystem access, timeouts at every stage. The worker never opens anything itself: the listener passes it the
  helper channel.
- Optional: a separate uid per worker from a reserved pool, started by the helper.

### 10. Keep the TLS key in the listener

- Workers ask the listener to sign their handshake through rustls's signing-key interface. The listener signs only
  the exact TLS 1.3 CertificateVerify layout, once per worker. An exploited worker can't copy the key.
- Open decision: whether this is worth its code, or each worker holds the key.

### 11. Per-IP failure backoff

- A fixed-size table in the helper's main loop, fed by fixed-size `{ip, ok}` reports from its own children. Per-account
  lockout stays with `pam_faillock`; document it and fail2ban in the README.

### 12. Account policy

- Refuse uids below `UID_MIN` (`/etc/login.defs`) and shells not in `/etc/shells` by default, both configurable.
- Expired passwords: `PAM_NEW_AUTHTOK_REQD` → `pam_chauthtok` through the same prompt relay, with a page UI for it.

### 13. Immutable caching for page assets

- Serve content-hashed asset files with a long `immutable` cache lifetime, so repeat visits only fetch `index.html`
  and open the WebSocket. Fewer connections means fewer workers.

### 14. systemd units and hardening

- Socket activation for the listener (so nothing has to bind port 443 as root), unit hardening (`ProtectSystem`,
  `NoNewPrivileges` on the front, an empty capability set, `RestrictAddressFamilies`), a unit for the helper.
- systemd stays optional: without it, the helper binds the port as in step 5.
- Stopping the service may end running desktops (see "Why this shape").
- Ties in with the install script item in ROADMAP.md.

## Order and parallelism

```
1 ──┐
    ├──> 3 ──> 4 ──┬──> 5 ──> 7 ──┬──> 11
2 ──┘              │              └──> 12
                   └──> 6 ──> 8 ──┬──> 9
                                  └──> 10
                        6 ──> 13, 14   (independent of each other and of 7–12)
```

- **1 and 2 can run in parallel.** Step 1 is the viewer flow and monitor; step 2 is the config path into the session.
- **3 needs 1** (both change the viewer's sign-in flow). **4 needs 2 and 3** (the dev helper writes `SessionConfig`
  and speaks the WebSocket sign-in).
- **5 and 6 can run in parallel after 4.** Step 5 is root code and the entry point; step 6 splits the web process.
  The only shared spot is the entry point that starts the front (the web process, then the listener).
- **After 6, two tracks and a set of independent items:**
  - helper track: 7, then 11 and 12 in parallel (doing them after the Rust port avoids writing them twice);
  - front track: 8, then 9 and 10 in parallel (both are easiest in the Rust worker);
  - independent: 13 (caching) and 14 (systemd) can start any time after 6, in parallel with everything.
- **Security-critical steps** (5, 7, 9, 10, 11, 12) each touch root code or a trust boundary. Review each one on
  its own rather than batching them.

## Open decisions

- Remote key signing vs each worker holding the key (step 10).
- Default account policy (step 12).
- A killed PAM parent: leave the desktop running, or `PR_SET_PDEATHSIG` (step 7).
- Optional built-in ACME for real certificates, in the listener (after step 8).
