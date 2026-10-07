# Gateway

The front door: a login page and the per-user desktop sessions behind it (one desktop per user).

## Processes

```
gateway (monitor)          root in PAM mode. Not network-facing. Authenticates users through native/pam-helper,
│                          issues login tickets, keeps the session registry, spawns sessions.
├── gateway-web            unprivileged (--web-user, default "greenfield"). TLS, the page, sign-in tokens, Origin
│                          checks, login throttling, viewer files; relays authenticated viewer WebSockets to the
│                          user's session socket. Gets the listening socket and TLS key from the
│                          monitor; asks the monitor (IPC) for everything user-related, by ticket.
└── pam-helper session     root, tiny C. pam_open_session (pam_systemd → logind session, XDG_RUNTIME_DIR, user bus),
    └── session-process    then drops to the user: the server compositor (wlroots), the desktop shell's server side
                           and the user's apps. Listens on /run/greenfield/sessions/<id>/viewer.sock (dir
                           uid:webgroup 2750, socket 0660).
```

TLS ends in the web process, so users' sessions never have access to the key. A user's desktop dies when they log out or when the gateway stops; closing the browser doesn't affect it.

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
yarn build
cd packages/gateway
env -u DISPLAY GREENFIELD_DEV_PASSWORD='choose-a-password' \
  node dist/main.js --dev-auth --bind-ip 127.0.0.1 --bind-port 8443
```

Open https://127.0.0.1:8443/ (self-signed certificate; the fingerprint is printed at startup) and sign in as your
own user with that password. `--dev-auth` skips PAM and privilege separation: sessions run as you. It refuses to
start on non-loopback addresses, as root, or without a password of at least 8 characters.

End-to-end test: `scripts/test-gateway.sh` (runs `scripts/e2e/auth.sh`, `desktop.sh` and `x11.sh` in parallel; they
start the gateway with `--dev-auth --dev-time-scale 3`, a test-only flag that divides the failed-sign-in delay and the
presence timeouts, and is refused without `--dev-auth`).

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
`--allowed-origin` (behind a reverse proxy), `--insecure-plaintext` (HTTP; only on loopback/private addresses, for a
trusted home LAN), `--help` lists everything.

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
start-up input; its `devFlags` section (time scale, simulated link, patch order and shape) is what the `--dev-*`
options fill in.

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

- The login page shows only a username/password form and the host name. Unknown user and wrong password produce the
  same page, and every failure takes at least 3 s. No sessions, users or product/version names before login.
- Failed logins are throttled per username (5 free) and per IP (20 free), with doubling lockouts up to 15 min; the
  same rules apply to any username string.
- Signing in works like unlocking a screen: it lasts as long as that one page. The sign-in form and
  desktop are a single page; signing in returns a random token that the page keeps only in memory (no cookies, no
  local/session storage). API calls carry it as `Authorization: Bearer`, WebSockets as their first message (never in
  a URL). The page holds a presence WebSocket (`/control`); when it closes, the token is revoked after a 5 s grace
  for network blips (and a token that never gets a presence expires after 10 s). So another tab, a reload, or
  closing and reopening the browser all ask for the password again, and revoking also cuts the page's desktop
  connection. The desktop sessions themselves keep running. Tokens also end after 7 days.
- Every POST and WebSocket must carry a matching `Origin`. Strict CSP, no inline scripts, `frame-ancestors 'none'`,
  `form-action 'none'`, `Cache-Control: no-store` on the page and API, HSTS with TLS.
- A ticket only reaches its own user's sessions; session ids are random.
- No root sessions.
