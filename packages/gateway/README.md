# Gateway

The front door: a login page, a per-user session picker, and the per-user desktop sessions behind it.

## Processes

```
gateway (monitor)          root in PAM mode. Not network-facing. Authenticates users through native/pam-helper,
│                          issues login tickets, keeps the session registry, spawns sessions.
├── gateway-web            unprivileged (--web-user, default "greenfield"). TLS, pages, cookies, CSRF/Origin
│                          checks, login throttling, viewer files; relays authenticated viewer WebSockets and app
│                          launches to the user's session socket. Gets the listening socket and TLS key from the
│                          monitor; asks the monitor (IPC) for everything user-related, by ticket.
└── pam-helper session     root, tiny C. pam_open_session (pam_systemd → logind session, XDG_RUNTIME_DIR, user bus),
    └── session-process    then drops to the user: the server compositor + the user's apps. Listens on
                           /run/greenfield/sessions/<id>/viewer.sock (dir uid:webgroup 2750, socket 0660).
```

TLS ends in the web process, so users' sessions never have access to the key. A session dies when it's ended from
the picker or when the gateway stops; closing the browser doesn't affect it.

## Development (no root)

```bash
yarn workspaces foreach -A --parallel --topological-dev run build
cd packages/gateway
env -u DISPLAY GREENFIELD_DEV_PASSWORD='choose-a-password' \
  node dist/main.js --dev-auth --bind-ip 127.0.0.1 --bind-port 8443 --applications=$HOME/greenfield-apps.json
```

Open https://127.0.0.1:8443/ (self-signed certificate; the fingerprint is printed at startup) and sign in as your
own user with that password. `--dev-auth` skips PAM and privilege separation: sessions run as you. It refuses to
start on non-loopback addresses, as root, or without a password of at least 8 characters.

End-to-end test: `scripts/test-gateway.sh`.

## Real mode (PAM, multi-user)

One-time setup (Debian/Ubuntu):

```bash
sudo apt install libpam0g-dev                      # to build the PAM helper
yarn workspaces foreach -A --parallel --topological-dev run build   # builds dist/pam-helper too
sudo cp -a ~/greenfield /opt/greenfield            # readable by the web user and all users (not under a 0750 home)
sudo cp "$(command -v node)" /usr/local/bin/node   # a node every user can execute (nvm's lives in your home)
sudo cp /opt/greenfield/packages/gateway/pam/greenfield /etc/pam.d/greenfield
sudo useradd --system --no-create-home --shell /usr/sbin/nologin greenfield
```

Run:

```bash
sudo env -u DISPLAY /usr/local/bin/node /opt/greenfield/packages/gateway/dist/main.js \
  --bind-port 443 --applications=/etc/greenfield/apps.json
```

Options: `--cert/--key` for a real certificate (default: self-signed in /var/lib/greenfield/tls), `--hide-hostname`,
`--allowed-origin` (behind a reverse proxy), `--insecure-plaintext` (HTTP; only on loopback/private addresses, for a
trusted home LAN), `--encoder`, `--render-device`. `--help` lists everything.

## Security properties

- The login page shows only a username/password form and the host name. Unknown user and wrong password produce the
  same page, and every failure takes at least 3 s. No sessions, users or product/version names before login.
- Failed logins are throttled per username (5 free) and per IP (20 free), with doubling lockouts up to 15 min; the
  same rules apply to any username string.
- Session cookie: random, server-side, `HttpOnly`, `SameSite=Strict`, `Secure` + `__Host-` prefix with TLS; 12 h idle /
  7 day maximum. Every POST and WebSocket must carry a matching `Origin`; forms carry a CSRF token, API calls an
  `X-CSRF-Token` header. Strict CSP, no inline scripts, `frame-ancestors 'none'`, HSTS with TLS.
- A ticket only reaches its own user's sessions; session ids are random.
- No root sessions.
