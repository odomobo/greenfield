# Architecture

How the system works: design decisions, protocols, encoding, transport, audio.
For the task list see [ROADMAP.md](ROADMAP.md). For completed work see [HISTORY.md](HISTORY.md).

## Vision

- Open the server's URL in a browser → a sign-in page → your desktop (attached, or started if it isn't running) → a
  full Linux desktop of the server's apps, in the browser.
- **Session state lives on the server; compositing happens in the browser.** The server is the authoritative Wayland
  compositor. The browser draws each window from its own image stream and acts as window manager and desktop shell.
- Rule of thumb: the browser does anything that doesn't depend on server state and makes sense to do there
  (hit-testing, window placement, animations, the shell UI).
- Sessions survive closing the browser. Sign in again and you're back where you left off.
- Goal: snappy regardless of latency. An effective remote desktop, not bells and whistles.
- Started from Greenfield's codebase; the original protocol implementation, libwayland fork, WebGL renderer, WASM
  apps and proxy CLI have all been replaced or removed.

## Architecture

- **Login helpers and web front** (`packages/gatekeeper`, Rust): privilege-separated sign-in. The production helper
  (`nebula-login`, root) does PAM; the dev helper (`nebula-dev-login`) runs as the current user. The web front
  (`nebula-web`) is a listener that forks a sandboxed worker per TCP connection for TLS, HTTP and WebSocket. See
  `packages/gatekeeper/README.md` and `packages/session/README.md` for the full process tree.
- **Session** (`packages/session`, one per desktop, runs as the user): the server side of a user's desktop. A Wayland
  compositor on wlroots (with XWayland), as a Node process with C addons. Encodes frames (QOI/LZ4 patches, PNG, and
  lossy via GStreamer when bandwidth is short), runs the shell service (desktop entries, icons, notifications, system tray) and
  audio, and sends everything over the session's WebSocket.
- **Viewer** (`packages/viewer`): the browser side. Receives a window-scene protocol (windows, positions, sizes,
  frames) over one WebSocket, decodes frames (WebCodecs plus QOI/LZ4 patches in a worker), shows each window as its
  own DOM element with a canvas per surface (the browser composites), does all window management and draws the shell.
- **Transport**: a single WebSocket with a priority send queue (input/control before video), latest-wins frame
  coalescing, one frame in flight per window, and small kernel send buffers (`TCP_NOTSENT_LOWAT`), with a BBRv3-style
  congestion controller. It sits behind a `ViewerTransport` interface (`packages/transport`) so WebTransport can be added later if ever
  needed. See [Encoding policy](#encoding-policy) and [Transport and congestion control](#transport-and-congestion-control).

## Security and sign-in

- **TLS by default** (self-signed certificate generated if none is configured). Plain HTTP only through an explicit
  opt-in, intended for a home LAN.
- **The sign-in page leaks nothing beyond what SSH would**: a generic username/password form and the hostname. Unknown
  user and wrong password fail identically, with a minimum delay and rate limiting. No session or user information
  before authentication.
- Sign-in page, session list and desktop are a single page. The sign-in page is plain HTML, not Wayland.
- **Signing in is per page, like a lock screen.** The login token lives only in that page's memory (no cookies, no
  browser storage). The page keeps a connection to the gatekeeper open, and the token is revoked when it closes (after a
  few seconds' grace for network hiccups). So another tab, a reload, or closing and reopening the browser all require
  signing in again. Desktop sessions keep running regardless.
- After sign-in: the user's own sessions, attach to one or start a new one.
- **Two-factor authentication through PAM** (planned, lowest priority: only once the core is verified sound and free of
  vulnerabilities): the sign-in page will support PAM's follow-up prompts (e.g.
  "Verification code:"), so any two-factor method configured in PAM works without project-specific code.

## Sessions

- One desktop per user, without a name. Signing in attaches to it, starting it if it isn't running. A second sign-in
  takes it over (the first page is told).
- **Disconnect** signs out and returns to the sign-in page; the desktop keeps running. **Log out** ends the desktop and
  returns to the sign-in page.
- Sessions do **not** survive a server restart (or a reboot). Decided not worth the complexity.
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
- **Decorations**: the viewer draws a frame (title bar, thin border, invisible resize margin) around windows the server
  marks `decorated`: Wayland apps with an `xdg-decoration` object that don't ask for client side mode, X11 windows
  that don't say they have no title bar (`_MOTIF_WM_HINTS`). Other apps (GTK, Chrome) draw their own, popups are never
  framed (Core item 4). A decorated window's own surfaces are clipped to its window geometry, so the app can't cover
  the frame or take its clicks.
- **Popups** (xdg popups, X11 override-redirect menus and tooltips; scene protocol 13 marks them) are shown in a layer
  above all windows, in the windows' order: a menu or tooltip of a window that isn't on top isn't covered by the ones
  that are. They move, stretch, fade and hide with their window and aren't clipped to it.
- **X11 apps that move themselves** (XMoveWindow, e.g. a borderless window dragging itself, or an app placing itself)
  are moved as they ask, as under other X11 window managers. While the user drags or resizes such a window the pointer
  decides, and the release is the last word (`scripts/e2e/x11-move.sh`).
