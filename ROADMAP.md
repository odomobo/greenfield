# Roadmap

This project started as a fork of [Greenfield](https://github.com/udevbe/greenfield) and is becoming something different: a
multi-user remote desktop for managing a Linux server from the browser, as an alternative to SSH. (It will be renamed.)

This document records the design decisions made so far and the order of the remaining work.

## Vision

- Open the server's URL in a browser → a sign-in page → a list of your sessions (attach to one or start a new one) → a
  full Linux desktop of the server's apps, in the browser.
- **Session state lives on the server; compositing happens in the browser.** The server is the authoritative Wayland
  compositor. The browser draws each window from its own image stream and acts as window manager and desktop shell.
- Rule of thumb: the browser does anything that doesn't depend on server state and makes sense to do there
  (hit-testing, window placement, animations, the shell UI).
- Sessions survive closing the browser. Sign in again and you're back where you left off.
- Goal: snappy regardless of latency. An effective remote desktop, not bells and whistles.
- Reuse the good parts of Greenfield (libwayland fork, GStreamer encoder, TS protocol implementation, WebGL renderer,
  WebCodecs decoding). Drop what doesn't serve this goal (WASM apps, browser-as-Wayland-server, the unauthenticated
  proxy CLI).

## Architecture

- **Session process** (one per desktop session, runs as the user): the Greenfield protocol implementation running in
  Node on top of the libwayland fork, plus the GStreamer encoder. Apps connect to it like any Wayland compositor.
- **Viewer** (`packages/viewer`): the browser side. Receives a window-scene protocol (windows, positions, sizes,
  frames) over one WebSocket, decodes frames (WebCodecs), composites with WebGL, does all window management and draws
  the shell.
- **Gateway** (`packages/gateway`): privilege-separated.
  - Root monitor + a small C PAM helper for authentication and starting sessions (with `pam_systemd`/logind).
  - Unprivileged web process (system user `greenfield`) serving the page and relaying connections to session processes
    over Unix sockets.
- **Transport**: a single WebSocket with a priority send queue (input/control before video), latest-wins frame
  coalescing, one frame in flight per window, and small kernel send buffers (`TCP_NOTSENT_LOWAT`). It sits behind a
  `ViewerTransport` interface so WebTransport can be added later if ever needed.

## Security and sign-in

- **TLS by default** (self-signed certificate generated if none is configured). Plain HTTP only through an explicit
  opt-in, intended for a home LAN.
- **The sign-in page leaks nothing beyond what SSH would**: a generic username/password form and the hostname. Unknown
  user and wrong password fail identically, with a minimum delay and rate limiting. No session or user information
  before authentication.
- Sign-in page, session list and desktop are a single page. The sign-in page is plain HTML, not Wayland.
- **Signing in is per page, like a lock screen.** The login token lives only in that page's memory (no cookies, no
  browser storage). The page keeps a connection to the gateway open, and the token is revoked when it closes (after a
  few seconds' grace for network hiccups). So another tab, a reload, or closing and reopening the browser all require
  signing in again. Desktop sessions keep running regardless.
- After sign-in: the user's own sessions, attach to one or start a new one.
- **Two-factor authentication through PAM** (planned): the sign-in page will support PAM's follow-up prompts (e.g.
  "Verification code:"), so any two-factor method configured in PAM works without project-specific code.

## Sessions

- Default name "Session N" (lowest free number). Rename by clicking the name itself, in the session list and in the
  Apps menu. Both use the same click-to-edit component, which shows it is editable on hover (outline, pencil icon).
- **Disconnect** returns to the session list; the session keeps running. **Log out** ends the session and returns to
  the sign-in page.
- Sessions do **not** survive a gateway restart (or a reboot). Decided not worth the complexity.
- Background services a desktop session needs (D-Bus session bus, xdg-desktop-portal, keyring) start automatically.
  No configuration needed.

## Back-navigation protection

A stray press of the browser's back button (e.g. a mouse side button) must not throw you out of your desktop:

1. Over the desktop, mouse back/forward buttons and Alt+Left/Right are captured and forwarded to the app (as
   `BTN_SIDE`/`BTN_EXTRA` and normal keys).
2. A guard history entry is added after sign-in and re-added on the next click or key press. Going back lands on the
   same page with no reload.
3. A "Leave site?" confirmation whenever signed in.

## Window management

- **Resizing**: the viewer stretches the window's last image to the new shape immediately while the app catches up.
  The opposite edges stay put when resizing from the left or top. (A wireframe/outline resize was tried in discussion
  and rejected.)
