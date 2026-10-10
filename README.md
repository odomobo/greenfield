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
| `packages/session` | TypeScript, C (Node addons, wlroots) | Per-user desktop: compositor (capture), the wiring of the streaming packages, viewer host, shell service, audio |
| `packages/session-contracts` | TypeScript | The interfaces between the session's streaming packages |
| `packages/frames` | TypeScript, C (Node addon) | The native frame object and its handle |
| `packages/congestion` | TypeScript | BBRv3-style congestion estimator |
| `packages/traffic-policy` | TypeScript | Surface priority, bottleneck, tiers and weights, link judgment |
| `packages/scheduler` | TypeScript | Patch worker scheduling and frame pacing |
| `packages/surface` | TypeScript | One surface's rendering: patches or video, and the switch |
| `packages/patch-renderer` | TypeScript | Per surface: damage queue, patch planning and order |
| `packages/video-renderer` | TypeScript | Per surface: on-demand video frames, key frames, quality |
| `packages/patch-codec` | TypeScript, C (Node addon) | Patch encoding: PNG, QOI / LZ4 / JPEG in a native addon, the worker pools |
| `packages/video-codec` | TypeScript, C (Node addon) | The GStreamer encoder, the hardware encoder pool, detection |
| `packages/transport` | TypeScript, C (Node addon) | Fair-queueing send mechanism, chunking, WebSocket, simulated link |
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

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — design decisions, encoding policy, transport, audio
- [ROADMAP.md](docs/ROADMAP.md) — remaining work
- [DESIGN.md](docs/DESIGN.md) — shell UI, theme, motion
- [docs/MODULARIZATION.md](docs/MODULARIZATION.md) — the session's streaming packages and their boundaries
- [packages/session/README.md](packages/session/README.md) — process architecture, how sign-in works
- [packages/gatekeeper/README.md](packages/gatekeeper/README.md) — the Rust crates, the web front, the sandbox
- [packages/viewer/README.md](packages/viewer/README.md) — the browser side, the shell, query parameters

## License

[AGPL-3.0](LICENSE)