- **Surface ids** are "client/number", the number counting up for the whole session: never reused, unlike an app's
  protocol ids, which apps hand out again (Knights' dialogs got the id of the drag icon of the last piece moved, and
  with it that icon's canvas, still placed at the pointer). The viewer keeps a surface's content (decoder, canvas)
  until a scene lists the surface as `destroyed` (scene protocol 22), whether or not a window shows it; a data item of
  it still on its way is ignored. The server takes back nothing it already queued for the viewer: those items still go
  out and the viewer ignores them (the scene that destroys the surface is a control message, so it arrives first).
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

Drawn by the browser in HTML/CSS. The visual design (theme, window frames, animations) is in [DESIGN.md](DESIGN.md).

- **Design language**: loosely Windows 11. Simple, flat, modern. A style to borrow, not a feature checklist. Open fonts
  and icons only.
- **Themes**: all colors and sizes are CSS custom properties, so a theme is just a stylesheet. Dark only for now
  (glass surfaces on a background picture); downloadable/user-written themes later.
- **No keyboard shortcuts** (at least at first) and no fullscreen or keyboard-lock modes. Everything must be reachable
  from the shell UI, and nothing should require understanding hidden modes.
  - Shortcuts the browser or the OS grabs (Ctrl+W, Ctrl+T, Ctrl+N, Alt+Tab, ...) don't reach apps, and we live with
    that: the viewer doesn't behave differently in browser fullscreen (no Keyboard Lock API). A workaround may come
    later, but only as something explicit at the window manager level that users can readily understand, never an
    implicit mode or state. Not planned now.
- **Taskbar at the top** of the screen, always on top and always reachable. The Wayland output area excludes it, so
  maximized and fullscreen windows never cover it.
  - Left-aligned: Apps button, pinned apps (with a running indicator) and running windows grouped by app.
  - Hover previews of a group's windows, from the images the browser already has.
  - Icons from the app's `.desktop` file and the XDG icon theme, with a generic fallback.
  - Right side: system tray icons (see below), audio mute toggle, notifications, clock.
  - Right-click menus (New window, Pin/Unpin, window actions) are a convenience only; everything in them is also
    reachable from the Apps menu or previews.
- **Apps menu** (not "Start"), top to bottom:
  1. Header row: user, session menu (Disconnect, Log out).
  2. Search.
  3. Pinned apps and all apps from the user's and the system's `.desktop` files.
- Apps come only from installed `.desktop` files (launched from their `Exec` line in the session's environment). The
  session's old `--applications` option was removed.
- Pinned apps are stored on the server, per user, in `$XDG_CONFIG_HOME/greenfield/pinned.json`.
- **Notifications** via `org.freedesktop.Notifications`, served by the session process on the session's D-Bus bus
  (it starts a bus if the user has none): pop-ups at the top right below the taskbar, plus a history list (last 50,
  kept across reconnects). Notification action buttons are not supported yet.
- **System tray**: apps' tray icons (StatusNotifierItem) in the taskbar's tray area, their menus (dbusmenu) shown as
  our own menus. The session process is the `org.kde.StatusNotifierWatcher` when no one else is, else it follows the
  other watcher as a host; only items of this desktop's processes are shown (a bus shared with the user's other
  desktops has theirs too). XEmbed tray icons (old X11 apps) are not supported.

## Encoding policy

(Decided 2026-10-04, replacing the earlier fast/slow mode policy, which chose video by changed pixels per second.
Core item 2a implements this section; 2b implements the next one.)

### Background: how Wayland clients render

Wayland has no rendering modes. Every client does the same thing: attach a buffer, damage the rectangles that
changed, optionally ask for a frame callback (`wl_surface.frame`: "tell me when to draw the next frame"), commit. The
compositor's only lever is when it sends frame callbacks. Clients differ only in how they use this:

- Event-driven apps (terminals, editors, most toolkit apps most of the time) draw when input or content changes, with
  small accurate damage, and ask for a callback only while they have something to draw.
- Animating apps (scrolling, transitions, a browser playing video) ask for a callback every frame, for a while.
- Games with vsync (EGL swap interval 1, Vulkan FIFO) loop forever; `eglSwapBuffers` blocks until the previous
  frame's callback arrives, so **we set their frame rate**. Their damage is the whole surface.
- Games without vsync (swap interval 0, Vulkan MAILBOX/IMMEDIATE) commit as fast as they render and ignore
  callbacks; the compositor just uses the newest buffer.
- Video players commit at the video's rate.

Optional hints exist (`wp_content_type_v1`: none/photo/video/game; `wp_tearing_control_v1`), but most apps don't
send them, so we go by behavior.

### Two separate questions: priority and encoding

A surface has a **priority class** and an **encoding**, decided separately:

- **Class**: *normal* (medium priority) or *streaming* (low priority). Control messages (scene, input, cursor, shell,
  clipboard, audio later) are above both and always go first.
- **Encoding**: *patches* (lossless: raw / QOI / QOI + LZ4; or JPEG for streaming surfaces while bandwidth is short,
  below), or *video* (H.264 of the whole surface). Video is only possible with GPU acceleration
  (below) and only used for streaming surfaces.

A surface's class and encoding are per surface (a window's subsurfaces and popups each have their own). The viewer
doesn't need to know a surface's class; nothing about it is in the scene protocol.

The class, and whether a surface goes lossy, are **traffic policy**'s (`packages/traffic-policy`, see "Traffic policy"
in `docs/MODULARIZATION.md`), along two separate axes: *priority* (relentless or not: the class, burst promotion,
settling's tier; `priority.ts`, `TrafficPolicy.ts`) and *bottleneck* (CPU-bound until the link becomes the limit;
link-bound means going lossy: the link judgment, `bandwidth.ts`, `link-judgment.ts`). It publishes a decision per
surface (`TrafficDecision` in `@nebula/session-contracts`: its class and send tier, its bottleneck, its video
quality); the surface (`Surface`, `packages/session/src/surface`) reads it and reports what policy measures it by
(busy, commits, predicted backlog, settled). The encoding is the surface's own choice, from the class: it owns a patch
renderer (`PatchRenderer`, `src/patch-renderer`: damage queue, patch planning and order, lossy and settle areas) and,
while it streams video, a video renderer (`VideoRenderer`, `src/video-renderer`: the encoder's lease, on-demand
frames, key frames, quality), and switches between them (video start drops the queued patches and makes the whole
surface lossy; video stop sends a crisp lossless image of the whole surface). The renderers don't know each other;
their interfaces with the surface and the session (`RendererOwner`, `PatchRendererContext`, `SurfaceContext`, ...) are
in `@nebula/session-contracts`. The session-wide side (the sink, the encoder pool, the patch pump, traffic policy, the
tick) is `EncodingContext` (`src/encoding/EncodingContext.ts`).

### GPU acceleration and encoders

- **Without GPU acceleration on the server (the norm: mostly VPSes), everything is sent as lossless patches**, streaming
  surfaces included, best effort. No H.264 at all, not even x264.
- With GPU acceleration, streaming surfaces (that aren't small, below) are sent as video by a hardware encoder
  (`nvh264`, `vaapih264`). There is no x264 fallback.
- The session option `--encoder <auto|none|nvh264|vaapih264>` (default `auto`, replacing today's default `x264`;
  `x264` is no longer accepted). `auto`: at session start, use `vaapih264` if a render node (`/dev/dri/renderD*`)
  can be opened and GStreamer has the `vaapih264enc` element, else `nvh264` if it has `nvh264enc` and an NVIDIA
  device is present, else `none`. The session logs the choice. An explicit encoder that then fails to create (no
  device, missing element) is logged once and the session continues as `none`.
- `none` means no video encoder is ever created: the encoder pool has size 0 and the GStreamer video pipelines are
  never built. **There is no video on the CPU** (decided 2026-10-05, done in item 5b phase 2): the x264 encoder and
  the CPU alpha path (alpha bytes written as I420 luma for x264) are gone from the GStreamer encoder
  (`packages/video-codec/native/src/gst_frame_encoder.c`); video exists only with a GPU, and every buffer takes the GL
  pipelines there. (A dev-only software x264 path, `--dev-software-encoder`, exists for testing the video path without
  a GPU.)
- The video codec is its own package (`@nebula/video-codec`: the encoder in its own addon, the pool of encoder
  instances `EncoderPool`, encoder detection `detect.ts`). It encodes **frames** (`@nebula/frames`): capture hands out a
  frame of a surface's buffer, the codec reads it and releases it from GStreamer's thread once done (the frame library
  takes the release back to capture's thread, where the wlroots buffer is unlocked). Capture knows nothing about video.
- **GPU context**: the codec opens its own GPU context (EGL) on the device a frame's buffer lives on (the frame's
  `device`, a DRM `dev_t`), one per device, instead of sharing the compositor's EGL handle. Shared-memory frames need
  none (the GL elements make their own context). Capture doesn't receive dmabufs yet (no linux-dmabuf global, no
  renderer), so frames carry device 0; once it does, it sets the render node it advertises.
- A buffer whose pixels can't be read (`readPixels` fails; today only an unsupported SHM format, as there are no GPU
  buffers without the GLES2 renderer) is sent as video if an encoder exists, regardless of class. With `none` it
  can't be shown: log once per surface and send nothing for it.
- **Small surfaces** (at most `MAX_PATCH_PIXELS`, 64k pixels) are always patches, whatever their class: one patch of
  the whole surface is cheap, and the video encoder would pad it anyway.

