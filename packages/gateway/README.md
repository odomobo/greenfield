# Gateway

The front door: a login page and the per-user desktop sessions behind it (one desktop per user).

## Processes

Production (PAM, `main.js` as root; step 5 of [SIGNIN-ROADMAP.md](../../SIGNIN-ROADMAP.md) replaces the monitor with
the production login helper):

```
gateway (monitor)          root. Not network-facing. Authenticates users through native/pam-helper,
│                          issues one-use login tickets, keeps the session registry, spawns sessions.
├── gateway-web            unprivileged (--web-user, default "greenfield"). TLS, the page, Origin checks, failed
│                          sign-in throttling, viewer files; runs the sign-in on the page's WebSocket and then relays
│                          that WebSocket to the user's session socket. Gets the listening socket and TLS key from the
│                          monitor; asks the monitor (IPC) to authenticate, and to attach to or start the desktop
│                          with the ticket it got.
└── pam-helper session     root, tiny C. pam_open_session (pam_systemd → logind session, XDG_RUNTIME_DIR, user bus),
    └── session-process    then drops to the user: the server compositor (wlroots), the desktop shell's server side
                           and the user's apps. Listens on /run/greenfield/sessions/<id>/viewer.sock (dir
                           uid:webgroup 2750, socket 0660).
```

Development (the dev login helper, [packages/login](../login/README.md), the dev entry point; the same shape the
production login helper will have):

```
nebula-dev-login           the current user (never root). Binds the port, owns the --dev-* options. Accepts the web
│                          process's sign-ins on <runtime>/login.sock (the login protocol: client address, Begin,
│                          Prompt/Answer, Result), one forked child per sign-in.
├── gateway-web            started with the listening socket (fd 3) and where login.sock is. TLS, the page, Origin
│                          checks, failed sign-in throttling per IP, viewer files; relays the helper's prompts to the
│                          page and, once signed in, the WebSocket over the connection the Result carried.
└── sign-in child          checks the password, then attaches to or starts the user's desktop: flock on
    │                      <runtime>/users/<uid>/lock, connect to desktop.sock; if nothing listens, bind it and start
    │                      the desktop with the listening socket inherited. Hands it the connection (a socket pair end
    │                      and the client's address, a Handover record) and the web process the other end. A child
    │                      that started a desktop stays as its parent until it exits.
    └── session-process    the desktop, as the current user: accepts Handover records on its inherited desktop.sock
                           (SessionConfig.listenFd). Log out closes it: the next sign-in starts a new desktop.
```

TLS ends in the web process, so users' sessions never have access to the key. There is no plain-HTTP mode: without
`--cert`/`--key` the web process generates a self-signed certificate. A user's desktop dies when they log out or when the
gateway stops; closing the browser doesn't affect it.

## Building

Ubuntu 24.04 (wlroots 0.17 needs its libwayland 1.22; 22.04 is too old). The session's Wayland side is wlroots, a git
submodule built with meson as part of `yarn build`:

```bash
git submodule update --init
sudo apt install build-essential cmake ninja-build meson pkg-config clang lld \
  libwayland-dev wayland-protocols libpixman-1-dev libxkbcommon-dev libdrm-dev libgbm-dev libegl-dev libgles-dev \
  libopengl-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libgstreamer-plugins-bad1.0-dev \
  libgraphene-1.0-dev libudev-dev libffi-dev \
  xwayland libxcb1-dev libxcb-composite0-dev libxcb-ewmh-dev libxcb-icccm4-dev libxcb-render0-dev libxcb-res0-dev \
  libxcb-xfixes0-dev
yarn install
yarn build
```

The login helpers (`packages/login`) are Rust: install a Rust toolchain with `cargo` (e.g. rustup; std and the
`libc` crate only). `yarn build` runs `cargo build --release` there.

`clang` and `lld` build the viewer's WebAssembly patch decoder (`wasm-ld`, or `wasm-ld-18`, or `$WASM_LD`; the build says
"install lld (apt install lld)" if it is missing).

The first build compiles wlroots (a few minutes); it's rebuilt when its build options change, and after changing the
submodule's version delete `packages/compositor-proxy/build/wlroots` so it's rebuilt. Running sessions also needs the
apps' runtime pieces: `dbus-daemon`, `Xwayland` (package xwayland, for X11 apps), and for the end-to-end test `foot`,
`notify-send` (libnotify-bin), x11-utils (xev, xfontsel, xwininfo) and playwright-cli.

X11 apps: each session has an X11 display (XWayland, `DISPLAY` for the apps it launches; Xwayland itself starts when
the first X11 app connects). `GFLD_XWAYLAND=0` in the gateway's environment turns it off.

## Development (no root)

```bash
yarn build   # builds packages/login (cargo) too
env -u DISPLAY GREENFIELD_DEV_PASSWORD='choose-a-password' \
  packages/login/target/release/nebula-dev-login --bind-port 8443
```