- Windows always stay partly on screen (at least 80 px visible) and their top edge can never go above the top of the
  desktop area. Enforced on browser resize, drag, reattach and app-requested placement.
- **No snapping.** Normal move and resize only.
- **Animations** (~300 ms, subtle curves). They only scale the existing image; minimize sends no resize events.
  - Minimize: ease-in, into the window's taskbar button.
  - Restore from minimized: fast start, ease-out, out of the taskbar button.
  - Maximize: ease-in.
  - Restore from maximized: fast start, ease-out.
  - For maximize and restore-from-maximized, the new size request is sent immediately and the animation runs
    concurrently, so the app has usually redrawn by the time it ends. A new frame arriving mid-animation is shown scaled
    to the animated shape.
- Apps draw their own decorations (client-side decorations). Browser-drawn decorations via `xdg-decoration` come later.

## Desktop shell

Drawn by the browser in HTML/CSS.

- **Design language**: loosely Windows 11. Simple, flat, modern. A style to borrow, not a feature checklist. Open fonts
  and icons only.
- **Themes**: all colors and sizes are CSS custom properties, so a theme is just a stylesheet. Light and dark built in;
  downloadable/user-written themes later.
- **No keyboard shortcuts** (at least at first) and no fullscreen or keyboard-lock modes. Everything must be reachable
  from the shell UI, and nothing should require understanding hidden modes.
- **Taskbar at the top** of the screen, always on top and always reachable. The Wayland output area excludes it, so
  maximized and fullscreen windows never cover it.
  - Left-aligned: Apps button, pinned apps (with a running indicator) and running windows grouped by app.
  - Hover previews of a group's windows, from the images the browser already has.
  - Icons from the app's `.desktop` file and the XDG icon theme, with a generic fallback.
  - Right side: connection indicator, notifications, clock. A mute toggle is added with audio.
  - Right-click menus (New window, Pin/Unpin, window actions) are a convenience only; everything in them is also
    reachable from the Apps menu or previews.
- **Apps menu** (not "Start"), top to bottom:
  1. Header row: user, session name (click to rename), session menu (Disconnect, Log out).
  2. Search.
  3. Pinned apps and all apps from the user's and the system's `.desktop` files.