### Classes: when a surface is "relentless"

Every surface starts **normal**, new windows included (starting low would make every new window load slowly behind
any running game).

A surface is promoted to **streaming** when it is *relentless*: it keeps asking for new data while it is still busy
sending the old. Defined precisely, on **discrete periods** (fixed, back to back, per surface, `CLASS_PERIOD_MS` =
750 ms; a surface is only judged on whole periods):

- A surface has **unsent work**, and is **busy**, while any of these exist: queued (not yet captured) patch rectangles,
  its items (captured, being encoded, or encoded and waiting in the transport; see below), or a video frame being
  encoded or waiting in the transport. "Sent" means handed to the socket by the scheduler.
- During a period the time the surface was busy and the time it was backlogged are added up. At the end of the period
  the two fractions (of the period) are kept as the *previous period's* and the counters start again.
- A commit with non-empty damage makes the surface **backlogged** if the previous completed period's busy fraction was
  at least `PROMOTE_FRACTION` = 0.60 (no separate busy threshold). It stays backlogged until it is no longer busy.
  Backlogged implies busy. Commits while already backlogged change nothing.
- **Promote** to streaming at the end of a period whose backlogged fraction is at least `PROMOTE_FRACTION` = 0.60.
- **Demote** to normal at the end of a period whose backlogged fraction is below `DEMOTE_FRACTION` = 0.15 (one
  period, no hold timer).
- Nothing happens before a surface has completed two periods (a commit needs a completed previous period to count as
  backlogged at all).
- Periods are closed on every commit and on a 200 ms tick (`EncodingContext.startTicking`), so a surface that goes
  quiet is demoted without committing. The measure is `RelentlessMeter` (`packages/traffic-policy/src/priority.ts`).

Why this works:

- A callback-paced client (frame callbacks are held until its stream is ready, see Frame callbacks) never commits while
  its previous frame is unsent, so "commit while there is unsent work" can't see it. Busy time can: a client that is
  busy most of a period is the one the link or CPU can't keep up with, and its commits in the next period are
  backlogged. Measured: a 1920x1080 busy client was busy 86-94% of each period and promoted at the end of its second
  period (about 1.5 s after it started); a 640x480 one was busy 40-45% on loopback and stayed normal.
- A one-off big repaint (launch, a view switch) is a single damage after a quiet period, so it is never backlogged,
  however long it takes to drain.
- A needy surface that is busy less than 60% of the time stays normal: it isn't causing contention, and if the link and
  CPU keep up, nothing waits and priorities don't matter.
- A relentless surface is promoted 1.5 to 2.25 s after it starts, and a quiet one is demoted within 0.75 to 1.5 s.
- It replaces the old rules "ignore the single largest damage" and "new windows start in video".

(Decided 2026-10-04: the first version of this rule, backlogged = a commit arriving while unsent work exists over a
sliding 1.5 s window, never promoted a callback-paced client, because the held callbacks make it drain before it commits.)

Changing class:

- Normal → streaming with video: drop the surface's queued (not yet captured) patches, start its video with a key
  frame. Patches already handed to the transport still go out first; the key frame paints over them.
- Streaming with video → normal: release the encoder and queue a full-surface patch render so a crisp lossless image
  replaces the video (as the switch to slow mode does today).
- Without video, a class change changes only the priority. Nothing is dropped or re-sent.
- If the encoder pool is empty, a promoted surface stays on patches (still streaming class).

### Lossless patches and damage

- Only the damaged areas are sent, as lossless patches of at most `MAX_PATCH_PIXELS` = 64k pixels; larger areas
  are split (`planPatches`). A commit's damage in more than `MAX_PATCH_RECTS` = 32 pieces is sent as its bounding box.
  Each patch is encoded with the QOI cascade (raw / QOI / QOI + LZ4, next section; native `nebula-patch-addon`, on
  worker threads, `patch-encoder.ts`; all in `packages/patch-codec`), and decoded in the viewer by a wasm decoder in a Web Worker. (It was PNG until
  item 5b phase 1.)
- The viewer applies patches as soon as they arrive. A streaming surface's frame can therefore tear across patches;
  accepted, as holding patches back until a whole frame is there would add latency.
- **Newest content wins** (already how it works): a surface's queue holds rectangles, not pixels, oldest first. New
  damage overlapping a queued rectangle is removed (the queued rectangle keeps its place and reads the latest pixels
  when captured). Pixels are read only when a patch is captured; from then on they're fixed and new damage over them
  is queued normally. Never queue a not-yet-captured area twice, never skip an area whose captured pixels may be stale.
  A surface's patches are sent in capture order (a newer patch may overlap an older one).
- Use `wl_surface.damage`, skip empty damage, release app buffers as early as possible.
- Patch sizes measured 2026-10-04 (our encoder, full 256×256 patches): ordinary UI about 10–30 KB (typically ~15 KB),
  photo- or game-like content about 40–150 KB, noise ~256 KB. Most patches are far smaller (a keystroke, a cursor
  blink: under 2 KB).

### QOI patches, and lossy encoding only when bandwidth is short

(Decided 2026-10-05; the lossless cascade is built (item 5b phase 1), the lossy half too (item 5b phase 2, as built:
see the end of this section). Why: PNG encoding hogs the CPU even on a Ryzen 7600, and a
small VPS has far less. The QOI spike measured our PNG at 75–145 ms of CPU per 1080p frame, QOI + LZ4 at 3.5–4.8 ms on
UI content and about 26 ms on noise.)

**Lossless patches: the QOI cascade.** Every lossless patch, of any surface (windows, popups, cursors, drag icons: all
surfaces go the same way, no special cases), is encoded like this:

1. QOI (3 channels if the patch is opaque, else 4). If the result is at least 90% of the raw size, it's noise: send
   the **raw** pixels if QOI came out bigger than raw, else the QOI as is, and don't try LZ4.
2. Else LZ4 over the QOI. If that's smaller than the QOI, send **QOI + LZ4**, else the plain **QOI**.

Each patch carries a one-byte **format tag** that the viewer switches on to decode it: raw, QOI, or QOI + LZ4 now, and
JPEG and JPEG with alpha later (below). Width, height and channels are in the patch header.
No PNG fallback for patches. Raw is RGB for opaque patches and RGBA otherwise. LZ4 finds exact repeats (4 bytes or
more, within 64 KB): it helps a lot on text and UI (repeated glyphs, widgets) and little on video, photos and noise.

Opaque: a patch is opaque if the buffer format has no alpha (XRGB/XBGR), or it lies entirely in the surface's opaque
region (`wl_surface.set_opaque_region`, `wlr_surface.opaque_region`: the client promises alpha is 1 there, so we
can drop it), else if a scan of the alpha bytes finds them all 255. The scan is folded into the pixel copy in
`readPixels`, which already knows the format.

**Which encoding, by class and bandwidth:**

- **Normal class (medium priority): always lossless QOI patches**, GPU or not, bandwidth-limited or not. Normal is never
  treated as the bottleneck: a surface that keeps the link or CPU busy becomes relentless and goes to streaming.