Open https://127.0.0.1:8443/ (self-signed certificate; the fingerprint is printed at startup) and sign in as your
own user with that password. The dev login helper has no PAM and no privilege separation: desktops run as you. It
refuses to start on non-loopback addresses, as root, or without a password of at least 8 characters. Its options
(`--help`): the `--dev-*` experiments and test settings (`--dev-time-scale`, `--dev-link-kbps`, `--dev-patch-order`,
`--dev-patch-shape`), `--encoder` / `--render-device` / `--site-config`, `--runtime-dir` (default
`$XDG_RUNTIME_DIR/nebula-dev-<port>`), and the web process's `--cert`, `--key`, `--state-dir` (default
`~/.local/state/greenfield-dev`), `--hide-hostname`, `--allowed-origin`, which it passes on. The gateway's `main.js`
and the web process take no dev options.

End-to-end test: `scripts/test-gateway.sh` (runs the scripts in `scripts/e2e/` in parallel; they start the dev login
helper with `--dev-time-scale 3`, a test-only option that divides the failed-sign-in delay, each with its own runtime
directory).

## Real mode (PAM, multi-user)

One-time setup (Debian/Ubuntu):

```bash
sudo apt install libpam0g-dev                      # to build the PAM helper
yarn build   # builds dist/pam-helper too
sudo cp -a ~/greenfield /opt/greenfield            # readable by the web user and all users (not under a 0750 home)
sudo cp "$(command -v node)" /usr/local/bin/node   # a node every user can execute (nvm's lives in your home)
sudo cp /opt/greenfield/packages/gateway/pam/greenfield /etc/pam.d/greenfield
sudo useradd --system --no-create-home --shell /usr/sbin/nologin greenfield
```

Run:

```bash
sudo env -u DISPLAY /usr/local/bin/node /opt/greenfield/packages/gateway/dist/main.js --bind-port 443
```

Options: `--cert/--key` for a real certificate (default: self-signed in /var/lib/greenfield/tls), `--hide-hostname`,
`--allowed-origin` (behind a reverse proxy), `--help` lists everything.

Site settings (the video encoder and the GPU render node) are in a root-owned file, `/etc/nebula/nebula.conf` (another
path with `--site-config`); a missing file means the defaults. Format (see `src/site-settings.ts`):

```
# encoder: auto (default: a hardware video encoder if the machine has one, else none, which sends everything as
# lossless patches), none, nvh264 or vaapih264
encoder = auto
render-device = /dev/dri/renderD128
```

Each session reads the file itself and detects the encoder itself (`gst-inspect-1.0` runs as the user, never in the
privileged monitor). `--encoder` and `--render-device` override the file (the monitor writes a file for the sessions
from them).

A session is started with a `SessionConfig` record on fd 3 (format in `src/session-config.ts`) and has no other
start-up input; its `devFlags` section (time scale, simulated link, patch order and shape) is what the dev login
helper's `--dev-*` options fill in. Started by a login helper, it inherits its listening socket (`listenFd`), on which
connections arrive as Handover records (`src/login-protocol.ts`, layout in `packages/login/protocol`); the fd passing
is in the compositor proxy's small poll addon (`native/poll/src/fd_passing.c`).

## Desktop shell

The taskbar, Apps menu, window previews and notifications are drawn by the browser (packages/viewer/src/shell); their
state lives in the session process (src/shell), so it survives the browser going away:

- Apps: the user's and the system's `.desktop` files (`$XDG_DATA_HOME/applications`, `$XDG_DATA_DIRS/*/applications`),
  without hidden and other desktops' entries. Launched from their `Exec` line (no field codes; `Terminal=true` apps in
  the first installed terminal), as the user, in the session. Icons from the user's icon theme, hicolor and pixmaps.
- Pinned apps: `$XDG_CONFIG_HOME/greenfield/pinned.json` (a terminal is pinned until the user changes the list).
- Notifications: the session serves `org.freedesktop.Notifications` on the session bus and keeps the last 50. With
  logind, a user's sessions share one bus: the first session gets the notifications, later ones queue for the name.

## Security properties

- The sign-in page shows only a username/password form and the host name. Unknown user and wrong password produce
  the same result, and every failure takes at least 3 s. No sessions, users or product/version names before signing in.
- Failed sign-ins are throttled per IP (20 free), with doubling lockouts up to 15 min. There is no per-user throttling
  here: per-account lockout is PAM's job (`pam_faillock`).
- Signing in works like unlocking a screen: the page's one WebSocket (`/ws`) is the sign-in. The page signs in on it
  (in-band: the server's prompts and the page's answers, see "Sign-in" in `libs/scene-protocol/src/index.ts`) and the
  same WebSocket then carries the desktop. No tokens, no cookies, no API: when the WebSocket closes (tab closed,
  reloaded, network gone, a new sign-in of the same user taking the desktop over), the page shows the sign-in form
  again. The desktop itself keeps running until the user logs out (an in-band message to the desktop).
- One desktop and one connection per user: a new sign-in takes the desktop over, and the old page is told so,
  with the new connection's IP address.
- The WebSocket must carry a matching `Origin`. Strict CSP, no inline scripts, `frame-ancestors 'none'`,
  `form-action 'none'`, `Cache-Control: no-store` on the page, HSTS.
- A ticket only reaches its own user's desktop, is used once, right after the sign-in, and expires after a minute;
  session ids are random.
- No root sessions.