- Apps come only from installed `.desktop` files (launched from their `Exec` line in the session's environment). The
  gateway's old `--applications` option was removed.
- Pinned apps are stored on the server, per user, in `$XDG_CONFIG_HOME/greenfield/pinned.json`.
- **Notifications** via `org.freedesktop.Notifications`, served by the session process on the session's D-Bus bus
  (it starts a bus if the user has none): pop-ups at the top right below the taskbar, plus a history list (last 50,
  kept across reconnects). Notification action buttons are not supported yet.

## Encoding policy

Each window is in one of two modes, chosen dynamically:

- **Fast mode (video)**: the whole window is encoded as H.264. Damage only decides whether a frame is sent at all
  (commits without damage are skipped); it can't select regions.
- **Slow mode (PNG patches)**: only the damaged areas are sent, as lossless PNG patches of at most ~64k pixels each
  (to tune); larger areas are split. The viewer applies patches as soon as they arrive.

Choosing the mode:

- Per window, a changed-pixels-per-second measure (damage area × rate) over a sliding period of at least 1–2 s, with
  hysteresis between the modes. The threshold is absolute, so small windows need no special rule.
- **The single largest damage within the period is ignored.** This keeps one-off full-window repaints (launch, an app
  switching to a different view) from pushing a window into video, and lets every quiet window make an occasional
  large update.
- **New windows start in fast mode.** Briefly fuzzy video for a quiet window beats briefly choppy patches for a busy
  one; the measure moves the window to slow mode from there.
- Interactive resizing is not special-cased (for now).

Switching modes:

- **Fast → slow**: queue a full-window PNG render (as patches) so a crisp image replaces the video.
- **Slow → fast while patches are still queued**: drop the unsent patches and switch to video immediately.

Merging damage in slow mode:

- A queued patch whose pixels haven't been read yet will pick up the latest content when it is encoded. So the parts
  of new damage that overlap a queued patch are removed (possibly the whole damage).
- Once a patch has started encoding, its pixels are fixed: new damage overlapping it is queued normally.
- In short: never queue a not-yet-captured area twice, never skip an area whose captured pixels may be stale.

Other rules:

- Use `wl_surface.damage`, skip empty damage, release app buffers as early as possible.
- A small fixed pool of warm video encoders (server) and decoders (browser) with a simple policy. If the pool is full,
  a window that would be in fast mode stays in slow mode.
- Hardware encoders when available, falling back to x264. The browser uses software decode for now (no hard decoder
  limits).
- Rejected: one tiled "atlas" video stream for all windows (too much trouble for the benefit).

## Audio (playback only)

- Per-session PipeWire with a virtual default output. Its monitor is encoded to Opus (general-purpose/music mode,
  stereo, ~96–128 kbps) and sent as highest-priority messages on the session WebSocket. Not WebRTC.
- Browser: WebCodecs `AudioDecoder` → `AudioWorklet` with a simple jitter buffer:
  - Fixed target (~60–80 ms).
  - Clock drift corrected by tiny rate changes (~0.1%, plain resampling, inaudible).
  - On underrun: short fade out, rebuffer, short fade in (no clicks).
  - Backlog over ~300 ms: drop the excess with a short crossfade.
- Mute only (no volume slider); mute tells the server to stop sending audio.
- Out of scope: microphone, A/V sync.

## Remaining work, in order

### Done

- Server-side compositor and window scene protocol with reattach, takeover and frame pacing.
- GPU (dmabuf) buffer sizes fixed (untested on real GPU hardware).
- Sign-in gateway with privilege separation, per-user sessions, per-page sign-in, session list with rename.
- Instant resizing, left/top anchoring, windows kept on screen.
- Back-navigation protection.
- Desktop shell: top taskbar, Apps menu, hover previews, pinned apps, notifications, window animations.

### Core

1. **Smart encoding + encoder/decoder pool** (see [Encoding policy](#encoding-policy)).
2. **Gaps that make it usable day to day**:
   - X11 apps: port XWayland support to the new architecture.
   - Clipboard between remote apps and the local machine; drag and drop.
   - Child dialogs move with their parent.
   - Input regions: send each surface's `wl_surface.set_input_region` rectangles in the scene protocol and hit-test
     against them in the viewer, so clicks on a window's shadow margin go to whatever is underneath. This is metadata
     only; it doesn't depend on pixels or alpha.
   - HiDPI rendering.
3. **Two-factor sign-in via PAM prompts.**

### First extra feature

4. **Audio playback** (see [Audio](#audio-playback-only)); add the taskbar mute toggle.

### Lower priority

5. Browser-drawn window decorations via `xdg-decoration` (GTK apps will still draw their own).
6. Hidden/minimized windows: the viewer tells the server to stop sending updates (and the app gets no frame callbacks /
   is marked suspended). On re-show, briefly show the last image scaled to the window until fresh frames arrive.
7. Hardware video decoding in the browser.
8. Downloadable/user-written CSS themes.
9. WebTransport, only if the single WebSocket ever becomes a bottleneck.
10. **Browser-drawn window shadows** (very low priority, nice-to-have). Follow the Windows 11 approach: only draw a
    shadow when the compositor knows the window's shape.
    - Opaque windows (the `wl_surface.set_opaque_region` covers the `xdg_surface.set_window_geometry` rectangle,
      allowing for corners): crop the app's own shadow off at the encoder (saves bandwidth), round the corners in the
      viewer's shader, and draw a themeable shadow around that same rounded rectangle. Add an invisible resize border
      to replace the app's resize strip, which lived in the cropped margin.
    - Everything else (odd shapes, translucency, no opaque region): no cropping and no shadow from us; show the app's
      pixels, including its own shadow, as sent.
    - Maximized windows: no shadow or rounding. Popups: a smaller shadow.
    - Verify which toolkits (GTK, Qt, Chromium) declare their opaque region reliably; ones that don't simply keep their
      own shadow.

11. **Viewer improvements.** Details to come from the user when this item is reached; ask before starting.

### Last

12. **Install script, uninstall script and systemd unit.** A `.deb` package possibly later. Until then, real-PAM setup
    is manual (see `packages/gateway` docs).
13. **Replace `@gfld/compositor-wasm` with native bindings.** pixman (region math) and libxkbcommon (keymaps) are
    compiled to WASM only because upstream's compositor ran in the browser. It now runs in Node, so native bindings
    would remove the emsdk download and cross-compile from the build. Not needed for anything; it just speeds up builds.

### Needs verification on other hardware

- Real PAM sign-in (needs root).
- GPU (dmabuf) buffers on a machine with a GPU.
- Firefox: whether a mouse back button over the desktop is fully blocked.

### Known issues

- Pinning two apps in quick succession once left only one pinned; not reproduced since.