- **Streaming class (low priority)**, depending on whether we're **bandwidth-limited**, judged by our BBRv3-style
  controller (its bandwidth estimate and app-limited state; for example, the streaming surfaces' lossless output would
  exceed most of the estimated bandwidth):
  - Not limited, without GPU: QOI patches (lossless).
  - Not limited, with GPU: real-time video at a higher quality.
  - Limited, without GPU: **JPEG patches at medium quality** (4:4:4, so coloured text stays readable; libjpeg-turbo;
    the browser decodes them natively). JPEG has no alpha, so alpha is sent **the way video sends it**. Two format
    tags: **JPEG** (an opaque patch: one colour JPEG) and **JPEG with alpha** (two JPEGs, the colour image and its
    alpha plane as a grayscale (one-channel) JPEG, with their lengths, like a video frame's colour and alpha streams).
    For JPEG with alpha the viewer decodes both with `createImageBitmap` and composites them with the video's shader (`alpha-video.ts`: `rgb × alpha, alpha`,
    premultiplied; an `ImageBitmap` is a WebGL texture like a `VideoFrame`), which becomes the shared compositor for
    colour + gray alpha. Lossy alpha (slight fringes at anti-aliased edges) is accepted, as for video; the lossless
    refresh clears it. **Alpha of 254 or more counts as fully opaque**, so JPEG's rounding doesn't make opaque areas
    slightly transparent (in the shared shader, so video gets it too).
  - Limited, with GPU: real-time video at a lower quality, still enough to read text.
  - Video always has a **fixed quality target and variable bitrate**, no bitrate cap. Under contention the frame rate
    drops instead: that is what stream readiness is for (a frame is only taken when the surface's stream is ready, see
    "Stream readiness"), and it is believed to work. If it doesn't, rework it; don't add bitrate caps.
- **Refreshes are intelligent.** Track per surface which areas are lossy (JPEG or video) and which are known lossless.
  Whenever a surface leaves a lossy mode (bandwidth recovers, or it returns to the normal class), refresh only the
  areas known to be lossy, losslessly, and only after its pending damage has been sent. Flapping between lossless and
  lossy is then harmless (refreshes stay bounded by the lossy area); hysteresis is optional tuning.

**As built** (item 5b phase 2, scene protocol 18):

