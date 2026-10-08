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
| `libs/scene-protocol` | TypeScript | Wire protocol (windows, frames, control messages) |
| `packages/viewer` | TypeScript, React, C→WASM | Browser client: sign-in, desktop shell, window management, decoding |
| `packages/compositor-proxy` | TypeScript, C (Node addons, wlroots) | Server compositor, encoding, transport |
| `packages/gateway` | TypeScript | Per-user session process, shell service, audio |
| `packages/login` | Rust | Login helpers (PAM + dev), web front (TLS, HTTP, WebSocket, seccomp sandbox) |
| `scripts/` | Bash, JS, C | End-to-end test suite |

## Building

```sh
yarn install    # JS dependencies (once, or after changing package.json)
make            # builds everything: scene-protocol, compositor-proxy, gateway, viewer, login
make login      # just the Rust side
make viewer     # just the browser client
```

## Documentation

- [ROADMAP.md](ROADMAP.md) — architecture, design decisions, encoding policy, transport, task list
- [DESIGN.md](DESIGN.md) — shell UI, theme, motion
- [packages/gateway/README.md](packages/gateway/README.md) — process architecture, how sign-in works
- [packages/login/README.md](packages/login/README.md) — the Rust crates, the web front, the sandbox
- [packages/viewer/README.md](packages/viewer/README.md) — the browser side, the shell, query parameters

## License

[AGPL-3.0](LICENSE)
