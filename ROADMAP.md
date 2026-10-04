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
  (The protocol implementation and libwayland fork are being replaced by wlroots, see Core item 1.)
- **Viewer** (`packages/viewer`): the browser side. Receives a window-scene protocol (windows, positions, sizes,
  frames) over one WebSocket, decodes frames (WebCodecs), composites with WebGL, does all window management and draws
  the shell. (Compositing moves to one DOM element per window, see Core item 3.)
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
- Apps draw their own decorations (client-side decorations). Browser-drawn decorations via `xdg-decoration` come later
  (Core item 4).
- **Input regions**: clicks outside a surface's input region (`wl_surface.set_input_region`, e.g. most of a client-side
  shadow) go to whatever is underneath; the pointer and cursor follow the same hit test.
- **Child windows** (dialogs, `xdg_toplevel.set_parent`) are separate windows in the scene with a parent. They are
  stacked directly above their parent (raising either raises both), move with it, are minimized, restored and animated
  with it, and have no taskbar button of their own (the parent's shows as active while a child is). The server centers
  a new dialog on its parent; the user can still move it. Closing a dialog gives the keyboard back to its parent.
- **HiDPI**: the viewer renders at `devicePixelRatio`; window content that maps onto whole device pixels is sampled
  without blurring. Positions and sizes in the scene protocol stay in CSS pixels. The scale is reported to the server,
  which doesn't tell apps yet (needs wlroots), so apps still draw at scale 1.

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
- Smart encoding: per-surface video/patch modes with encoder and decoder pools (hardware encoders and dmabuf
  readback untested).
- Input regions, child windows (dialogs) that move, stack and minimize with their parent, and viewer-side HiDPI (see
  [Window management](#window-management)). Detecting a pixel ratio change without a resize (moving the browser to
  another monitor) is unverified: headless Chrome's emulation doesn't fire the events real browsers do.
- wlroots prototype: **go**. wlroots 0.17.4 (submodule, built against Ubuntu 24.04's packages) runs foot and
  gtk4-demo in the existing viewer through the existing scene protocol, transport and encoders: typing, pointer and
  cursors, resize, maximize, popups, dialogs, patches and video, reattach. Findings and gotchas in
  `packages/compositor-proxy/native/wlr-core/README.md`.
- wlroots migration, wave 1: every session runs on wlroots, with the desktop shell (Apps menu, launching, pinned apps,
  notifications; app processes tracked from client credentials). Built by `yarn build` (submodule + meson; CI on
  Ubuntu 24.04); `scripts/test-gateway.sh` passes on it; unit tests for `WlrCompositor` (fake core) and `Apps`. The
  old stack stayed selectable with `GFLD_LEGACY_COMPOSITOR=1` until wave 2 C deleted it.
- wlroots migration, wave 2 B: X11 apps through XWayland. An X11 display per session (`DISPLAY` for launched apps,
  Xwayland started on the first X11 connection); X11 windows are desktop windows with their title, WM_CLASS app id and
  transient parent, told where the viewer puts them; their move, resize, maximize and minimize requests go through the
  same policy; override-redirect menus and tooltips show with their window; X11/Wayland clipboard sync is wlroots'
  (untested). `scripts/e2e/x11.sh` (xev, xfontsel) runs in `scripts/test-gateway.sh`; gtk4-demo under X11 checked by
  hand. Works on WSL (read-only `/tmp/.X11-unix`) and with several users. Details:
  `packages/compositor-proxy/native/wlr-core/README.md`.
- Sticky modifiers fixed (Ctrl stayed held in foot after a key-up the page never saw). The browser is the truth about
  modifiers: every key, pointer, button and axis message carries `getModifierState()` (scene protocol v6 `Modifiers`;
  AltGr reported alone, without the Ctrl+Alt Windows adds), and the native core makes its xkb state agree before the
  event: modifier keys the browser doesn't hold are released for real, modifiers it holds without a key we saw are set
  in the mask only, nothing is sent when they agree (Ctrl+A, Ctrl+B stays one Ctrl press). Caps Lock and Num Lock
  follow the browser the same way. Losing page focus (blur, hidden tab) or the viewer releases every held key.
  `scripts/e2e/desktop.sh` checks foot's protocol log for all four cases.

### Core

1. **Migrate the server-side compositor to wlroots 0.17.4.** wlroots implements the Wayland protocols; we supply only
   the policy, which is thin because window management happens in the browser.
   - wlroots is a git submodule pinned to the 0.17.4 tag, built with meson as a static library with only what we use
     (headless backend, pixman and GLES2 renderers, XWayland), and linked into the native addon. Its API changes
     between 0.x releases, so upgrades are deliberate, like today's libwayland fork.
   - 0.17.4 is the newest release whose dependencies (libwayland, wayland-protocols, libdrm, pixman, libxkbcommon,
     xcb) are all satisfied by Ubuntu 24.04's packages, so nothing else is built from source. 0.18 would need a newer
     libwayland, 0.19 also a newer pixman, 0.20 four newer libraries. Not having 0.18's explicit sync
     (`linux-drm-syncobj`, mostly for NVIDIA) is accepted; upgrade when the supported distros catch up.
   - A narrow C core (wlroots wiring) exposes high-level events and calls to TypeScript: window created, updated or
     gone; buffer committed with damage; inject input; configure and resize. The buffer-to-encoder path stays native.
   - Keeps: the viewer, the scene protocol, the gateway, the transport, the encoding policy (`SurfaceEncoder`, patches,
     region math, encoder pool) and the GStreamer encoder.
   - Removes: the libwayland fork, the TypeScript protocol implementation (`packages/compositor`),
     `@gfld/compositor-wasm` (system pixman and libxkbcommon instead), `@gfld/xtsb`, and the code generators and
     interceptors that only they use.
   - Included in this item, now that wlroots does the hard parts:
     - X11 apps through XWayland (`wlr_xwayland`, which includes the X window manager).
     - Clipboard between remote apps and the local machine (text first, images if cheap), primary selection, and
       clipboard sync between X11 and Wayland apps. Browsers only read the local clipboard after a click or key press,
       so pasting from the local machine happens on Ctrl+V.
     - Drag and drop between remote apps, then local files into remote apps.
     - HiDPI, server side: output scale and fractional scaling (`wp_fractional_scale_v1`).
   - **The server is the single source of truth for window state** (position, size, stacking, minimized, maximized).
     The viewer still moves and resizes windows optimistically during a drag, and reconciles with sequence numbers so a
     late echo of an old move can never pull a window back:
     - The viewer numbers its window changes per window; every move or resize it sends carries the next number.
     - Every window update from the server carries the last number it applied for that window.
     - While a window has unconfirmed changes (the server's number is behind the last one sent) or is being dragged,
       the viewer keeps its own position and size and ignores the server's for that window.
     - Once the server's number catches up, the server's state wins as-is, including its corrections (e.g. clamping
       a window back on screen).
     - Server-initiated changes (an app maximizing itself, a dialog following its parent, another viewer moving a
       window) need no special case: they apply as soon as the viewer has nothing unconfirmed for that window.
     - This replaces today's "keep the local position until the server reports the same coordinates", which gets stuck
       when the server corrects a position and ignores legitimate server moves meanwhile.
   - **Starting point: the prototype** (done, verdict go), the default since wave 1: `yarn build` builds it, every
     session runs on it, apps start from the Apps menu. `GFLD_WLR_TRACE=1` logs events. Layout:
     - `native/wlr-core/src/wlr_core.c` (~1.1k lines): the wlroots wiring as a Node addon. It reports surfaces,
       commits (buffer damage, input region), toplevels and their requests, and cursors to JavaScript, and takes
       input, configures and frame callbacks from it. `wlr_core_encoder.c` compiles the existing GStreamer encoder into
       the same addon against the system libwayland.
     - `src/wlroots/WlrCompositor.ts` (~0.7k lines): the policy, like today's `server/scene.ts`: placement, stacking,
       focus, minimize, maximize, child windows centred on their parent, frame pacing, one `SurfaceEncoder` per
       surface. Frame pacing moved to `src/FramePacing.ts`, free of native code.
     - `src/wlroots/Apps.ts`: the session's app processes (launched, or connected on their own, by client pid).
     - `packages/gateway/src/session-process.ts`: the session process.
     - Detailed notes: `packages/compositor-proxy/native/wlr-core/README.md`.
   - **Verified in the prototype** (headless Chrome through the gateway): foot (typing, focus, its own decorations,
     cursor shapes, resizing by its edge, its maximize button); gtk4-demo (its shadow and input region, its own
     cursor, menus as popups, the About dialog centred and stacked above its parent); small surfaces as patches and
     busy ones as video; reattach with identical pixels; no regressions on the default path. Clipboard between Wayland
     apps should already work (wlroots' data device and primary selection) but wasn't tested.
   - **Gotchas the prototype found** (all handled there; keep them in mind):
     - wlroots releases each committed buffer right after the commit event, so the core keeps its own reference until
       the next commit (video encodes hold it until encoded, like `whenIdle` today). Its per-surface "committed" flags
       accumulate across commits, so a new buffer is detected by `current.buffer` being set.
     - No renderer: `wlr_compositor_create(display, 5, NULL)` and `wlr_shm_create` with explicit formats, so wlroots
       doesn't copy shared-memory buffers into textures; the headless output is enabled without
       `wlr_output_init_render`. GPU buffers will need the GLES2 renderer.
     - Re-entrancy: events go to JavaScript synchronously and JavaScript calls back in. Flushing clients inside an event
       double-freed a client on app exit, so only the outermost call flushes.
     - Event loop: wlroots' `wl_event_loop` fd is polled by the existing poll addon. Configures are scheduled as idle
       sources, so every call from JavaScript ends with `wl_event_loop_dispatch_idle` + `wl_display_flush_clients`.
     - Frame callbacks: wlroots sends none itself; `wlr_surface_send_frame_done`, driven by our frame pacing.
     - One libwayland per process: the fork and the system libwayland share the `libwayland-server.so.0` name, which is
       why the prototype is a separate session process. The migration deletes the fork, so this goes away.
     - Build: wlroots 0.17 needs `werror=false` (assert-only variables with `b_ndebug`); its Wayland and X11 backends
       can't be disabled in 0.17, so the addon also links libwayland-client (harmless).
     - The encoder owns `frame_buffer.user_data` (its reference count); the held buffer travels alongside it.
     - Wave 1: the session process must not have its own display in `WAYLAND_DISPLAY`, or GStreamer's GL (the
       encoder) connects to it as a client. Apps get it when launched.
     - Wave 1 (done in 2 C): the addon compiled three files from the fork's directory (`native/wayland/src/westfield-egl.c`,
       `westfield-dmabuf.c`, `drm_format_set.c`, with their headers, used by the encoder): wave 2 C must move them (into
       `native/encoding/src` or `native/wlr-core/src`) before deleting `native/wayland`, and drop `legacy.ts`,
       `session-process-legacy.ts` and `GFLD_LEGACY_COMPOSITOR`.
     - Wave 1: the prototype left nothing focused when the active window closed; now a dialog's parent, else the
       topmost shown window, is activated. Wave 2 A (server-owned state) should keep this.
     - Wave 2 B: wlroots' X11 socket code fails on WSL (read-only `/tmp/.X11-unix`), breaks multi-user servers (it
       creates `/tmp/.X11-unix` 0755 as the first user) and can unlink a live X server's socket; our
       `xwayland_sockets.c` replaces it at link time (keep it in sync with wlroots' `xwayland/sockets.h` on upgrades).
     - Wave 2 B: X11 windows have absolute positions; `WlrCompositor` tells them where the scene shows them
       (`setPosition`, via `X11.ts`). Wave 2 A should keep calling it wherever the scene's positions are decided.
     - Wave 2 B: X11 apps without their own decorations (xev, xterm, xclock) can't be moved by the user until the
       window menu's Move (wave 3 D) or the viewer's own title bars (Core item 4). Most classic X11 apps (x11-apps)
       ship no `.desktop` file, so they aren't in the Apps menu (as on any desktop); a user's own `.desktop` file in
       `~/.local/share/applications` adds them.
   - **Work plan: four waves.** A wave's tasks are independent of each other (none needs another's result), so they run in parallel, each on its own branch and worktree; a wave
     starts once the previous one is merged and tested. At most about three branches at once: wave 2 and 3 tasks all
     add to `wlr_core.c` and `WlrCompositor.ts`, so more means painful merges (and each branch needs hands-on testing).
     Agents: Sonnet subagents by default; an Opus fork only for the tricky tasks (marked), as opposed to wiring
     straightforward code together. Lines are back of the envelope; the prototype's estimate was 2-3 weeks of
     human-paced work in total, likely a few days of wall-clock time with agents.

     | Wave | Task | Agent | Lines added |
     |---|---|---|---|
     | 1 | **Done.** **Make wlroots the default**: the session process on `WlrCompositor`; the desktop shell on it (Apps menu, launching, notifications; client PIDs from `wl_client_get_credentials`); CI and build docs get meson (the XWayland packages come with B); unit tests for `WlrCompositor` with the addon mocked; `scripts/test-gateway.sh` passes on it. Everything else builds on this. | Fork (tricky: session lifecycle, the prototype's gotchas) | ~1k |
     | 2 | **Done.** **A. Window-state sync**: the server owns window state; sequence-number reconciliation (above) in the viewer, the scene protocol and `WlrCompositor`. Scene protocol v5: `seq` on every `window.*` change but `window.close`, echoed per scene window (a change that changes nothing is still echoed). The viewer side is `packages/viewer/src/window-sync.ts` (unit tested); the e2e test drags a window with every scene held back 300 ms (`__viewerTest.delayScenes`) and checks it never jumps back. (The legacy fallback was dropped after C.) | Fork (tricky: ordering and races) | 300-500 |
     | 2 | **Done.** **B. XWayland**: `wlr_xwayland` with its window manager; X11 windows (including override-redirect menus and tooltips) become scene windows. | Fork (tricky: X11 quirks) | 400-700 (about 700 in C and TypeScript, plus tests) |
     | 2 | **C. Done.** **Delete the old stack**: the libwayland fork and its addons, `packages/compositor`, `@gfld/compositor-wasm`, `@gfld/xtsb`, `@gfld/common`, the compositor generators and protocol libs, `protocol/*.xml`, the proxy's interceptors, `legacy.ts`, `session-process-legacy.ts` and `GFLD_LEGACY_COMPOSITOR`; the encoder's EGL/dmabuf helpers moved into `native/wlr-core/src`. About 90k lines deleted. | Sonnet | ~0 |
     | 3 | **D. Polish**: fullscreen, popups kept on screen, key repeat, keyboard layout from the locale (Caps/Num Lock sync is done: it follows the browser's modifier state); cheap globals (viewporter, presentation time, xdg-activation, single-pixel buffer, idle inhibit, xdg-output). **Window menu with Move and Size** (Windows' window menu; how a window without a reachable title bar is moved, e.g. xclock): one shared menu, `windowMenuItems` in `packages/viewer/src/shell/menus.ts`: Restore/Minimize, Maximize/Restore down, Move, Size, Close window. Move: the four-way move cursor, the window follows the pointer, a click drops it, Escape puts it back, arrow keys nudge it. Size: the edge or corner nearest the pointer (or picked by the first arrow key) follows the pointer, a click finishes, Escape cancels. Both reuse the drag code and the window-state sync (no server changes). Taskbar preview cards show only the title and a close button (no minimize and maximize controls); right-clicking anywhere on a card opens the window menu, as does the taskbar button of a single-window group (as today); our own title bars (Core item 4) open the same menu. No Alt+drag: undiscoverable, and host desktops (KDE, Xfce) and apps (GIMP, Inkscape, Blender) use Alt+click. | Sonnet | 600-900 |
     | 3 | **E. Clipboard with the browser, then drag and drop** (in that order, one agent: drag and drop reuses the clipboard's data plumbing). Clipboard: a server-side data source for text from the browser (on Ctrl+V), the selection read through a pipe and sent to the viewer, primary selection the same way; X11/Wayland sync comes with `wlr_xwayland`. Drag and drop: between remote apps via wlroots' seat drags with the drag icon shown by the viewer, then local files into remote apps (uploaded, offered as `text/uri-list`). | Sonnet | 1.1-1.6k |
     | 3 | **F. HiDPI, server side**: output scale and `wp_fractional_scale_v1` from the viewer's reported scale. | Sonnet | 100-200 |
     | 3 | **H. Input and X11 gaps**: browser shortcuts reach the app (Ctrl+W/T/N, Alt+Tab, ...) through the browser's Keyboard Lock API in fullscreen, with a hint on how to enter it; pointer lock and relative motion (`pointer-constraints-v1`, `relative-pointer-v1`) from the browser's Pointer Lock API, for games and 3D apps; taskbar icons for X11 windows from `_NET_WM_ICON` when there's no `.desktop` icon; X11 apps started from a terminal in the session are closed at logout like Wayland ones (wave 2 B gap); touch and pen input from pointer events if cheap (otherwise its own item); check that the viewer sends high-resolution scrolling (`axis_value120`). | Sonnet | 400-700 |
     | 3 | **Done.** **I. Cheaper H.264 encoding** (knobs: the `X264_*` defines at the top of `gst_frame_encoder.c`; notes in the wlr-core README; not benchmarked, the user tunes) (`native/encoding/src/gst_frame_encoder.c`; video is only used for busy surfaces, so it should be cheap to encode and low in bitrate, not high quality). x264: `speed-preset=superfast` with `tune=zerolatency`, dropping the upstream overrides that make it expensive (`me=2` UMH search, `analyse=51`, `dct8x8`, `cabac`, `psy-tune=2`; no speed preset meant `medium`); quality-based rate control under a bitrate cap instead of 12 Mbps CBR (1.2 Mbps for alpha). Pad coded sizes to 16 instead of 128 (128 saved new streams on small resizes, which matters little since most updates are PNG patches); check the browser's decoder accepts it. Two paths: shared-memory buffers to x264 go through a CPU pipeline (`appsrc ! videoconvert ! (padding) ! x264enc`; the alpha stream built by our C code writing the alpha bytes as a gray frame, no GL), the GL pipeline (upload, shader, convert, download) stays for GPU (dmabuf) buffers and hardware encoders (nvh264, VA-API), where it's the cheap path. The agent doesn't benchmark: the user measures and tunes the preset (up or down from superfast) and rate control by hand. | Sonnet | 200-400 |
     | 4 | **G. GPU buffers**: linux-dmabuf with the GLES2 renderer, dmabuf readback for patches and import for video, ported from `native/encoding/src/pixels.c`. Depends on I (both change the encoder's GL path, which I restructures). Can't be verified on the development machine (WSL has no `/dev/dri` render node, so apps can't allocate GPU buffers); it's only tested on real hardware. | Sonnet | 200-400 |

     Wave 1 alone gives today's features on wlroots. In total about 3.5-5.5k lines added and 60k+ deleted (much of
     the deleted code is generated or vendored).
   - **Packages**: the build needs `meson` (and ninja). XWayland needs `xwayland` (also at run time), `libxcb1-dev`,
     `libxcb-composite0-dev`, `libxcb-ewmh-dev`, `libxcb-icccm4-dev`, `libxcb-render0-dev`, `libxcb-res0-dev`,
     `libxcb-xfixes0-dev` (in CI and the build docs since wave 2 B); its end-to-end test needs x11-utils.
     `libxcb-errors-dev` (nicer X11 error messages, optional) isn't packaged for Ubuntu 24.04. Clones need
     `git submodule update --init`.
   - Must still pass `scripts/test-gateway.sh` and the unit tests; GPU (dmabuf) buffers stay untested without
     hardware.
2. **Two-factor sign-in via PAM prompts.**
3. **Viewer: one DOM element per window instead of one WebGL canvas.** Each window becomes a positioned element with
   its own canvas, stacked in DOM order, so the browser does stacking, clipping, hit-testing, occlusion and window
   moves/animations (CSS transforms), and window decorations and shadows can be HTML/CSS that stacks with its window.
   - Patches: `drawImage` of the decoded PNG into the window's 2D canvas. Opaque video: `drawImage(VideoFrame)`, which
     stays on the GPU (no copy through JavaScript memory).
   - Video with alpha: one shared offscreen WebGL context combines the color and alpha streams and hands each frame to
     the window's canvas (`transferToImageBitmap`), which avoids the per-page WebGL context limit.
   - Live resize stretching becomes a CSS scale of the window's canvas.
   - The end-to-end test's pixel checks need a new way to read window content.
   - Do this before browser-drawn decorations and shadows, which depend on it.
4. **Browser-drawn window decorations (our own title bars)**, right after Core item 3 (moved up from lower priority:
   classic X11 apps such as xclock and xterm draw no title bar, as X11 window managers draw them, so today they can't
   be moved except with the window menu's Move; Qt/KDE apps prefer them too). With one DOM element per window, a frame is HTML/CSS
   around the window's canvas: title, minimize, maximize and close buttons, move by dragging the title bar, resize
   from the frame's edges; right-clicking the title bar opens the shared window menu (wave 3 D: the taskbar's). Offered through `xdg-decoration` (wlroots provides it) to Wayland apps that ask for
   server-side decorations, and drawn for X11 windows the app doesn't decorate itself (`_MOTIF_WM_HINTS`); GTK apps
   keep drawing their own. The window geometry the server reports grows by the frame, and the frame follows the
   window's activated, maximized and minimized state.

### First extra feature

5. **Audio playback** (see [Audio](#audio-playback-only)); add the taskbar mute toggle.

### Lower priority

6. **Don't send what can't be seen: minimized, fully covered and partially covered windows**, all with one algorithm,
   computed on the server. It already has every window's position, stacking order, minimized state and opaque region
   (`wl_surface.set_opaque_region`; a translucent window on top doesn't hide what's below it).
   - Each surface's visible region is its rectangle minus the opaque windows above it (minimized: nothing visible).
   - Damage in the visible region is sent as usual. Damage in the hidden region accumulates instead, merged as it comes
     in (like queued patches), so 100 updates to the same area stay one region, not 100.
   - When part of a surface becomes visible again, the accumulated damage inside it is sent.
   - Video mode encodes whole surfaces, so there partial cover saves nothing; a fully hidden surface stops its video
     and resumes with a key frame.
   - Fully hidden surfaces get throttled frame callbacks, so the app idles.
   - Taskbar hover previews may show a slightly stale image of a hidden window (accepted).
   - The viewer's own state can briefly run ahead of the server's (a drag, an animation); at worst a region updates a
     few milliseconds late.
7. **Text input methods (IME)** for Chinese, Japanese, Korean and other composed input, and dead keys and compose:
   the browser's composition events (on a hidden input element) mapped to `text-input-v3` (wlroots provides it), so
   the app shows the pre-edit text and receives the committed text.
8. Hardware video decoding in the browser.
9. Downloadable/user-written CSS themes.
10. WebTransport, only if the single WebSocket ever becomes a bottleneck.
11. **Browser-drawn window shadows** (very low priority, nice-to-have). Only draw a shadow when we know the window is a
    plain opaque rectangle: its `wl_surface.set_opaque_region` covers the whole surface. Such an app draws no shadow
    margin and no transparent corners of its own, so there is nothing to crop or replace.
    - Qualifying windows get a themeable shadow from us: a CSS `box-shadow` on the window's element (see Core item 3).
      This doesn't depend on who draws the chrome: with our chrome (`xdg-decoration`), the shadow goes around chrome
      and content together.
    - Qualifying windows that draw their own chrome get their corners slightly rounded with CSS, clipping a few corner
      pixels of the app's content. With our chrome, the rounding is part of our chrome's styling.
    - Everything else (an opaque region smaller than the surface, translucency, no opaque region): no shadow and no
      clipping from us; show the app's pixels as sent, including its own shadow and corners. GTK/libadwaita apps with
      client-side decorations fall here and keep their toolkit's shadow (extra bandwidth for the shadow margin,
      accepted).
    - Maximized windows: no shadow or rounding. Popups: a smaller shadow.
    - Verify which toolkits (GTK, Qt, Chromium) declare their opaque region reliably; ones that don't simply never
      get our shadow.

12. **Viewer improvements.** Details to come from the user when this item is reached; ask before starting.

### Last

13. **Install script, uninstall script and systemd unit.** A `.deb` package possibly later. Until then, real-PAM setup
    is manual (see `packages/gateway` docs).

### Needs verification on other hardware

- Real PAM sign-in (needs root).
- GPU (dmabuf) buffers on a machine with a GPU.
- Firefox: whether a mouse back button over the desktop is fully blocked.

### Known issues

- Pinning two apps in quick succession once left only one pinned; not reproduced since.