- **Bandwidth-limited** is judged by traffic policy from the transport's link stats (data held back, unsent bytes, the
  congestion controller's estimate): `packages/traffic-policy/src/bandwidth.ts`, `BandwidthMonitor`, one per
  connection, wired up by `link-judgment.ts`; `ViewerHost` connects each viewer's transport and congestion estimate to
  it (`LinkPolicy`).
  Since phase 3 it is either/or: the link is saturated (1 s periods; 2 in a row in which streaming items waited in
  the transport while the congestion controller, or the socket's safety limit, held them back at least 80% of the time;
  one isn't enough: Startup and ProbeRTT hold data back for a period on a busy link that keeps up), or, at once, the
  predicted backlog is over `BURST_MS` (see phase 3 below). It ends at the end of a period held back under 50% with
  the predicted backlog under `BURST_MS`, at least 2 s after it began. (Phase 2's lossless-demand check, with
  per-surface sizes in the monitor, was replaced by the predicted backlog.) On the simulated link (`packages/congestion/src/test/sim-link.ts`, 20 Mbit/s): a stream at 40-80% of the link
  never makes it limited, an endless one does within 2-3 s. Transitions are logged ("Bandwidth-limited: ...", "No
  longer bandwidth-limited: ..."). A streaming surface is then link-bound: its decision says so (`TrafficDecision.bottleneck`), and its encoder goes
  lossy.
- **JPEG or lossless, whichever is smaller** (a deviation from "JPEG patches while limited"): a streaming surface's
  patches captured while limited are encoded with the lossless cascade *and* as JPEG (quality 70, 4:4:4,
  libjpeg-turbo, `JPEG_QUALITY` in `packages/patch-codec/src/patch-encoder.ts`), and the smaller goes out. UI content is often smaller
  losslessly (QOI + LZ4), and then nothing needs refreshing; QOI costs a fraction of the JPEG encode.
- **Lossy areas** are tracked per surface (`PatchRenderer.lossyRegion`, at most 32 rectangles, else their bounding
  box), updated in send order (each patch as it goes to the sink, so a later lossless patch always clears an earlier
  lossy one), the whole surface while it streams video. Settling (phase 3; phase 2 refreshed only once the surface
  no longer went lossy, at normal priority): whenever the surface has no damage to send (none queued, encoding or
  unsent), its lossy areas are planned as lossless patches and sent in the transport's lowest tier, whatever the link
  (logged: "sending its N lossy pixels again, losslessly (settling)").
- **Phase 3, bursts and settling** (built 2026-10-05):
  - Each surface keeps a pixel-weighted, decayed (0.8 per patch) average of its lossless bytes per pixel, from all its
    lossless patches (`PatchRenderer.bytesPerPixel`; 4 before any).
  - Predicted backlog of a surface (`predictedBacklogBytes`): its frames and patches waiting in the transport (real
    size, settling patches excluded) plus its damage queued or encoding times its bytes per pixel. In time at the link's
    bandwidth: `max_bw` remembered from the last saturated period (or the current `max_bw` if higher); unknown, and
    nothing below applies, until the link was saturated once on the connection.
  - **Burst promotion** (`TrafficPolicy.checkBurst`, run whenever damage is queued, before the pump captures it, and
    on every tick): while the normal surfaces' predicted backlog is over `BURST_MS` (200 ms, `priority.ts`), the normal
    surface with the largest is promoted ("is now streaming (a burst: ...)"). The total backlog (all surfaces) over
    `BURST_MS` makes the link bandwidth-limited at once, so a burst's first patches already go out as JPEG.
  - **Settling** takes the surface's stream like any item (up to about a chunk of settling patches may wait), but new
    damage is captured first as soon as the stream is ready, and drops the settling patches it covers. An app's frame
    callbacks wait for `readyForFrame`: the surface's stream is ready, not counting its settling patches unless damage
    already waits. Settling doesn't make the surface busy or backlogged for the relentless measure.
  - **Minimum frame rate** (`packages/scheduler/src/FramePacing.ts`, `MIN_FRAME_RATE` 10): a frame callback held because the surface isn't
    ready goes anyway after `MAX_FRAME_HOLD_MS` (100 ms). The app's next frame is queued as damage and read when its
    stream is ready, so a slow repaint may show parts of different frames (tearing), but the app keeps responding while
    a page takes the link seconds to send. Not for a surface streamed as video: a video frame is the whole surface,
    there is no partial repaint to get ahead of, so its callbacks wait until it's ready.
  - Experiment (dev only): `--dev-patch-order random` (with `--dev-auth`) makes surfaces capture their queued patches
    (damage and settling) in random order within batches instead of oldest first: each commit's new patches are a
    batch (settling's plan one), batches go oldest first. A large repaint fills in as a random mosaic, and no patch is
    starved: it waits at most for the patches queued before or with it. Still correct: queued rectangles are disjoint and read the latest pixels when captured. `--dev-patch-shape tiles`
    splits large damage into squarish tiles (`splitTiles`: near-equal, about 256 x 256 for 64K pixels, edges on
    multiples of 16 for JPEG's blocks; thin rectangles get tiles as thick as they are) instead of full-width bands.
  - **Demotion** only once the surface has no damage left and nothing lossy (a video surface: no damage; stopping the
    video sends a crisp image), and its last period was backlogged under 15% (`RelentlessMeter`'s `canDemote`), at a
    period end or any time after.
  - **Third send tier**: the transport's deficit round-robin runs over normal, streaming and settle, quanta 48 KB,
    16 KB and 5.3 KB (9 : 3 : 1), work-conserving. A surface's items go in order, so a surface waits in the highest
    tier of its items (a settling patch ahead of damage goes with the damage).
- **Video** has a constant QP, no bitrate cap: `QP_HIGH` 24 normally, `QP_LOW` 32 while limited (nvh264enc
  `rc-mode=constqp`/`qp-const`, vaapih264enc `rate-control=cqp`/`init-qp`), switched while the encoder runs with a key
  frame (`setQuality`). Untested: no GPU here.
- **Viewer**: JPEG patches are decoded by the browser (`createImageBitmap` of a Blob) in the patch worker; a JPEG with
  alpha's two images are combined on the main thread by the shared WebGL compositor (`alpha-video.ts`,
  `AlphaCompositor.combineImages`), which also gives video its alpha; alpha of 254 or more counts as opaque there.

### Stream readiness

(Decided 2026-10-09, `docs/MODULARIZATION.md` "The transport says when a stream is ready"; it replaced the fixed two
slots per surface, `SURFACE_SLOTS`.) Each surface is a stream of items in the transport; an item is one patch or one
video frame.

- **The transport says when a stream is ready** for its next item (`ViewerTransport.streamReady`, `packages/transport`): when at most one
  chunk of that surface's data is left unsent, counted in bytes (its queued items plus what's left of its started
  one), at the current chunk size (`CHUNK_MS` = 10 ms of the congestion controller's bandwidth estimate, 10 to
  300 KB). A stream found not ready is told when it is (`onStreamReady`, at the end of the transport's pump, once its
  state is settled; the sink passes it on to the surface's encoder). It's the same idea as `TCP_NOTSENT_LOWAT`, one
  level up.
- **One encode at a time per surface**, patches and video alike, started only when its stream is ready (different
  surfaces still encode in parallel). No reservation is needed: a stream has a single producer and one encode in
  flight, so nothing else can use the readiness it saw. The encoded item goes to the transport whatever the stream's
  state by then, so a surface's patches reach the transport in capture order.
- So several small items (patches) may be queued until about one chunk's worth waits, and a large one (a key frame)
  isn't followed by the next until it's nearly sent: the next item is captured from fresher content. Everything else
  waits as queued rectangles, where new damage merges into it (or, for video, as one wanted frame of the latest
  content).
- One chunk of lead time is enough: a chunk is about 10 ms of the link, and producing the next item is faster (a
  patch is at most 64K pixels).
- Because a surface only encodes when its stream is ready, the amount it encodes follows the send schedule: a
  low-priority surface encodes only as fast as it's allowed to send. How its encoding competes for the CPU is the next
  section.

### Encode scheduling: streaming patches at low CPU priority

Relentless patch encoding must not fight real work on the machine (the user's apps, other sessions). So streaming
surfaces' patches are encoded on threads with a low OS priority, and the kernel's scheduler gives them only the CPU
that nothing else wants.

- **Normal surfaces**: a pool of `NORMAL_ENCODE_WORKERS` = 4 worker threads at normal priority (nice 0; the same
  `PatchWorkerPool` class and `patch-worker.ts`, in `packages/patch-codec`). At most `MAX_NORMAL_ENCODES` = 4 patches encoding at once (`PatchPump` in `packages/scheduler`, which decides which surface gets the next free encoder).
- **Streaming surfaces**: a separate pool of `STREAMING_ENCODE_WORKERS` = 2 Node `worker_threads`, each started with
  its own OS thread at nice `STREAMING_ENCODE_NICE` = 19. A worker does the whole encode (the native QOI
  cascade, synchronously, on the worker's own thread, so the nice level applies to it), one patch at a time.
  The captured pixels are passed as a transferred `ArrayBuffer` (no copy) and the encoded patch comes back the same way.
  The libuv thread pool can't be used for this: its threads are shared with everything else in the process (file
  I/O, DNS, normal patches), and an unprivileged process can raise a thread's nice level but never lower it back.
- Setting the nice level: a small native function in the patch addon (`packages/patch-codec/native`, which the workers load
  anyway), `setThreadNice(n)`: `setpriority(PRIO_PROCESS, gettid(), n)`, which on Linux applies to the calling thread only.
  Each worker calls it first thing; if it fails, the worker logs once and carries on at normal priority. No
  privileges are needed to lower one's own priority.
- Nice 19 has a scheduler weight of 15 against 1024 for nice 0: with a busy normal-priority thread on the same core,
  a streaming encode gets about 1.5% of it; on an idle machine it gets the full CPU. (`SCHED_IDLE` would go lower
  still; nice 19 is enough and simpler.)
- Where it applies: apps started by the session (and from its terminals) share the session process's scheduling
  group, so nice works against them directly. Other users' sessions live in their own systemd slices (pam_systemd),
  which the kernel already balances against ours; within ours, the streaming threads give way.
- A streaming surface captures (its stream ready) only when a streaming worker is free (or about to be: at most one
  patch waiting per worker), so its patches never pile up waiting for a worker. Workers are picked round-robin between
  streaming surfaces. Normal and streaming encodes never wait for each other.
- When a surface changes class, patches already being encoded finish where they are; only new captures go to the
  other pool.
- Video encodes happen on the GPU (hardware encoders) and are not affected.

### Send scheduling

The transport (`ViewerTransport`) decides what goes out next whenever it may send (in 2a: today's rule, at most one
data message handed to the socket at a time and `bufferedAmount` under 64 KB; in 2b: when the congestion controller
allows it). Since the modularization it is `packages/transport`: the mechanism in `FairQueue.ts` (tier ids and quanta
given to it), chunking in `chunking.ts`, the WebSocket, socket tuning (its own small native addon), the simulated link
and receive decoding in `link.ts`; the tiers and their quanta below are the session's configuration
(traffic policy's: `packages/traffic-policy/src/tiers.ts`).

1. Control messages first, always, all of them.
2. Data items (patches and video frames) by **deficit round-robin between the two classes, weighted by bytes** (since
   item 5b phase 3 a third tier below them, settling, with a third of the streaming quantum):
   - Each class keeps a deficit counter (bytes). When a class's turn comes, it adds its quantum: normal
     `3 × DRR_QUANTUM`, streaming `1 × DRR_QUANTUM`, with `DRR_QUANTUM` = 16 KB. It then sends items while the next
     item's size is at most its deficit, subtracting each item's size. Then the other class's turn.
   - A class with nothing waiting gets its deficit reset to 0 and its turn skipped: the other class gets the whole
     link (work-conserving).
   - Within a class, round-robin between surfaces, one item per surface per visit. A surface's items go out in order.
   - With equal-sized patches this behaves like a 3:1 per-message round-robin; byte weighting keeps it fair once
     video frames of very different sizes are mixed in. Normal surfaces are clearly preferred but never starve
     streaming ones.
3. Nothing queued is ever dropped, replaced or revised (decided 2026-10-09, `docs/MODULARIZATION.md` "The send
   queue"): stream readiness keeps the queue short, so there is nothing to gain. The transport doesn't look into the
   items (it doesn't know what a key frame is). An item is reported unsent only when the transport closes (the viewer
   disconnects; a new viewer starts over from every surface's whole content). Lifecycle edges need no queue changes:
   - The viewer's video decoder fails: it sends `keyframe`, and the surface's video makes its next frame a key frame
     (`Surface.refresh`). The deltas still on their way can't be decoded; the viewer discards them quietly
     (`KeyFrameNeeded`) and asks for a key frame only once until something decodes.
   - A surface starts video, is sent whole again (`refresh`), or loses its buffer: the patches already queued go out
     first, and the newer content paints over them.
   - A surface is destroyed: its queued items go out, and the viewer ignores items of surfaces it has forgotten.
   - Video stops while a frame is encoding: rendering discards the result before queueing it (its epoch).

### Frame callbacks

- A surface's frame callbacks are held while its stream isn't ready (more than a chunk of its data unsent, settling
  patches aside unless damage waits, see Stream readiness); they're released at the next tick of the frame clock
  (`FramePacing` in `@nebula/scheduler`) once it is, so an app draws at the rate its output leaves. The clock ticks at 30 Hz
  (`MAX_FRAME_RATE`, user decision 2026-10-04: everything apps draw goes over the network, and 30 frames a second is the
  minimum for smooth motion, so nothing above it is targeted), or at the viewer's display rate if that's slower. Moving
  windows, the cursor and the shell are the browser's and run at the display's own rate. So an app slows down to what we
  can send (a game rendering on the CPU with llvmpipe doesn't render frames that would only be merged away), and a vsync
  game runs at exactly the rate it's given.
- This replaces the delay by the server's average processing time (`ProcessingDuration`). The viewer's decode-time
  part stays until 2b replaces the viewer feedback with acks.
- Without an attached viewer, callbacks stay throttled to about 1 per second, as today.

### Other rules

- The encoder pool (warm hardware video encoders, `videoStreams`, default 4) caps the number of surfaces streamed as
  video; when it's empty, streaming surfaces stay on patches.
- The browser uses software decode for now (no hard decoder limits).
- Rejected: one tiled "atlas" video stream for all windows (too much trouble for the benefit); lowering the
  whole session process's priority (it also runs input, the scene and normal surfaces); holding a
  streaming surface's patches back for whole frames (latency).

## Transport and congestion control

(Decided 2026-10-04; Core item 2b.)

### The problem

The goal: never let more than about 20 ms of data queue anywhere between the server and the screen in steady
state, on any link speed and latency, without starving throughput on fast high-latency links.

What exists today: TCP's own backpressure keeps every queue bounded, so nothing runs away or disconnects. The
transport hands one data message at a time to the socket; `TCP_NOTSENT_LOWAT` is 32 KB on direct TCP; the session's
Unix socket to the gatekeeper has a 32 KB send buffer; the web worker relays with backpressure (it reads from the
desktop only once TLS has sent everything, at most 64 KB at a time) and sets `TCP_NOTSENT_LOWAT` on the browser's socket
(`packages/gatekeeper/web/src/bin/worker.rs`). But those bounds are in bytes, not time
(about 150 KB in all: ~120 ms at 10 Mbit/s), and the kernel's usual congestion control (cubic) keeps filling the
router buffer at the bottleneck until packets drop (bufferbloat: often hundreds of milliseconds). A reverse proxy in
front of the gatekeeper would add its own buffer. And the browser's WebSocket API has no backpressure at all: the
browser reads everything off the socket and queues it as message events, so a viewer that decodes too slowly builds
an unbounded queue in the page.

Not designed for very slow links: at least a lower-end broadband connection is expected; latency may be high.

### Our own BBRv3-style controller

A congestion controller in the session process, on top of whatever TCP the kernel runs (QUIC stacks do the same in
user space). If we pace our sends at the measured bottleneck rate and keep the kernel's unsent queue small
(`TCP_NOTSENT_LOWAT`), TCP never has more data than the path can carry, so the network's queues stay short whatever
the kernel's congestion control is, and through any relay or proxy (the gatekeeper, nginx), since everything is measured
end to end.

It follows BBRv3 as specified in the IETF draft draft-ietf-ccwg-bbr (revision 06, July 2026; the constants below are
from it), adapted to messages instead of packets, with one substitution: we can't see packet loss or ECN, so a
**delay signal** takes the place of loss (below). Code: a pure TypeScript module with an injected clock and no I/O
(e.g. `packages/session/src/viewer/congestion.ts`), one instance per viewer connection (a new connection
starts from scratch).

Units: bytes and milliseconds. "Item" = one data envelope (PATCH or FRAME). Control messages (CONTROL envelopes) are
never counted, paced or held: they're tiny and always go first.

**Per-item send records.** For every data item sent, the controller records: its size, send time, `delivered` (total
bytes acked so far) and `delivered_time` at send, `first_send_time` of the current send burst, and whether the
connection was app-limited when it was sent. As in the draft's delivery-rate sampling (section 4.1).

**Acks and samples.** Acks are cumulative (below). For each newly acked item, in order:

- `delivered += size`, `delivered_time = now`.
- RTT sample: `now − send_time`.
- Delivery-rate sample (computed for the last item newly acked by this ack): `send_elapsed = send_time −
  first_send_time`, `ack_elapsed = delivered_time − P.delivered_time`, rate = `(delivered − P.delivered) /
  max(send_elapsed, ack_elapsed)` (the `max` prevents overestimation from ack compression). A sample is app-limited if
  its item was sent while app-limited.

**Rounds.** A round ends when an ack covers the item that was the last one sent when the round started
(`next_round_delivered`, as in the draft). Round counting drives Startup, REFILL, ProbeRTT and the filters.

**Model.**

- `max_bw`: windowed max of delivery-rate samples over the last `MaxBwFilterLen` = 2 ProbeBW cycles. App-limited
  samples are used only if they're higher than the current estimate (they may raise it, never lower it): a desktop is
  app-limited most of the time, and idleness must not look like a slow link.
- `min_rtt`: min of RTT samples over `MinRTTFilterLen` = 10 s, with the draft's two-level update
  (`probe_rtt_min_delay` over `ProbeRTTInterval` = 5 s; `min_rtt` takes it when lower or when 10 s expired).
  An idle moment's samples (nothing queued) refresh it naturally.
- `bdp = max_bw × min_rtt`.
- `extra_acked`: the draft's ack-aggregation estimate, windowed max over `ExtraAckedFilterLen` = 10 rounds; added to
  the in-flight limit. This matters for us: the browser's event loop delivers acks in bursts.
- Short-term bounds `bw_shortterm` and `inflight_shortterm`, long-term bound `inflight_longterm`, all unset
  (infinite) at the start, adapted by the delay signal as the draft adapts them by loss.

**Pacing.** `pacing_rate = pacing_gain × bw × (1 − 1%)` (`PacingMarginPercent` 1%), where `bw = min(max_bw,
bw_shortterm)`. Before the first RTT sample: `pacing_rate = StartupPacingGain × initial window / 1 ms`, i.e.
effectively unpaced for the initial window. An item may be handed to the socket no earlier than `last_send_time +
last_item_size / pacing_rate`. A timer (millisecond resolution is enough) wakes the transport when the next item is
due.

**In-flight limit.** `inflight` = bytes sent and not yet acked. `max_inflight = cwnd_gain × bdp + extra_acked`, then
bounded by `inflight_shortterm` and `inflight_longterm` per state as in the draft's table (section 5.6). An item may be
sent only if `inflight + size ≤ max_inflight` **or fewer than `MIN_ITEMS_IN_FLIGHT` = 2 items are in flight**, so a
single large item never stalls the link. Initial window before any estimate: 64 KB (`INITIAL_WINDOW`), with the same
2-item floor.

**States and gains** (from the draft):

| State | Pacing gain | Cwnd gain | Exit |
|---|---|---|---|
| Startup | 2.77 (4·ln 2) | 2 | Full pipe: 3 non-app-limited rounds in a row with delivery rate growth under 25%; or a delay signal (below) |
| Drain | 0.5 | 2 | `inflight ≤ bdp` → ProbeBW_DOWN |
| ProbeBW_DOWN | 0.90 | 2 | Time to probe (→ REFILL), or `inflight ≤ (1 − 0.15) × inflight_longterm` (headroom 0.15) and `inflight ≤ bdp` → CRUISE |
| ProbeBW_CRUISE | 1.0 | 2 | Time to probe → REFILL |
| ProbeBW_REFILL | 1.0 | 2 | After one round → UP (short-term bounds reset to unset on entry) |
| ProbeBW_UP | 1.25 | 2.25 | Delivery rate plateau (full-pipe check), or a delay signal → DOWN |
| ProbeRTT | 1.0 | 0.5 | After `ProbeRTTDuration` = 200 ms with `inflight ≤ 0.5 × bdp` and at least one round → ProbeBW_DOWN (or Startup if the pipe was never full) |

- **Time to probe**: `T_probe = min(T_bbr, T_reno)`, `T_bbr` uniformly random in 2–3 s per cycle, `T_reno` = min(BDP
  in items, 62 or 63 picked at random) rounds, as in the draft (`PickProbeWait`, `IsRenoCoexistenceProbeTime`).
- **UP growth**: when `inflight_longterm` is set and limits sending, it grows by 1, 2, 4, 8, ... × `PROBE_UNIT`
  (16 KB, standing in for the draft's packet size) per round (`probe_up_cnt` doubling), as in the draft.
- **ProbeRTT**: entered when `probe_rtt_min_delay` hasn't been refreshed for 5 s and we're not restarting from idle;
  halves the in-flight limit (BBRv3's gentle probe, chosen over v1's 4-packet drop, which stalls a saturating stream
  for ~200 ms every 10 s). While in it, delivery-rate samples are marked app-limited. Skipped naturally on a mostly
  idle desktop: idle moments refresh `probe_rtt_min_delay`.
- **App-limited**: the connection is app-limited when the transport has no data item ready while the controller would
  allow sending. Mark it until the items in flight at that moment are acked (`app_limited = delivered + inflight`), as
  in the draft.
- **Restart from idle**: when sending resumes after `inflight` reached 0, pace at `bw` (pacing gain 1) without
  bursting, and don't enter ProbeRTT on that ack (`idle_restart`).

**Delay signal (instead of loss).**

- `DELAY_THRESHOLD_MS` = 20 ms: an RTT sample is "high" if it exceeds `min_rtt + 20 ms`.
- A round is **too high** if more than half of its RTT samples (at least 4 samples) are high. That is the analogue of
  the draft's loss rate over `LossThresh` (2%) per round: robust to single jittery samples.
- Reactions, mirroring the draft's loss reactions:
  - Startup: exit to Drain (the pipe is full), setting `inflight_longterm = max(bdp, inflight at the signal)`.
  - ProbeBW_UP: set `inflight_longterm = max(bdp, Beta × inflight at the signal)` with `Beta` = 0.7, mark the probe
    as having gone too high (`prev_probe_too_high`: the next UP is precautionary and stops at `inflight_longterm`),
    go to DOWN.
  - DOWN, CRUISE, REFILL, ProbeRTT: `bw_shortterm = max(latest delivery rate, Beta × bw_shortterm)` and
    `inflight_shortterm = max(latest inflight, Beta × inflight_shortterm)`, once per too-high round. REFILL resets
    both short-term bounds to unset on entry, as in the draft.
- Accepted consequence: a ProbeBW_UP at 1.25× for one round adds up to about 0.25 × RTT of queue before the signal
  can come back (75 ms on a 300 ms link), every 2–3 s while a stream saturates the link; DOWN drains it. Steady state
  (CRUISE) stays within the 20 ms target.

### Acks and the viewer backlog

- New viewer → server envelope **ACK** (`EnvelopeKind.ACK` = 5), binary: `u32le received`, `u32le backlogBytes`,
  `u32le largestPendingBytes`. Scene protocol version bumps (11, or the next free number).
  - `received`: cumulative count of data envelopes (PATCH and FRAME) received on this connection (mod 2³²; the
    server compares with wraparound). TCP keeps order, so data envelopes are numbered implicitly in send order; no
    sequence numbers are added to PATCH or FRAME.
  - `backlogBytes`: bytes of data envelopes received but not yet applied. Applied: a patch drawn into the surface; a
    video frame decoded (its `VideoFrame` output delivered). Dropped items count as applied.
  - `largestPendingBytes`: the size of the largest single item in that backlog (0 if none).
- **When the viewer acks**: first thing in the WebSocket message handler for every data envelope, before any decoding,
  so RTT samples measure the network, not decoding. Also, after applying an item, if the last ACK it sent reported
  `backlogBytes − largestPendingBytes > BACKLOG_HOLD_BYTES`, it sends a fresh ACK (same `received`) so the server
  learns the backlog went down. Without this the server, holding, would wait forever.
- **Backlog hold**: the server sends no data items while the latest reported `backlogBytes − largestPendingBytes >
  BACKLOG_HOLD_BYTES` = 1 MB (constant in the scene protocol package, shared by both sides). Excluding the largest
  item keeps one big frame from tripping it. The report is half a round trip old, so the real backlog can briefly
  exceed the threshold by bandwidth × one-way delay; fine for a safety net, it only triggers if the browser decodes
  slower than the server encodes, which should be rare. While holding, the connection counts as app-limited.
- RTT is measured on the server only (send time to ack receipt): no clock sync.
- The acks replace the `feedback` message's `decodeDuration` (removed); `refreshInterval` stays for the frame clock.
  Frame callbacks then depend only on stream readiness (see [Frame callbacks](#frame-callbacks)).

### Transport integration

- The send scheduler (see [Send scheduling](#send-scheduling)) asks the controller before handing a data item to the
  socket: allowed by the backlog hold, the in-flight limit (or the 2-item floor) and the pacing time. If not, the item
  stays queued, so its surface's stream doesn't become ready: its frame callbacks stay held, and its damage keeps
  merging in its queue.
- The old gate (one data message at a time, `bufferedAmount ≤ 64 KB`) is replaced by the controller's, but a local
  safety limit stays: never hand a data item to the socket while `ws.bufferedAmount` is over 256 KB (should never
  happen with the controller working; log once if it does). The kernel buffer settings stay.
- The controller is told when the transport has nothing to send (app-limited) and when it has data waiting.
- As implemented: `WebSocketViewerTransport` uses one `CongestionController` per connection, created by `ViewerHost`
  and passed in through the `Congestion` interface of `@nebula/session-contracts` (tests pass their own, and a clock). The scheduler asks it about the item that is next by deficit round-robin, by the item's envelope
  size (what the viewer's acks count); a refused or empty question leaves the round-robin state as it was, as the
  transport now asks again on every ack, pacing timer and completed send. A paced item gets a timer for when it's due;
  one that waits for the window or the viewer's backlog waits for the next ack, which pumps the transport.

### Testing

- Unit tests against a **simulated link** on a virtual clock (no real sockets, no sleeps; each scenario runs in well
  under a second of real time): a bottleneck with configurable bandwidth, propagation delay each way and buffer
  (bytes; unbounded models bufferbloat), optional jitter and ack batching (acks released every 16 ms, like a browser
  frame), and a viewer that acks on arrival and applies items at a configurable rate. Sources: saturating (always has
  an item), constant-rate, sporadic desktop bursts. Scenarios and assertions (after a warm-up of 2 s unless noted):
  1. 20 Mbit/s, 40 ms RTT, saturating: throughput ≥ 85% of the link; CRUISE queueing delay ≤ 20 ms; no sample over
     40 ms after warm-up except during UP.
  2. 100 Mbit/s, 300 ms RTT, saturating: throughput ≥ 80%; queueing delay peaks ≤ 0.3 × RTT (UP probes), ≤ 20 ms in
     CRUISE.
  3. Bandwidth drops 50 → 10 Mbit/s mid-stream: queueing delay back under 25 ms within 1 s.
  4. Bandwidth rises 10 → 50 Mbit/s: throughput ≥ 80% of the new rate within 6 s.
  5. Base RTT rises 40 → 120 ms (route change): throughput ≥ 80% again within 12 s, no lasting collapse.
  6. Steady growth: a source sending constantly 5% faster than the link for 60 s: queueing delay never exceeds 30 ms
     after warm-up, no drift of `min_rtt` above the true base by more than 5 ms.
  7. Sporadic desktop traffic (bursts of 1–30 patches with idle gaps): `max_bw` not lowered by idle periods; no
     ProbeRTT while idle moments refresh `min_rtt`.
  8. Jitter ±5 ms and 16 ms ack batching on 20 Mbit/s, 40 ms: throughput ≥ 80%, no repeated false delay signals.
  9. Slow viewer (applies at half the link rate): data stops while the reported backlog (minus the largest item) is
     over 1 MB, resumes after the viewer's fresh ACK, never deadlocks.
  10. Control messages are never delayed by the controller or the hold.
  11. 2-item floor: a single item larger than the in-flight limit is still sent.
- `scripts/test-gateway.sh` must still pass (the e2e link is local, so the controller should simply stay out of the
  way: check that no e2e step got slower).
- As implemented (phase 1 of 2b, `packages/session/src/viewer/congestion.ts`, test in `test/congestion.test.ts`
  with the harness `test/sim-link.ts`): every scenario runs on three seeds (item sizes 4–30 KB, jitter, bursts), about
  0.5 s for all. Where the assertions differ from the list above:
  - Bandwidth probes (ProbeBW_UP and the ProbeBW_DOWN that drains it) have their own bound. A probe sends 25% faster
    than the link on purpose and only sees its queue a round trip later, so its peak is about threshold-to-end-it plus
    what it adds in that round trip. At 40 ms RTT probes peak at 30–45 ms, asserted ≤ 50 ms (scenarios 1, 3 and 6:
    "never over 30 ms" in 6 and "under 25 ms within 1 s" in 3 hold outside of probes, at 0–18 ms). At 300 ms RTT they
    peak at 23–46 ms, under the 0.3 × RTT (90 ms) of scenario 2.
  - 8: with up to ~26 ms of noise (16 ms batching, ±5 ms jitter) on top of a real queue, about three times as many
    rounds go over the threshold as on a clean link (~1 a second). They only resize the short-term bounds to the
    measured delivery rate: asserted harmless instead (throughput ≥ 80%, measured 93–97%; bandwidth estimate ≥ 80% of
    the link; CRUISE queue ≤ 25 ms, measured ≤ 23 ms with under 1% of items over 20 ms).
  - Measured (12 seeds): 1: 96–98% of the link, CRUISE ≤ 2 ms; 2: 88–92%; 4: ≥ 95% within 6 s; 5: 88–98% 12 s after
    the RTT change; 6: 5 ms outside probes, `min_rtt` stays within 5 ms of base + one item's transmission time; 7: no
    ProbeRTT and no drop of `max_bw` over 30 s of bursts; 9: backlog never over 1 MB + one item + one-way volume,
    throughput = the viewer's apply rate.
- Deviations from the draft (all listed at the top of `congestion.ts`, each found by a failing scenario):
  - The delay signal: a sample is high when its queue (RTT less the item's own transmission time, size / max_bw,
    the lowest of the last 20 ms of samples to see through ack bursts) exceeds 20 ms; a round is too high when more
    than half of its samples (at least 4) are high, or 4 in a row are (a 300 ms round's early samples predate the
    queue).
  - Reactions size the bounds from the measured delivery rate, as the draft's loss reactions never shrink a standing
    queue without loss: `inflight_shortterm` = bw_latest × (min_rtt + 10 ms), `inflight_longterm` on a too-high probe
    = bw_latest × (min_rtt + 20 ms), both plus `extra_acked` (ack aggregation, as the draft's cwnd has it).
  - ProbeBW_UP ends once 4 samples in a row show a queue over 10 ms (waiting for the 20 ms threshold made probes peak
    at 45–55 ms).
  - A too-high round outside of probing with a delivery rate under 80% of `max_bw` means the capacity dropped: it also
    lowers `inflight_longterm`, restarts the `max_bw` filter from the delivery rate and postpones the next probe
    (otherwise the stale `max_bw` refilled the queue to 200 ms every time REFILL or ProbeRTT reset the short-term
    bounds).
  - `min_rtt` rising by more than 25% (only possible after 10 s without a lower sample) restarts the model in Startup:
    until then the delay signal reads the longer path as a queue and cuts the model down to almost nothing.
  - An item sent into an empty pipe whose RTT (less its transmission time) is within 5% + 1 ms of the minimum
    refreshes the ProbeRTT timer, so an idle desktop doesn't enter ProbeRTT every 5 s.
  - The pacing rate is initialized from the first RTT sample (the draft has the handshake's), or Startup sends in
    line-rate bursts that trip the delay signal long before the pipe is full.
  - No send quantum, no offload budget; the draft's per-packet constants use SMSS = 1448 bytes, and the Reno
    coexistence time scale counts packets of that size, not items.

### Rejected and deferred

- Rejected: a second WebSocket for latency pings (it waits in the same bottleneck queue as the data, so it measures
  base plus queue unless the router queues per connection); a fixed in-flight cap in items or bytes (latency then
  depends on link speed, and a 300 ms link is starved: 64 KB per round trip is ~1.7 Mbit/s); hand-rolled delay
  estimation with ad-hoc fixes for base-delay drift (whack-a-mole; BBR's model covers it); acks after applying
  (they'd measure decoding, not the network; the backlog report covers decoding).
- **On the table for later: kernel BBR** (`net.ipv4.tcp_congestion_control=bbr` system-wide, or per socket by the
  gatekeeper when `bbr` is in `tcp_allowed_congestion_control`; Ubuntu kernels ship `tcp_bbr`). Not used for now, to keep
  installation simple. It would complement our controller, not replace it, and would belong in the install script.

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


