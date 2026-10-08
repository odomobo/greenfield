# Nebula

A multi-user remote desktop for Linux servers, in the browser. Open the server's URL, sign in, and
you're at a full Linux desktop — your apps, your files, your session, composited and window-managed
by the browser. Sessions survive closing the tab; sign in again and you're back where you left off.

Started as a fork of [Greenfield](https://github.com/udevbe/greenfield).

## How it works

The server runs a Wayland compositor (wlroots) per user. The browser receives a window-scene
protocol over a single WebSocket, decodes the frames, and draws each window as its own DOM element
(one canvas per surface, composited and hit-tested by the browser). The browser also runs the window
manager, the desktop shell, and the input handling. Sign-in is PAM, over TLS, privilege-separated.

## Layout

| Directory | Language | What |
|---|---|---|
| `packages/scene-protocol` | TypeScript | Wire protocol (windows, frames, control messages) |
| `packages/viewer` | TypeScript, React, C→WASM | Browser client: sign-in, desktop shell, window management, decoding |
| `packages/session` | TypeScript, C (Node addons, wlroots) | Per-user desktop: compositor, encoding, transport, shell service, audio |
| `packages/gatekeeper` | Rust | Login helpers (PAM + dev), web front (TLS, HTTP, WebSocket, seccomp sandbox) |
| `scripts/` | Bash, JS, C | End-to-end test suite |

## Building

```sh
npm install     # JS dependencies (once, or after changing package.json)
make            # builds everything: scene-protocol, session, viewer, gatekeeper
make gatekeeper # just the Rust side
make viewer     # just the browser client
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — design decisions, encoding policy, transport, audio
- [ROADMAP.md](ROADMAP.md) — remaining work
- [DESIGN.md](DESIGN.md) — shell UI, theme, motion
- [packages/session/README.md](packages/session/README.md) — process architecture, how sign-in works
- [packages/gatekeeper/README.md](packages/gatekeeper/README.md) — the Rust crates, the web front, the sandbox
- [packages/viewer/README.md](packages/viewer/README.md) — the browser side, the shell, query parameters

## License

[AGPL-3.0](LICENSE)
