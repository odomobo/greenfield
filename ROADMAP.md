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
  frames) over one WebSocket, decodes frames (WebCodecs), shows each window as its own DOM element with a canvas per
  surface (the browser composites), does all window management and draws the shell.
- **Gateway** (`packages/gateway`): privilege-separated.
  - Root monitor + a small C PAM helper for authentication and starting sessions (with `pam_systemd`/logind).
  - Unprivileged web process (system user `greenfield`) serving the page and relaying connections to session processes
    over Unix sockets.
- **Transport**: a single WebSocket with a priority send queue (input/control before video), latest-wins frame
  coalescing, one frame in flight per window, and small kernel send buffers (`TCP_NOTSENT_LOWAT`). It sits behind a
  `ViewerTransport` interface so WebTransport can be added later if ever needed. Planned: priority classes and a
  per-surface scheduler (see [Encoding policy](#encoding-policy)) and our own congestion control (see
  [Transport and congestion control](#transport-and-congestion-control)).

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
- **Two-factor authentication through PAM** (planned, lowest priority: only once the core is verified sound and free of
  vulnerabilities): the sign-in page will support PAM's follow-up prompts (e.g.
  "Verification code:"), so any two-factor method configured in PAM works without project-specific code.

## Sessions

- Default name "Nebula N" (lowest free number). Rename by clicking the name itself, in the session list and in the
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
  - Right side: system tray icons (planned, see below), audio mute toggle, notifications, clock.
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
- **System tray** (planned, Lower priority item 5c): apps' tray icons (StatusNotifierItem) in the taskbar's tray area,
  their menus shown as our own menus.

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

### GPU acceleration and encoders

- **Without GPU acceleration on the server (the norm: mostly VPSes), everything is sent as lossless patches**, streaming
  surfaces included, best effort. No H.264 at all, not even x264.
- With GPU acceleration, streaming surfaces (that aren't small, below) are sent as video by a hardware encoder
  (`nvh264`, `vaapih264`). There is no x264 fallback.
- The gateway option `--encoder <auto|none|nvh264|vaapih264>` (default `auto`, replacing today's default `x264`;
  `x264` is no longer accepted). `auto`: at gateway start, use `vaapih264` if a render node (`/dev/dri/renderD*`)
  can be opened and GStreamer has the `vaapih264enc` element, else `nvh264` if it has `nvh264enc` and an NVIDIA
  device is present, else `none`. The gateway logs the choice. An explicit encoder that then fails to create (no
  device, missing element) is logged once and the session continues as `none`.
- `none` means no video encoder is ever created: the encoder pool has size 0 and the GStreamer video pipelines are
  never built. **There is no video on the CPU** (decided 2026-10-05, done in item 5b phase 2): the x264 encoder and
  the CPU alpha path (alpha bytes written as I420 luma for x264) are gone from `native/encoding/src/gst_frame_encoder.c`;
  video exists only with a GPU, and every buffer takes the GL pipelines there.
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
  items in its slots (captured, being encoded, or encoded and waiting to be sent; see below), or a video frame being
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
- Periods are closed on every commit and on a 200 ms tick (the existing `EncodingContext.startTicking`), so a surface
  that goes quiet is demoted without committing.

Why this works:

- A callback-paced client (frame callbacks are held until a slot is free, see Frame callbacks) never commits while its
  previous frame is unsent, so "commit while there is unsent work" can't see it. Busy time can: a client that is busy
  most of a period is the one the link or CPU can't keep up with, and its commits in the next period are backlogged.
  Measured: a 1920x1080 busy client was busy 86-94% of each period and promoted at the end of its second period (about
  1.5 s after it started); a 640x480 one was busy 40-45% on loopback and stayed normal.
- A one-off big repaint (launch, a view switch) is a single damage after a quiet period, so it is never backlogged,
  however long it takes to drain.
- A needy surface that is busy less than 60% of the time stays normal: it isn't causing contention, and if the link and
  CPU keep up, nothing waits and priorities don't matter.
- A relentless surface is promoted 1.5 to 2.25 s after it starts, and a quiet one is demoted within 0.75 to 1.5 s.
- It replaces the old rules "ignore the single largest damage" and "new windows start in video".

(Decided 2026-10-04: the first version of this rule, backlogged = a commit arriving while unsent work exists over a
sliding 1.5 s window, never promoted a callback-paced client, because the held callbacks make it drain before it commits.)

Changing class:

- Normal → streaming with video: drop the surface's queued and unsent patches, start its video with a key frame
  (as the switch to fast mode does today).
- Streaming with video → normal: release the encoder and queue a full-surface patch render so a crisp lossless image
  replaces the video (as the switch to slow mode does today).
- Without video, a class change changes only the priority. Nothing is dropped or re-sent.
- If the encoder pool is empty, a promoted surface stays on patches (still streaming class).

### Lossless patches and damage

- Only the damaged areas are sent, as lossless patches of at most `MAX_PATCH_PIXELS` = 64k pixels; larger areas
  are split (`planPatches`). A commit's damage in more than `MAX_PATCH_RECTS` = 32 pieces is sent as its bounding box.
  Each patch is encoded with the QOI cascade (raw / QOI / QOI + LZ4, next section; native `nebula-patch-addon`, on
  worker threads, `patch-encoder.ts`), and decoded in the viewer by a wasm decoder in a Web Worker. (It was PNG until
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
    drops instead: that is what the per-surface two slots are for (frames are only taken when a slot is free), and they
    are believed to work. If they don't, rewrite them; don't add bitrate caps.
- **Refreshes are intelligent.** Track per surface which areas are lossy (JPEG or video) and which are known lossless.
  Whenever a surface leaves a lossy mode (bandwidth recovers, or it returns to the normal class), refresh only the
  areas known to be lossy, losslessly, and only after its pending damage has been sent. Flapping between lossless and
  lossy is then harmless (refreshes stay bounded by the lossy area); hysteresis is optional tuning.

**As built** (item 5b phase 2, scene protocol 18):

- **Bandwidth-limited** is judged by the transport (`viewer/bandwidth.ts`, `BandwidthMonitor`, one per connection).
  Since phase 3 it is either/or: the link is saturated (1 s periods; 2 in a row in which streaming items waited in
  the transport while the congestion controller, or the socket's safety limit, held them back at least 80% of the time;
  one isn't enough: Startup and ProbeRTT hold data back for a period on a busy link that keeps up), or, at once, the
  predicted backlog is over `BURST_MS` (see phase 3 below). It ends at the end of a period held back under 50% with
  the predicted backlog under `BURST_MS`, at least 2 s after it began. (Phase 2's lossless-demand check, with
  per-surface sizes in the monitor, was replaced by the predicted backlog.) On the simulated link (`test/sim-link.ts`, 20 Mbit/s): a stream at 40-80% of the link
  never makes it limited, an endless one does within 2-3 s. Transitions are logged ("Bandwidth-limited: ...", "No
  longer bandwidth-limited: ..."). The sink tells the encoders (`EncodingSink.bandwidthLimited`).
- **JPEG or lossless, whichever is smaller** (a deviation from "JPEG patches while limited"): a streaming surface's
  patches captured while limited are encoded with the lossless cascade *and* as JPEG (quality 70, 4:4:4,
  libjpeg-turbo, `JPEG_QUALITY` in `patch-encoder.ts`), and the smaller goes out. UI content is often smaller
  losslessly (QOI + LZ4), and then nothing needs refreshing; QOI costs a fraction of the JPEG encode.
- **Lossy areas** are tracked per surface (`SurfaceEncoder.lossyArea`, at most 32 rectangles, else their bounding
  box), updated in send order (each patch as it goes to the sink, so a later lossless patch always clears an earlier
  lossy one), the whole surface while it streams video. Settling (phase 3; phase 2 refreshed only once the surface
  no longer went lossy, at normal priority): whenever the surface has no damage to send (none queued, none in its
  slots), its lossy areas are planned as lossless patches and sent in the transport's lowest tier, whatever the link
  (logged: "sending its N lossy pixels again, losslessly (settling)").
- **Phase 3, bursts and settling** (built 2026-10-05):
  - Each surface keeps a pixel-weighted, decayed (0.8 per patch) average of its lossless bytes per pixel, from all its
    lossless patches (`SurfaceEncoder.bytesPerPixel`; 4 before any).
  - Predicted backlog of a surface (`predictedBacklogBytes`): its frames and patches waiting in the transport (real
    size, settling patches excluded) plus its damage queued or encoding times its bytes per pixel. In time at the link's
    bandwidth: `max_bw` remembered from the last saturated period (or the current `max_bw` if higher); unknown, and
    nothing below applies, until the link was saturated once on the connection.
  - **Burst promotion** (`EncodingContext.checkBurst`, run whenever damage is queued, before the pump captures it, and
    on every tick): while the normal surfaces' predicted backlog is over `BURST_MS` (200 ms, `policy.ts`), the normal
    surface with the largest is promoted ("is now streaming (a burst: ...)"). The total backlog (all surfaces) over
    `BURST_MS` makes the link bandwidth-limited at once, so a burst's first patches already go out as JPEG.
  - **Settling** may fill both of the surface's slots, but new damage is captured first as soon as one frees, and
    drops the settling patches it covers. An app's frame callbacks wait for `readyForFrame`: a free slot, or one
    holding a settling patch (unless damage already waits for it). Settling doesn't make the surface busy or
    backlogged for the relentless measure.
  - **Minimum frame rate** (`FramePacing.ts`, `MIN_FRAME_RATE` 10): a frame callback held because the surface isn't
    ready goes anyway after `MAX_FRAME_HOLD_MS` (100 ms). The app's next frame is queued as damage and read when a
    slot frees, so a slow repaint may show parts of different frames (tearing), but the app keeps responding while a
    page takes the link seconds to send. Not for a surface streamed as video: a video frame is the whole surface, there
    is no partial repaint to get ahead of, so its callbacks wait until it's ready.
  - Experiment (dev only): `--dev-patch-order random` (with `--dev-auth`) makes surfaces capture their queued patches
    (damage and settling) in random order instead of oldest first, to see what a slow repaint looks like that way.
    Still correct: queued rectangles are disjoint and read the latest pixels when captured.
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

### Per-surface slots

Each surface is a source with at most **2 slots** (`SURFACE_SLOTS` = 2). An item is one patch or one video frame.

- A slot is taken when an item is captured (patch: pixels read; video: encoding started) and freed when the item is
  handed to the socket, or dropped.
- A surface may capture only while it has a free slot. So at most two of its items exist between capture and the
  socket; everything else waits as queued rectangles, where new damage merges into it.
- Because a surface only encodes into free slots, the amount it encodes follows the send schedule: a low-priority
  surface encodes only as fast as it's allowed to send. How its encoding competes for the CPU is the next section.

### Encode scheduling: streaming patches at low CPU priority

Relentless patch encoding must not fight real work on the machine (the user's apps, other sessions). So streaming
surfaces' patches are encoded on threads with a low OS priority, and the kernel's scheduler gives them only the CPU
that nothing else wants.

- **Normal surfaces**: a pool of `NORMAL_ENCODE_WORKERS` = 4 worker threads at normal priority (nice 0; the same
  `PatchWorkerPool` class and `patch-worker.ts`). At most `MAX_NORMAL_ENCODES` = 4 patches encoding at once.
- **Streaming surfaces**: a separate pool of `STREAMING_ENCODE_WORKERS` = 2 Node `worker_threads`, each started with
  its own OS thread at nice `STREAMING_ENCODE_NICE` = 19. A worker does the whole encode (the native QOI
  cascade, synchronously, on the worker's own thread, so the nice level applies to it), one patch at a time.
  The captured pixels are passed as a transferred `ArrayBuffer` (no copy) and the encoded patch comes back the same way.
  The libuv thread pool can't be used for this: its threads are shared with everything else in the process (file
  I/O, DNS, normal patches), and an unprivileged process can raise a thread's nice level but never lower it back.
- Setting the nice level: a small native function in the existing `poll` addon (next to `setTcpNotSentLowat`),
  `setThreadNice(n)`: `setpriority(PRIO_PROCESS, gettid(), n)`, which on Linux applies to the calling thread only.
  Each worker calls it first thing; if it fails, the worker logs once and carries on at normal priority. No
  privileges are needed to lower one's own priority.
- Nice 19 has a scheduler weight of 15 against 1024 for nice 0: with a busy normal-priority thread on the same core,
  a streaming encode gets about 1.5% of it; on an idle machine it gets the full CPU. (`SCHED_IDLE` would go lower
  still; nice 19 is enough and simpler.)
- Where it applies: apps started by the session (and from its terminals) share the session process's scheduling
  group, so nice works against them directly. Other users' sessions live in their own systemd slices (pam_systemd),
  which the kernel already balances against ours; within ours, the streaming threads give way.
- A streaming surface captures into a free slot only when a streaming worker is free (or about to be: at most one
  patch waiting per worker), so its patches never pile up waiting for a worker. Workers are picked round-robin between
  streaming surfaces. Normal and streaming encodes never wait for each other.
- When a surface changes class, patches already being encoded finish where they are; only new captures go to the
  other pool.
- Video encodes happen on the GPU (hardware encoders) and are not affected.

### Send scheduling

The transport (`ViewerTransport`) decides what goes out next whenever it may send (in 2a: today's rule, at most one
data message handed to the socket at a time and `bufferedAmount` under 64 KB; in 2b: when the congestion controller
allows it):

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
3. Video frame rules stay as today: a key frame replaces everything unsent of its surface, at most 3 unsent delta
   frames per surface before resyncing with a key frame.

### Frame callbacks

- A surface's frame callbacks are held while both of its slots are taken; they're released at the next tick of the
  frame clock (`FramePacing.ts`) once a slot is free. The clock ticks at 30 Hz (`MAX_FRAME_RATE`, user decision
  2026-10-04: everything apps draw goes over the network, and 30 frames a second is the minimum for smooth motion, so
  nothing above it is targeted), or at the viewer's display rate if that's slower. Moving windows, the cursor and the
  shell are the browser's and run at the display's own rate. So an app slows down to what we
  can send (a game rendering on the CPU with llvmpipe doesn't render frames that would only be merged away), and a
  vsync game runs at exactly the rate it's given.
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
Unix socket to the gateway has a 32 KB send buffer; the gateway relays with `pipe()` (backpressure) and sets
`TCP_NOTSENT_LOWAT` on the browser's socket (`gateway/src/web.ts`). But those bounds are in bytes, not time
(about 150 KB in all: ~120 ms at 10 Mbit/s), and the kernel's usual congestion control (cubic) keeps filling the
router buffer at the bottleneck until packets drop (bufferbloat: often hundreds of milliseconds). A reverse proxy in
front of the gateway would add its own buffer. And the browser's WebSocket API has no backpressure at all: the
browser reads everything off the socket and queues it as message events, so a viewer that decodes too slowly builds
an unbounded queue in the page.

Not designed for very slow links: at least a lower-end broadband connection is expected; latency may be high.

### Our own BBRv3-style controller

A congestion controller in the session process, on top of whatever TCP the kernel runs (QUIC stacks do the same in
user space). If we pace our sends at the measured bottleneck rate and keep the kernel's unsent queue small
(`TCP_NOTSENT_LOWAT`), TCP never has more data than the path can carry, so the network's queues stay short whatever
the kernel's congestion control is, and through any relay or proxy (the gateway, nginx), since everything is measured
end to end.

It follows BBRv3 as specified in the IETF draft draft-ietf-ccwg-bbr (revision 06, July 2026; the constants below are
from it), adapted to messages instead of packets, with one substitution: we can't see packet loss or ECN, so a
**delay signal** takes the place of loss (below). Code: a pure TypeScript module with an injected clock and no I/O
(e.g. `packages/compositor-proxy/src/viewer/congestion.ts`), one instance per viewer connection (a new connection
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
  Frame callbacks then depend only on the slots (see [Frame callbacks](#frame-callbacks)).

### Transport integration

- The send scheduler (see [Send scheduling](#send-scheduling)) asks the controller before handing a data item to the
  socket: allowed by the backlog hold, the in-flight limit (or the 2-item floor) and the pacing time. If not, the item
  stays in its surface's slot, the surface's frame callbacks stay held, and its damage keeps merging in its queue.
- The old gate (one data message at a time, `bufferedAmount ≤ 64 KB`) is replaced by the controller's, but a local
  safety limit stays: never hand a data item to the socket while `ws.bufferedAmount` is over 256 KB (should never
  happen with the controller working; log once if it does). The kernel buffer settings stay.
- The controller is told when the transport has nothing to send (app-limited) and when it has data waiting.
- As implemented: `WebSocketViewerTransport` owns one `CongestionController` per connection (injectable, with the
  clock, for tests). The scheduler asks it about the item that is next by deficit round-robin, by the item's envelope
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
- As implemented (phase 1 of 2b, `packages/compositor-proxy/src/viewer/congestion.ts`, test in `test/congestion.test.ts`
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
  gateway when `bbr` is in `tcp_allowed_congestion_control`; Ubuntu kernels ship `tcp_bbr`). Not used for now, to keep
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
- Core 2 (2026-10-04, merged into master): normal and streaming priority classes by the relentless measure,
  per-surface slots, streaming patches encoded on nice-19 worker threads, byte-weighted scheduler between the classes,
  lossless patches only without GPU acceleration (`--encoder auto|none|nvh264|vaapih264`, no x264), and our own
  BBRv3-style congestion control with viewer acks and the backlog hold (scene protocol 11). See Core items 2a and 2b.

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
     | 3 | **D. Done.** Fullscreen (the window fills the output, which excludes the taskbar: the taskbar always stays visible; protocol unchanged), popups unconstrained to the output, `repeat_info` 25/600, keyboard layout from `/etc/default/keyboard`, the cheap globals (viewporter, presentation-time, xdg-activation, single-pixel-buffer, idle-inhibit, xdg-output), the window menu with Move and Size, preview cards with title and close only; no Alt+drag. Details: wlr-core README. Original plan: **Polish**: fullscreen, popups kept on screen, key repeat, keyboard layout from the locale (Caps/Num Lock sync is done: it follows the browser's modifier state); cheap globals (viewporter, presentation time, xdg-activation, single-pixel buffer, idle inhibit, xdg-output). **Window menu with Move and Size** (Windows' window menu; how a window without a reachable title bar is moved, e.g. xclock): one shared menu, `windowMenuItems` in `packages/viewer/src/shell/menus.ts`: Restore/Minimize, Maximize/Restore down, Move, Size, Close window. Move: the four-way move cursor, the window follows the pointer, a click drops it, Escape puts it back, arrow keys nudge it. Size: the edge or corner nearest the pointer (or picked by the first arrow key) follows the pointer, a click finishes, Escape cancels. Both reuse the drag code and the window-state sync (no server changes). Taskbar preview cards show only the title and a close button (no minimize and maximize controls); right-clicking anywhere on a card opens the window menu, as does the taskbar button of a single-window group (as today); our own title bars (Core item 4) open the same menu. No Alt+drag: undiscoverable, and host desktops (KDE, Xfce) and apps (GIMP, Inkscape, Blender) use Alt+click. | Sonnet | 600-900 |
     | 3 | **Done.** Text clipboard both ways (a remote app's selection is read through a pipe and written to the browser's clipboard, retried at the next input if the browser refuses; Ctrl+V, Ctrl+Shift+V and Shift+Insert send the browser's text first, then the key; the primary selection stays between remote apps); drag and drop between remote apps with the icon shown by the viewer; files from the user's computer dropped on a window are uploaded (chunks over the WebSocket, `FILE` envelopes) into `~/.cache/greenfield/drops/<random>/` and offered as `text/uri-list` through a drag of ours (hovering shows apps' drop targets). Scene protocol v7; native `wlr_core_clipboard.c` and `wlr_core_dnd.c`; e2e `scripts/e2e/clipboard.sh` (foot, OSC 52) and `dnd.sh` (a small Wayland client). Not done: images and files in the clipboard, X11 apps' drags with the browser (untested), a progress indicator for big uploads. **E. Clipboard with the browser, then drag and drop** (in that order, one agent: drag and drop reuses the clipboard's data plumbing). Clipboard: a server-side data source for text from the browser (on Ctrl+V), the selection read through a pipe and sent to the viewer, primary selection the same way; X11/Wayland sync comes with `wlr_xwayland`. Drag and drop: between remote apps via wlroots' seat drags with the drag icon shown by the viewer, then local files into remote apps (uploaded, offered as `text/uri-list`). | Sonnet | 1.1-1.6k |
     | 3 | **Done.** **F. HiDPI, server side**: output scale and `wp_fractional_scale_v1` from the viewer's reported scale (notes in the wlr-core README, "HiDPI"; protocol 8 adds the cursor surface's logical `size` (7 on its branch; E took 7); checked with foot at 1, 1.5 and 2 by `scripts/e2e/hidpi.sh`, GTK/Qt/browsers unchecked; X11 apps stay 1x and are upscaled, but see the right screen size through xdg-output). | Sonnet | 100-200 |
     | 3 | **Done.** **H. Input and X11 gaps** (details: wlr-core README, wave 3 H; scene protocol v9 after merging; v7 on its branch). Browser shortcuts and Keyboard Lock: dropped: shortcuts the browser takes don't reach apps (user decision). Pointer lock and relative motion, X11 `_NET_WM_ICON` taskbar icons, X11 apps from a terminal ended at logout, touch (wl_touch from touch pointer events; pen stays a pointer, no tablet protocol) and v120/smooth scrolling are done; pointer lock, touch and the browser side of confinement are only unit tested (no headless way). Original plan: browser shortcuts reach the app (Ctrl+W/T/N, Alt+Tab, ...) through the browser's Keyboard Lock API in fullscreen, with a hint on how to enter it; pointer lock and relative motion (`pointer-constraints-v1`, `relative-pointer-v1`) from the browser's Pointer Lock API, for games and 3D apps; taskbar icons for X11 windows from `_NET_WM_ICON` when there's no `.desktop` icon; X11 apps started from a terminal in the session are closed at logout like Wayland ones (wave 2 B gap); touch and pen input from pointer events if cheap (otherwise its own item); check that the viewer sends high-resolution scrolling (`axis_value120`). | Sonnet | 400-700 |
     | 3 | **Done.** **I. Cheaper H.264 encoding** (knobs: the `X264_*` defines at the top of `gst_frame_encoder.c`; notes in the wlr-core README; not benchmarked, the user tunes) (`native/encoding/src/gst_frame_encoder.c`; video is only used for busy surfaces, so it should be cheap to encode and low in bitrate, not high quality). x264: `speed-preset=superfast` with `tune=zerolatency`, dropping the upstream overrides that make it expensive (`me=2` UMH search, `analyse=51`, `dct8x8`, `cabac`, `psy-tune=2`; no speed preset meant `medium`); quality-based rate control under a bitrate cap instead of 12 Mbps CBR (1.2 Mbps for alpha). Pad coded sizes to 16 instead of 128 (128 saved new streams on small resizes, which matters little since most updates are PNG patches); check the browser's decoder accepts it. Two paths: shared-memory buffers to x264 go through a CPU pipeline (`appsrc ! videoconvert ! (padding) ! x264enc`; the alpha stream built by our C code writing the alpha bytes as a gray frame, no GL), the GL pipeline (upload, shader, convert, download) stays for GPU (dmabuf) buffers and hardware encoders (nvh264, VA-API), where it's the cheap path. The agent doesn't benchmark: the user measures and tunes the preset (up or down from superfast) and rate control by hand. | Sonnet | 200-400 |
     | 3 | **Done.** **Resize and move on release**: window moves work the same way (the window follows the pointer, one `window.move` on drop, none on Escape; the 50 ms throttled sends are gone; server-initiated moves unchanged). An interactive resize (an app's border, the window menu's Size) sends nothing to the app while dragging: the viewer stretches the shown content into the dragged rectangle (fixed edges in place) and sends one `window.resize` (`done: true`) on release (click or Enter in Size; Escape sends nothing), staying stretched until the app commits the size. No intermediate encoder restarts. The scene carries each window's size limits (`minWidth`, `minHeight`, `maxWidth`, `maxHeight`, window geometry pixels, absent: unbounded; xdg_toplevel min/max size, X11 from WM_NORMAL_HINTS) and the viewer clamps the drag to them (`packages/viewer/src/resize.ts`). Scene protocol v10. The server still handles `done: false`. | Sonnet | 150 |
     | 4 | **Deferred** (revisit GPU acceleration later; servers are mostly VPSes without GPUs). **G. GPU buffers**: linux-dmabuf with the GLES2 renderer, dmabuf readback for patches and import for video, ported from `native/encoding/src/pixels.c`. Depends on I (both change the encoder's GL path, which I restructures). Can't be verified on the development machine (WSL has no `/dev/dri` render node, so apps can't allocate GPU buffers); it's only tested on real hardware. | Sonnet | 200-400 |

     Wave 1 alone gives today's features on wlroots. In total about 3.5-5.5k lines added and 60k+ deleted (much of
     the deleted code is generated or vendored).
   - **Packages**: the build needs `meson` (and ninja). XWayland needs `xwayland` (also at run time), `libxcb1-dev`,
     `libxcb-composite0-dev`, `libxcb-ewmh-dev`, `libxcb-icccm4-dev`, `libxcb-render0-dev`, `libxcb-res0-dev`,
     `libxcb-xfixes0-dev` (in CI and the build docs since wave 2 B); its end-to-end test needs x11-utils.
     `libxcb-errors-dev` (nicer X11 error messages, optional) isn't packaged for Ubuntu 24.04. Clones need
     `git submodule update --init`.
   - Must still pass `scripts/test-gateway.sh` and the unit tests; GPU (dmabuf) buffers stay untested without
     hardware.
2a. **Streaming class, scheduler and PNG-only without GPU acceleration.** **Done** (branch `core2a`, 2026-10-04). The
    spec is [Encoding policy](#encoding-policy); this lists the work. Sonnet, own branch and worktree. Works without 2b.
    No scene protocol change.
    - **Implemented as listed below**, with these notes and deviations:
      - `auto` looks for `/dev/nvidia<N>` (not `/dev/nvidiactl`, which WSL has without a GPU device), and for the
        elements with `gst-inspect-1.0 --exists`; the logic is in `packages/gateway/src/encoder.ts` (unit tests with
        mocked probes). `EncoderPool` reports a creation failure once and then behaves as size 0.
      - Video frames take slots like patches (the sink's `sendFrame` got a `done` callback, and both sink calls carry
        the surface's class). When no slot is free, the wanted frame (a key frame, or a delta of the latest content) is
        encoded when one frees up. Dropped unsent items (key frame replacing a chain, `dropPatches`, closing) free
        their slots through `done(false)`.
      - The streaming pool (`StreamingEncoder.ts`, worker in `png-worker.ts`) has one shared FIFO queue that an idle
        worker takes from, instead of assigning to workers round-robin; capture is allowed while fewer than 2 x workers
        patches are encoding or waiting. `setThreadNice` returns the thread id (or minus errno).
      - The frame clock got a testable queue class (`FrameCallbackQueue`); `ProcessingDuration` is gone.
      - The relentless measure was changed after the first version, see "Classes" (periods of 750 ms, busy and
        backlogged fractions). Class changes are logged with the last period's fractions. Video (GPU) paths are
        untested here as before.
      - Checked by hand after merging (2026-10-04, at the user's request; not part of the e2e suite): two 640x480
        busy clients at once. A single one keeps up (about 42% busy) and stays normal, but two make each other wait
        for the encoder: both were promoted in every one of 5 runs (last period 75-92% backlogged, within about 1.5 s),
        after which the session used about 190% of a core at nice 19 and about 13% at normal priority.
      - New e2e script `scripts/e2e/busy.sh` (with `busy-client.c`): a busy client is shown as patches and paced, and
        foot stays responsive while it runs; it also waits for the busy surface to be promoted to streaming and for the nice-19
        workers to use CPU. The e2e gateways run `--encoder none`; the viewer's video decoding has no
        e2e coverage now (its unit tests stay). The viewer test hook got `__viewerTest.patches()`.
    - Gateway: `--encoder <auto|none|nvh264|vaapih264>`, default `auto`, `x264` removed (`config.ts`, `ipc.ts`,
      `monitor.ts`, `session-process.ts`, docs and `--help`). Detection in the gateway at start, logged. The session
      gets `none` or a hardware encoder; with `none`, `startWlrootsCompositor` makes an encoder pool of size 0 and
      never creates a `WlrEncoder`. A hardware encoder that fails to create is logged once and treated as `none`.
    - `encoding/policy.ts`: remove `DamageMeter`, `nextMode`, `EncodingMode`, `FAST_ABOVE_...`, `SLOW_BELOW_...`,
      `INITIAL_FAST_MS`; add the relentless measure (a pure class: `markBackloggedStart(now)`,
      `markBusyStart/End(now)`, the period fractions, plus the promote/demote decision with its constants), keeping
      `planPatches` and the patch constants.
    - `encoding/SurfaceEncoder.ts`: class (`'normal' | 'streaming'`) instead of mode; video only when streaming, an
      encoder is available and the surface isn't small (or its pixels can't be read). Track unsent work and the
      backlogged state as defined in the spec. Class changes as specified (with video: drop patches + key frame /
      crisp full render; without: priority only). `refresh()` (viewer attached, key frame needed) unchanged in
      effect.
    - Replace `PatchPump`'s single round-robin set with per-surface slots (`SURFACE_SLOTS` = 2) and the two encode
      pools: normal on libuv as today (`MAX_NORMAL_ENCODES` = 4), streaming on `STREAMING_ENCODE_WORKERS` = 2
      `worker_threads` at nice 19 (new `setThreadNice` in the `poll` addon; the worker runs the existing `png.ts`
      code with `deflateSync`). Keep capture-order sending per surface (`sendTails`) and the epoch check for stale
      results.
    - `viewer/ViewerTransport.ts`: `OutgoingMessage` for patches and frames carries the class (`'normal' |
      'streaming'`); replace the single `pendingFrames` round-robin with the byte-weighted deficit round-robin between
      the classes (`DRR_QUANTUM` = 16 KB, quanta 3:1), round-robin between surfaces within a class. Control first as
      today; key frame and delta frame rules as today. The send gate stays as today (one data message at a time,
      `bufferedAmount` ≤ 64 KB). A patch's `done(true)` (slot freed) when it's handed to the socket, as today.
    - Frame callbacks (`WlrCompositor.ts`, `FramePacing.ts`): held while both slots are taken, released at the next
      frame-clock tick once one is free; remove the `ProcessingDuration` delay; keep the viewer decode-time delay and
      the detached throttle.
    - All constants named and grouped at the top of their files, so they're easy to tune.
    - Unit tests: the measure (a one-off big repaint never promoted, even when it drains over several periods; a
      callback-paced relentless client promoted at the end of its second period; a needy one under 60% busy stays
      normal; demotion after one period under 15%; nothing before two completed periods); the encode pools (streaming
      patches go to the workers and normal ones to libuv, at most 4 normal encodes, slots respected, a worker's
      thread really runs at nice 19: read its nice value from `/proc/self/task/<tid>/stat`, with the tid returned by
      the native helper; worker PNGs identical to `png.ts` output); the send scheduler (byte-weighted 3:1 with mixed sizes,
      work-conserving when one class is empty, per-surface order kept, control first); frame callbacks held and
      released by slots; `none` never creates a video encoder; `auto` detection with mocked probes.
    - `scripts/test-gateway.sh` passes (WSL has no render node, so it runs `none`: e2e checks that expect video
      must be changed to expect patches; the viewer's video decoding then has no e2e coverage on this machine, so
      keep its unit tests). If cheap, an e2e check that a client committing full damage on every frame
      callback keeps an interactive window (foot) responsive: foot's keystroke reaches the screen within the usual
      wait while the busy client runs.
    - Report: CPU use and the busy client's frame rate with and without a busy client, by hand, not asserted.
2b. **Done** (branch `core2b`). The controller (`viewer/congestion.ts`, deviations from the draft at its top and in
    [Testing](#testing)) and its simulated-link test (the eleven scenarios, three seeds each, about 0.5 s); scene
    protocol 11 (ACK envelope, `BACKLOG_HOLD_BYTES`, `feedback` without `decodeDuration`); the viewer acks every data
    envelope on arrival and reports its backlog (`viewer/src/acks.ts`); the transport gates data items with the
    controller inside 2a's scheduler, with a pacing timer and the 256 KB safety limit instead of the one-in-flight /
    64 KB gate; frame callbacks depend only on the slots. Transport-level tests: control messages are never held by
    the window, the backlog hold or the safety limit; an ack releases data; paced items go out by timer. On the local
    e2e link the controller stays out of the way: `scripts/test-gateway.sh` takes ~23 s as before, the busy client runs
    at ~8.5–8.8 frames/s and foot's typing shows after ~335–360 ms (driver delays included) with and without it.
    Untested: real slow or distant links (WSL can't shape traffic without root). User decisions (2026-10-04): the
    deviations from the draft are accepted as they are. Five adapt BBRv3 to messages and to a delay signal; two have
    no counterpart in the draft (restarting on a path change, detecting a capacity drop), both needed because a delay
    signal can't tell a slower or longer path from a queue. They needn't be separated in the code, and the controller
    isn't to be changed further without a concrete problem. The spec is
    [Transport and congestion control](#transport-and-congestion-control); this lists the work. Opus fork (subtle:
    bugs show up as random latency spikes), own branch and worktree, after 2a is merged (it plugs into 2a's send
    scheduler).
    - The controller as a pure module with an injected clock (`viewer/congestion.ts` or similar), following the
      draft's pseudocode closely (keep the draft's names in comments so it can be checked against it).
    - Scene protocol: `EnvelopeKind.ACK`, `BACKLOG_HOLD_BYTES`, `feedback` loses `decodeDuration`; version bump.
    - Viewer: ack on arrival for every data envelope, track backlog bytes and the largest pending item, fresh ACK
      after applying while the last report was over the hold threshold.
    - Transport: the controller and the backlog hold gate data items; pacing timer; the 256 KB local safety limit;
      app-limited notifications.
    - Frame callbacks: drop the decode-time delay (slots only).
    - The simulated-link test harness and the scenarios listed in the spec; `scripts/test-gateway.sh` passes.
    - Report: how the scenarios came out (numbers), anything in the draft that didn't map cleanly onto messages.
3. **Done** (branch `core3-dom-viewer`). **Viewer: one DOM element per window instead of one WebGL canvas.** Each window
   is a positioned element (`window-view.ts`) with a canvas per surface (`surface-view.ts`; foot has nine, its client
   side decorations are subsurfaces), stacked in DOM order, so the browser does stacking, clipping, hit testing and
   compositing, and window decorations and shadows can be HTML/CSS inside the window's element, next to its canvases.
   - The desktop (`#output`, a focusable div, no longer a canvas) holds a layer of window elements and a layer for the
     client cursor and drag icon (above, `pointer-events: none`). Content is drawn into a surface's canvas as it
     arrives; nothing is re-rendered per frame. The canvas has the app's buffer size in pixels (at a pixel ratio of 2 an
     app renders at twice the surface's CSS size) and a CSS size of the surface, `image-rendering: pixelated` when each
     image pixel covers whole device pixels (the old NEAREST rule), and window positions are snapped to device pixels
     when unstretched, so HiDPI stays as sharp as before.
   - Patches: `clearRect` + `drawImage` of the decoded bitmap (a patch replaces pixels, also transparent ones). Opaque
     video: `drawImage(VideoFrame)` of the bottom right corner of the padded frame, no copy through JavaScript memory
     (`decoder.ts` hands on the `VideoFrame`s, which are closed right after drawing; hardware decoding is no longer
     excluded). Video with alpha: one shared offscreen WebGL context (`alpha-video.ts`) draws the color and alpha
     frames (both converted to RGB by the browser) into one premultiplied image, handed over with
     `transferToImageBitmap` and drawn into the window's 2D canvas (so the canvas can switch between video and patches).
     The page has exactly one WebGL context, however many windows. Without WebGL the color stream is shown without alpha.
   - Moves, resizes and the state animations are transforms on the window's element (`translate` + `scale`, origin at
     the window's surface origin, so every surface of a window stretches together; opacity on the same element), applied
     in one `requestAnimationFrame` callback (`Desktop.layout`) when something changed. The animation timing stays in
     `desktop.ts`; the interaction and animation logic is unchanged. Live resize stretching is that scale.
   - Input: the container takes all pointer, wheel, key and drop events (they bubble up from the window elements) and
     has the pointer capture, the lock and the keyboard focus, so drags, locks and touch behave as before. The browser
     hit tests: `pick` takes `document.elementsFromPoint`, top first, and skips surfaces whose input region doesn't
     cover the point (input falls through to what's below). Minimized windows are `display: none`, minimizing and
     restoring ones `pointer-events: none`. Coordinates are still computed from the pointer's client position and the
     model's rect of the surface (so surface-local coordinates are right at any pixel ratio and while stretched).
     File drags moving between window elements don't count as leaving.
   - Taskbar preview cards are drawn straight from the surface canvases into the card's canvas (`Desktop.drawPreview`,
     no readback), also for minimized windows.
   - `scripts/e2e`: the pixel hooks moved to the canvases. `readLuma` composites the visible windows' canvases in output
     coordinates as they are laid out (same sampling as before), `contentSize` is the canvas's size, `surfacePixels`
     reads one surface's canvas, `injectFrame` and `injectPatch` feed the viewer as if the server had sent them. One
     selector changed (`desktop.sh` took the output's offset from `document.querySelector('canvas')`, now
     `#output`). New `scripts/e2e/video.sh` (in `test-gateway.sh`): x264enc-encoded frames (as the server's CPU path
     does) go through the real decoder, checking cropping, colors (red/blue), transparency, half transparency, patches
     over video and size changes, in about a second. The video decoding path now has coverage on a machine without a
     GPU encoder.
   - Not done / untested: the GPU encode path and hardware decoding (no GPU here); many windows at once (each window is
     a few canvases; nothing was measured); the pixel ratio change on a real second monitor (as before); touch and
     pointer lock were reasoned about, not driven (no hook in the browser driver; their code only changed in how the
     pointer position is derived).
4. **Browser-drawn window decorations (our own title bars)**, right after Core item 3 (moved up from lower priority:
   classic X11 apps such as xclock and xterm draw no title bar, as X11 window managers draw them, so today they can't
   be moved except with the window menu's Move; Qt/KDE apps prefer them too). With one DOM element per window, a frame is HTML/CSS
   around the window's canvas: title, minimize, maximize and close buttons, move by dragging the title bar, resize
   from the frame's edges; right-clicking the title bar opens the shared window menu (wave 3 D: the taskbar's). Offered through `xdg-decoration` (wlroots provides it) to Wayland apps that ask for
   server-side decorations, and drawn for X11 windows the app doesn't decorate itself (`_MOTIF_WM_HINTS`); GTK apps
   keep drawing their own. The window geometry the server reports grows by the frame, and the frame follows the
   window's activated, maximized and minimized state.
   **Done** (branch `core4-decorations`, scene protocol 12).
   - Native core: `wlr_xdg_decoration_manager_v1`; a toplevel's decoration object (new, or any `request_mode`) is
     answered with client side mode if the app asked for it (Chrome with its own title bar keeps it, like GTK, which
     has no decoration object), server side mode otherwise (wlroots sends the configure that must follow), and the object's destruction
     reports the window undecorated again. X11: managed windows are decorated unless `_MOTIF_WM_HINTS` has no title
     (`wlr_xwayland_surface.decorations`, `set_decorations` re-reports); override-redirect windows are never toplevels.
     Both report `toplevel-decorated(sid, bool)`; the server turns it into the scene's `decorated` flag (absent: false).
   - Geometry (decided: **the scene keeps the app's geometry, both sides add the frame**). `x`, `y`, `geometry`,
     surfaces, input and `window.move`/`window.resize` keep meaning the app's window geometry, so nothing about surfaces,
     popups, X11 positions or `window.resize` changed; the outer rectangle is the geometry plus `frameInsets(window)`
     from `@gfld/scene-protocol` (`FRAME_TITLE_HEIGHT` 32, `FRAME_BORDER` 1; maximized: title bar only; fullscreen: none),
     the one definition both use. Server: maximize configures the output minus the title bar and puts the window at
     y = title bar height (never under the taskbar); a window turning decorated while maximized is reconfigured; dialogs
     are centered on their parent counting both frames. Viewer: `keepOnScreen` (80 px of the outer rectangle, top edge
     >= output top), the maximize animation's target, first placement (the cascade is where the frame starts), the menu
     Size's nearest edge. Size limits and resize rects stay in geometry pixels (the frame has a constant size, so a drag
     of an edge changes the geometry by the same amount; `resize.ts` didn't change). `window-sync.ts` needed nothing: it
     reconciles window positions, which are still surface origins.
   - Viewer: `window-frame.ts` (the DOM: icon, title, minimize/maximize/close, border, 8 resize grabs of 8 px outside the
     border, imperative like the rest), `frame-geometry.ts` (pure, unit tested), the frame is a child of the window's
     element placed by `WindowView.layout` and drawn at its real size while the content is stretched by a resize or the
     maximize animation (minimize/restore shrink it with the window image). Title bar: drag moves (one `window.move` on
     the drop, Escape cancels), double click maximizes/restores (not while fullscreen or for fixed-size apps), right
     click opens the shared window menu, buttons call the same actions (dialogs have only close, fixed-size apps have
     maximize disabled), press anywhere on the frame activates. Resize margin: the existing stretch-and-release resize,
     none when maximized. Frame input never reaches the app (`pick` stops at frame parts). App icon: the desktop entry's,
     else the window's own, else a generic glyph. Colors are custom properties in `theme.css` (light and dark).
   - Previews: the cards keep showing the content only (they have their own header with title and close); the frame
     isn't drawn into them. Square corners and no shadow (shadows are item 11; the frame's element is where they'd go).
   - Not done: dragging a maximized window's title bar doesn't restore-and-drag (it does nothing); touch uses the same
     gestures but wasn't driven; no rounded corners; GTK apps keep their own decorations as designed (gtk4-demo checked).
   - Tests: unit (`WlrCompositor` with a fake core: decorated flag, maximize minus the title bar, reconfigure, dialog
     centering; viewer `frame-geometry`), `scripts/e2e/decorations.sh` (in `test-gateway.sh`, ~12 s). Changed
     `desktop.sh` checks: maximize expects the content below the title bar (title bar on screen under the taskbar);
     the title-bar move and top/left resize presses use our title bar and margin instead of foot's own subsurfaces;
     the "window back into view" check measures the outer rectangle (title bar above the geometry, border).
     `browser-driver.js` got `screenshot-device`.
4b. **Desktop integration for apps' own title bars: what we support, and the desktop's settings.** GTK4 and Chrome
   (client-side decorations) show only a close button because they follow the desktop's button layout, and this
   machine's is upstream GNOME's `appmenu:close` (desktop Ubuntu overrides it to `:minimize,maximize,close` through
   `ubuntu-settings`, which WSL doesn't have). Our sessions are the desktop environment for their apps, so we supply
   the settings, the standard way. The shell is called **nebula**: anything new is named that (not "greenfield").
   **Status:** xdg-shell 6 **done** (branch `core4b-desktop-integration`, scene protocol 14): bounds (output minus our
   frame, from a toplevel's first commit, again when the output or its decoration changes; X11 windows never),
   wlroots' default capabilities (all four work), `show_window_menu` opens our window menu at the pointer
   (`window-menu-requested`); `suspended` unused. Checked in `decorations.sh` (foot's bounds and `wm_capabilities`
   from its Wayland log, the menu from a foot drawing its own title bar) and unit tests. The Settings backend is
   **on hold**: GTK reads settings through the portal only from 4.21 on ("The Wayland backend relies on the portal
   for settings", GTK NEWS 4.21.0); before that (Ubuntu 24.04 has 4.14) only inside Flatpak or with
   `GDK_DEBUG=portals` (`gdk_should_use_portal`, checked in 4.14.5's source and with `dbus-monitor`: gtk4-demo never
   calls `org.freedesktop.portal.Settings`, it reads GSettings). So here the backend would only reach Flatpak apps and
   newer GTK; gtk4-demo and Chrome (GTK 3/4 settings) keep `appmenu:close` from GSettings. Decide how to supply the
   button layout to non-portal GTK (e.g. GSettings defaults for our sessions) before building it.
   - **xdg-shell version 6** (`wlr_xdg_shell_create`, today 3; wlroots 0.17.4 supports 6). Backwards compatible: each
     client binds the lower of its version and ours, and v4-6 only add things. What newer clients then act on must be
     accurate:
     - v4 `configure_bounds` (`wlr_xdg_toplevel_set_bounds`): the largest sensible window, the output minus the
       taskbar and, for decorated windows, our title bar. Apps may pick different initial sizes (intended); e2e checks
       that assume today's sizes may need adjusting.
     - v5 `wm_capabilities`: wlroots advertises window menu, maximize, fullscreen and minimize by default, and apps
       believe it, so all four must work. New: `show_window_menu` (an app's title bar right-clicked) opens our shared
       window menu (`windowMenuItems`) at the pointer. Keep it honest per window (e.g. no maximize for fixed-size
       windows, if toolkits use it).
     - v6 `suspended`: only sent if we set it; nothing changes now. For later (Lower priority item 6, don't send what
       can't be seen): if minimized or covered windows are suspended, it must reliably be cleared when they show.
   - **A nebula Settings backend for `xdg-desktop-portal`** (`org.freedesktop.impl.portal.Settings`, D-Bus name
     `org.freedesktop.impl.portal.desktop.nebula`), with `nebula-portals.conf` choosing it for Settings and `gtk`, then
     `kde`, for the rest, and `XDG_CURRENT_DESKTOP=nebula` in our sessions. Apps only talk to the portal; the portal
     asks the backends the desktop's config names (as GNOME and KDE plug in theirs). It provides
     `org.gnome.desktop.wm.preferences` `button-layout = ':minimize,maximize,close'` (Windows style, like our frames),
     and later `org.freedesktop.appearance` (color scheme, accent: read by GTK, Qt and Chromium). First check that
     GTK4 takes the button layout from the portal. No impersonating the portal frontend, no dconf tricks.
   - Dependencies: `xdg-desktop-portal` (an installed nebula depends on it), `xdg-desktop-portal-gtk` recommended
     (file chooser and other dialogs for apps using the portal). Settings work with either, or neither, of the GTK and
     KDE backends: they're ours. Without the portal, apps fall back to GSettings (today's behaviour).
   - Verify: the full e2e suite, and by hand gtk4-demo, Chrome and foot (initial sizes, buttons, right-click menu).
4c. **Next steps after 4b** (to be done by an agent, in this order; the user agreed to them on 2026-10-04):
   1. **Done** (merged as a02d4d6: compositor-proxy 156 and viewer 79 unit tests, `test-gateway.sh` 23 s;
      `decorations.sh` also checks our window menu from gtk4-demo's header bar when gtk4-demo is installed). Was:
      **Merge branch `core4b-desktop-integration`** (xdg-shell 6: bounds, capabilities, our window menu for apps'
      own title bars; scene protocol 14) into master. It was verified on its branch (compositor-proxy 155 and viewer
      79 unit tests, `test-gateway.sh` 22.8 s); master got the 30 Hz frame clock meanwhile (`FramePacing.ts` only).
      Its ROADMAP edit adds a status paragraph to 4b. After merging: `yarn build`, both unit suites (compare counts:
      `yarn test` runs compiled `dist/`), `test-gateway.sh`.
   2. **Done** (`XDG_CURRENT_DESKTOP` and `XDG_SESSION_DESKTOP` are `nebula` in `session-environment.ts` and
      `pam-helper.c`; `greenfield-portals.conf` renamed to `nebula-portals.conf`, still `default=gtk`; no installed
      desktop entry on the dev machine has `OnlyShowIn`/`NotShowIn` and none mentions greenfield or nebula, so no
      visibility changed; autostart is not run by us; new gateway test `desktop-entries.test.ts`; compositor-proxy
      156, viewer 79, gateway 9 unit tests, `test-gateway.sh` 22 s). Was: **`XDG_CURRENT_DESKTOP=nebula`** in our sessions (today `greenfield`; find where the session sets it). Check
      what reads it: `portals.conf` lookup (`nebula-portals.conf` later), `OnlyShowIn`/`NotShowIn` in desktop entries
      (the Apps menu), autostart. Desktop entries limited to `GNOME` or `KDE` shouldn't start showing or vanish by
      accident: say what changed.
   3. **Done** (`nebula-settings.ts` is the one place for the desktop's settings; the build
      (`build-dconf.js`) writes a dconf profile `user-db:user` + `file-db:<abs path>` and a defaults database to one
      place for all users, `packages/gateway/dist/dconf/`, and `session-environment.ts` sets `DCONF_PROFILE` to it. dconf 0.40 (Ubuntu 24.04) supports `file-db:` and an absolute `DCONF_PROFILE`, so no
      root; `dconf-cli` isn't installed by default, so the database (GVDB) is written by our own
      code, checked against `dconf compile`'s output and read by libdconf/`gsettings`. `DCONF_PROFILE` is not in
      `dbus-update-activation-environment` (the bus is the user's, shared with their other desktops). For the install
      script: run `node dist/build-dconf.js` where nebula is installed (the profile holds the database's absolute path;
      a session refuses a profile naming another database); `toKeyfile()` gives a keyfile if dconf's own system
      databases are ever wanted. Checked in `decorations.sh`
      (gsettings in a session; screenshot of gtk4-demo: minimize, maximize, close) and unit tests
      (`nebula-settings.test.ts`); outside our sessions the user's value is still `'appmenu:close'`; compositor-proxy
      156, viewer 79, gateway 16 unit tests, `test-gateway.sh` 23 s; Chrome by hand). Was: **The desktop's defaults for apps that read GSettings** (GTK before 4.21 outside Flatpak, and Chrome through
      GTK: they don't use the Settings portal, see 4b). Supply `org.gnome.desktop.wm.preferences` `button-layout =
      ':minimize,maximize,close'` (Windows style, like our frames) to the apps of our sessions only, the standard way:
      a dconf profile (`DCONF_PROFILE` in the session's environment) whose first layer is the user's own database
      (`user-db:user`, so whatever the user set explicitly still wins, and writes go there as usual) above a nebula
      defaults database. Rules:
      - Don't change the user's own settings (no `gsettings set`/`dconf write` of their database) and nothing
        machine-wide (`/etc`, `/usr/share/glib-2.0/schemas` overrides): the user's other desktops on the same machine
        must be unaffected.
      - First find out whether the defaults database can live outside `/etc/dconf/db` without root (dconf profiles'
        `file-db:` line, and the dconf version on Ubuntu 24.04; `dconf compile` builds the database). If it needs a
        system install step, implement what's possible, document the step for the install script (Lower priority
        item: install script), and say so.
      - Keep nebula's desktop settings (the button layout now; the color scheme later) in one place in the code, so
        the portal backend (step 4) serves the same values.
      - Verify: inside a session, `gsettings get org.gnome.desktop.wm.preferences button-layout` (with the session's
        environment) gives `':minimize,maximize,close'`; gtk4-demo shows minimize, maximize and close (an e2e check
        if cheap: gtk4-demo is optional in `decorations.sh`); by hand Chrome. The user's own value outside our
        sessions is still `'appmenu:close'`.
   4. **Partly done (2026-10-05):** dark mode and the accent for GSettings and KDE apps (dconf defaults, a
      `kdeglobals` layer, `QT_QPA_PLATFORMTHEME=kde`; see DESIGN.md "Apps follow the theme"). Defaults only: the
      user's own settings always win. **Waits for the install script:** the nebula Settings backend for `xdg-desktop-portal` from 4b (for Flatpak
      apps, GTK 4.21 and newer, Qt), serving the same values. `xdg-desktop-portal` 1.18 finds backends' `.portal`
      files only in `/usr/share/xdg-desktop-portal/portals` or `XDG_DESKTOP_PORTAL_DIR`: an install-script step.
   - For the agent: name anything new "nebula" (never "greenfield"); tests under a minute, on spare ports
     (`GATEWAY_PORT`); never kill processes by name; never read `human_notes.txt`. To try it by hand the user restarts
     the gateway and starts a new session (protocol 14).

### First extra feature

5. **Audio playback** (see [Audio](#audio-playback-only)); add the taskbar mute toggle. **Done** (scene protocol 15).
   - Server: each session starts its own `pipewire`, `pipewire-pulse` and `wireplumber` (`gateway/src/audio/`), with a
     null sink `nebula` as the default output and no hardware. **Isolation**: every socket lives in the session's own
     directory `$XDG_RUNTIME_DIR/nebula-audio-<session pid>` (mode 0700; `PIPEWIRE_RUNTIME_DIR`, `PULSE_RUNTIME_PATH`),
     the daemons run with our own static configuration (`dist/audio-config`, generated by the build;
     `XDG_CONFIG_HOME` points there, `XDG_STATE_HOME`/`XDG_CACHE_HOME` into the session directory), with no D-Bus
     (an address that goes nowhere; WirePlumber's ALSA/V4L2/libcamera/bluetooth parts are disabled, so there is no device
     reservation either), all started and stopped by their PIDs (`setpriv --pdeathsig` if the session process dies
     without cleaning up). Apps get `PIPEWIRE_RUNTIME_DIR`, `PULSE_RUNTIME_PATH` and `PULSE_SERVER=unix:<dir>/native`
     even when our daemons failed to start (silence is better than the user's speakers), and these are not given to
     `dbus-update-activation-environment`. Notes for PipeWire 1.0.5 / WirePlumber 0.4.17 are in
     `audio/pipewire.ts` and `audio/config.ts` (the core needs `module-access`, or no client sees the graph;
     WirePlumber exits without a session bus unless the Flatpak portal check is off; with `XDG_CONFIG_HOME` set it
     finds our files first and the system's `/usr/share/wireplumber` for the rest).
   - Capture: `gst-launch-1.0 pulsesrc device=nebula.monitor ! ... ! opusenc audio-type=generic bitrate=112000
     frame-size=20 ! rtpopuspay ! rtpstreampay ! fdsink` as a child process (RTP carries the packet boundaries,
     sequence numbers and timestamps), only while a viewer is attached and unmuted: no capture, no encoding otherwise.
     A crashing capture is restarted (up to 5 quick failures); missing programs or crashing daemons are logged and the
     session simply has no audio (`audio.state` tells the viewer).
   - Protocol 15: the AUDIO envelope (kind 6: u16 seq, u32 timestamp at 48 kHz, Opus packet), `audio.state` (server)
     and `audio.mute` (viewer; a session sends nothing until the viewer says `muted: false`, which it does first thing
     after connecting). Audio has control priority: written to the socket at once, ahead of frames and patches, not
     acknowledged and not counted by the congestion controller (about 14 KB/s). Unlike control messages it is dropped
     (not queued) while more than 128 KB sit in the socket's buffer, so it never gets later and later.
   - Viewer: `viewer/src/audio/`: WebCodecs `AudioDecoder` -> `AudioWorklet` with the jitter buffer (`jitter-buffer.ts`,
     pure and unit tested: 160 ms target (was 70, 5ef434a), +-0.1% linear-interpolation rate following the smoothed level, 3 ms fade out
     before running dry, rebuffer, 3 ms fade in, backlog over 360 ms dropped with a 5 ms crossfade). The audio context
     is created on the first pointer or key event (the sign-in click), and the viewer tells the server it is muted until
     it runs. The taskbar's mute toggle (right side, left of the connection indicator) is remembered in localStorage and
     sent on every (re)connection. Test hook: `window.__viewerTest.audio()`.
   - Tests: viewer 96 (was 79: jitter buffer 9, protocol 8), compositor-proxy 160 (was 156), gateway 28 (was 17),
     new `scripts/e2e/audio.sh` (tone in a session app, decoded in the browser, mute/unmute, reload, isolation with and
     without a user PipeWire running, cleanup at logout; 5-10 s); `test-gateway.sh` about 22 s.
   - Not verified by ear (needs the user): sound quality, clicks at underruns, drift over a long listen, recovery after
     a network hiccup, real apps (Firefox/Chrome video), and Chrome's behavior on a machine with real audio output.

### Done: QOI patches and lossy encoding (phases 1 to 3)

5b. **QOI instead of PNG for patches** (user's request, 2026-10-05; the design is in [Encoding
    policy](#qoi-patches-and-lossy-encoding-only-when-bandwidth-is-short)). Today every patch is a PNG from our
    own encoder (`compositor-proxy/src/encoding/png.ts`), which hogs the CPU. QOI (https://github.com/phoboslab/qoi,
    MIT, one header) and LZ4 (BSD) are owned in the codebase (vendored with their licences, not dependencies).
    1. **Done: the spike** (Sonnet, branch `worktree-agent-a1e5c33d5ee632214`, `spike/qoi/results.md`; not merged, its
       patch recorder in `SurfaceEncoder.ts` must never be merged). 1032 real patches (foot, xterm, GTK 4 apps, Chrome
       in the session, the busy client). Encode CPU per 1080p frame: our PNG 75–83 ms on UI content and 145 ms on
       noise; libpng 43–58 / 131 ms; QOI 3.3–4.1 / 17.5 ms; QOI + LZ4 3.5–4.8 / 26.5 ms; QOI + deflate 1 5.3–10 / 66
       ms. Bytes as a share of our PNG: QOI 1.5x on text, 1.1x GTK, 2.9x Chrome, 2.9x noise; QOI + LZ4 0.69x, 0.90x,
       0.77x, 2.28x; QOI + deflate 1 the smallest but its browser decode (`DecompressionStream`, ~0.4 ms per call) is
       slower than PNG's. Browser decode per 64k-pixel tile: PNG 0.66 ms, QOI + LZ4 in wasm 0.27 ms, QOI in plain JS
       0.37 ms. All patches round-trip exactly. The wasm decoder (QOI into a caller buffer + LZ4) is 2.1 KB.
    2. **Done.** **Phase 1: replace PNG with the QOI cascade** (raw / QOI / QOI + LZ4, one-byte format tag; see Encoding policy) for
       every patch of every surface, no PNG fallback for patches and no special cases.
       - Encoder: native C (QOI + LZ4) in compositor-proxy's CMake project, called synchronously from worker threads
         (the streaming class's already run at low priority; the normal class keeps its own). Opaque detection as in
         Encoding policy (format, opaque region, else an alpha scan folded into the copy in `readPixels`). Later,
         possibly: encode straight from the wlroots buffer without a JS copy.
       - Decoder: wasm built with plain `clang --target=wasm32` and `wasm-ld` (package `lld`, a new build requirement),
         no Emscripten and no libc (the spike's `qoi_wasm.c`/`lz4_wasm.c` show how). It runs in a Web Worker (wasm on
         the main thread would stutter the UI): raw/QOI/QOI + LZ4 → `ImageData` → `createImageBitmap`, the bitmap
         transferred to the main thread.
       - PNG stays only for images that aren't surfaces (an X11 app's `_NET_WM_ICON` window icon, read from an X
         property and sent as a data URL); `png.ts` and `png-worker.ts` otherwise go. Protocol version bump.
       - Afterwards, check the encoding policy's tuning (pool sizes, the relentless thresholds), measured with PNG's
         costs. **Done (2026-10-05):** left as they are (the user found them good). `scripts/e2e/cpu.sh` again: busy
         client 9.5 s of CPU in 10 s, 5416 patches, 1.76 ms per patch; foot 1.3 s, 0.72 ms per patch; the 1080p busy
         client is still promoted (busy.sh).
       - Status (built 2026-10-05, scene protocol 16): `native/patch` (`nebula-patch-addon`, QOI + LZ4 vendored with
         their licences in `native/patch/vendor`) encodes synchronously; `PatchWorkerPool` (was `StreamingPngPool`,
         `patch-worker.ts` was `png-worker.ts`) runs it on 2 worker threads at nice 19 for the streaming class and on 4
         at nice 0 for the normal class (replacing libuv's pool; the scheduler, slots and ordering are unchanged).
         `readPixels` (wlr-core) returns `{ pixels, opaque }` in a transferable `ArrayBuffer`: opaque if the format has
         no alpha, or the rectangle is inside `wlr_surface.opaque_region` (only for scale-only surfaces: no transform,
         no viewport), else if the alpha scan folded into the copy finds every alpha byte 255. The patch envelope
         carries `u8 format` (`PatchFormat`: RAW 0, QOI 1, QOI + LZ4 2; 3 and 4 are left for JPEG and JPEG with alpha)
         and `u8 channels` after the rectangle. The viewer's `patch/patch-worker.ts` (Web Worker) decodes with the
         2.1 KB wasm module (`wasm/*.c`, built by `packages/viewer/scripts/build-wasm.mjs` as part of `yarn build`,
         with `clang` and `wasm-ld` from `lld`; the bytes go into the generated, uncommitted `src/patch/wasm-bytes.ts`)
         into `ImageData` -> `createImageBitmap(.., { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })`, as
         the PNG path did, and posts the bitmap back. The gateway's CSP gained `'wasm-unsafe-eval'`. `png.ts` keeps
         only `encodePng` (window icons). Measured with the new opt-in `scripts/e2e/cpu.sh` (session process CPU over
         10 s, no GPU, 1080p busy client / foot printing text): the busy client 17.3 s of CPU (1905 patches, 9.1 ms per
         patch) -> 8.9 s (5600 patches, 1.6 ms per patch, three times the throughput); foot 8.0 s (4.8 ms per patch)
         -> 1.5 s (0.8 ms per patch). Tests: compositor-proxy 169 (was 160: cascade branches with exact round trips
         for 3 and 4 channels, the pools, the opaque flag), viewer 113 (was 96: the wasm decoder against the real
         encoder for all three formats, the protocol), gateway 28; `test-gateway.sh` about 23 s (checks that foot's
         patches arrive opaque and decoded in the worker). Not covered by a test: the opaque-region path of
         `readPixels` (needs a client that sets an opaque region; the format and scan paths are exercised by foot and
         the busy client).
    3. **Done.** **Phase 2: the four cases for the streaming class** (Encoding policy): the bandwidth-limited signal from the
       controller; not limited: QOI patches (no GPU) or higher-quality video (GPU); limited: JPEG / JPEG with alpha
       patches (no GPU) or lower-quality video (GPU); fixed-quality video with variable bitrate; per-area lossy
       tracking and intelligent lossless refreshes; alpha >= 254 opaque in the shared shader. Also remove video on CPU
       only (x264 and its CPU alpha path).
       - Status (built 2026-10-05, scene protocol 18; details under "As built" in [Encoding
         policy](#qoi-patches-and-lossy-encoding-only-when-bandwidth-is-short)): `PatchFormat.JPEG` (3) and
         `JPEG_ALPHA` (4: u32le length of the color JPEG, the color JPEG, a grayscale JPEG of the alpha;
         `splitJpegAlpha`). `nebula-patch-addon` links the system's libjpeg-turbo (`libjpeg-dev`, a new build
         requirement) and takes a JPEG quality (`encodePatch(rgba, w, h, opaque, lossy)`); `viewer/bandwidth.ts`;
         lossy areas and refreshes in `SurfaceEncoder`; constant-QP hardware video with `setQuality`; x264 and the CPU
         video path deleted. New dev-only gateway option `--dev-link-kbps <n>` (with `--dev-auth`): the session sends
         to its viewer through a simulated link of n kbit/s (a FIFO in the transport), to try this by hand.
       - Tests: compositor-proxy 190 (was 170: the monitor's rules and the monitor with the real controller on the
         simulated link, 11; lossy patches, refreshes and video quality in `SurfaceEncoder`, 5; JPEG encoding, 4),
         viewer 123 (was 116: the formats and `splitJpegAlpha`; 4 jitter-buffer tests fail since 5ef434a, unrelated),
         gateway 32. New `scripts/e2e/lossy.sh` (about 11 s): the busy client on an 8 Mbit/s simulated link becomes
         streaming, the link limited, JPEG patches arrive; paused, bandwidth recovers and the viewer shows its last frame
         exactly. `video.sh` also feeds a JPEG and a JPEG with alpha (made by the page) and checks their pixels and that
         near-opaque alpha comes out 255. `test-gateway.sh`: 13 scripts, about 25 s.
       - Not verified: the GPU half (no GPU here: whether nvh264enc and vaapih264enc take a QP change while playing, and
         the QPs' look); a real slow link (only the simulated one); real apps with transparency as JPEG with alpha (only
         the page-made test images).
    4. **Done.** **Phase 3: fast mode for bursts, and settling at the lowest priority** (user's design, agreed
       2026-10-05).
       - Status (built 2026-10-05, no protocol change; details under "As built" in [Encoding
         policy](#qoi-patches-and-lossy-encoding-only-when-bandwidth-is-short)): as designed below, plus (user's
         follow-up) frame callbacks no longer wait behind settling (`readyForFrame`), and never more than 100 ms
         (`MIN_FRAME_RATE` 10: a slow repaint may tear, the app stays responsive). The bytes-per-pixel estimate moved
         to `SurfaceEncoder`; `BandwidthMonitor` lost its
         lossless-demand measure and takes the predicted backlog; `EncodingSink` gained `linkBandwidth` and
         `queuedBytes`, `sendPatch` takes a tier; the transport's patch messages carry `tier`.
       - Tests: compositor-proxy 199 (the minimum frame rate; burst promotion order and its first patches lossy, none before the link was
         limited, the estimate, settling at the lowest tier while still limited, pre-empted by damage, re-settling
         damage that went lossy, demotion only once settled, the 9 : 3 : 1 tiers and a settling patch waiting in its
         damage's tier, the monitor's backlog trigger, exit and remembered bandwidth). `lossy.sh` (about 17 s) also
         runs the busy client's new page mode (1200x660 of text-like glyphs on a faintly textured background): after
         the link was limited once, its first paint is a burst (JPEG), settled and demoted; scrolled, it is promoted
         again and JPEG arrives about 130 ms after the first scroll frame (polling included); stopped, it settles,
         is demoted, and the viewer shows its last frame exactly. `test-gateway.sh`: about 27 s.
       - Tuning knobs: `BURST_MS` (200), `MIN_FRAME_RATE` (10), the settle quantum (a third of streaming's).
       - Not verified: real apps (foot, a browser) scrolling on a real slow link; with a GPU (a burst starts video).
       The problem: scrolling a static page on a slow link is very slow for the first seconds. The surface is normal
       (lossless, medium priority) until the relentless measure promotes it (1.5–2.25 s), and the link only counts as
       bandwidth-limited after two held-back periods. Then, once quiet, the lossless refresh of its lossy areas runs at
       normal priority and competes with the normal surfaces.
       - **Per-surface compression estimate**: each surface keeps a rolling average of its lossless bytes per pixel
         (pixel-weighted, from its lossless patches: text and UI look like text and UI, noise like noise). It lives in
         the encoders (it's in the transport's `BandwidthMonitor` today) and pauses while the surface goes lossy (its
         settle patches update it again). A surface without one counts as uncompressed (3 or 4 bytes per pixel).
       - **Predicted backlog**: per surface, its bytes waiting in the transport (encoded, real size), plus its pixels
         being encoded or queued times its estimate. In time: bytes / the bandwidth estimate (`max_bw`), only once the
         link has been bandwidth-limited at least once on this connection: that estimate is remembered from then (before,
         an app-limited estimate is only a lower bound, so nothing below applies). Threshold `BURST_MS` = 200 ms
         (tunable). Settling work (below) never counts.
       - **Burst promotion** (a second way to become streaming, besides the relentless measure): while the predicted
         backlog of the normal surfaces alone is over `BURST_MS`, promote the normal surface with the largest predicted
         backlog, and check again. Streaming surfaces don't add to the pressure to promote.
       - **Lossy mode (bandwidth-limited) is either/or**: the link is saturated (the held-back measure as built: two 1 s
         periods in a row held back >= 80%), or the predicted backlog of all surfaces (normal and streaming) is over
         `BURST_MS`, which takes effect at once (a scroll's first frames go out as JPEG). It ends only when both are quiet:
         a period held back < 50%, the total predicted backlog under `BURST_MS` (this replaces the lossless-demand check),
         at least 2 s after it began. So streaming surfaces don't push to promote others, but they do keep the link in
         lossy mode while they have a backlog.
       - **Settling, per streaming surface, as a priority queue**: damage first (lossy while bandwidth-limited); when it
         has no damage queued or in its slots, it settles its lossy areas losslessly (never lossy, whatever the link).
         New damage pre-empts settling: settle rectangles it covers are dropped (the damage replaces them), the rest
         wait. As built, the lossy areas are updated in send order, so this holds.
       - **A third send tier for settling**: settle patches go out in their own class of the transport's deficit
         round-robin, at a third of the streaming class's quantum (normal 3 x 16 KB, streaming 16 KB, settling about
         5.3 KB per turn; work-conserving as before: an idle tier's share goes to the others). Within the tier,
         surfaces take turns as in the others.
       - **Demotion** (streaming -> normal) only when the surface has no damage, nothing lossy left (fully settled), and
         its backlogged share of the last period is under `DEMOTE_FRACTION` (15%), where a streaming surface's busy and
         backlogged time counts damage work only, not settling. (Today the refresh only starts after demotion or
         recovery, at normal priority.)
       - Small relentless surfaces still need the relentless (time) measure: a small video saturating the link never
         has a big backlog at once. The two promotion criteria cover the two cases: a relentless stream of any size
         (time) and a single large repaint (backlog).
       - With a GPU, a burst-promoted surface starts video with a key frame like any promoted one (accepted).
       - Tests: unit (the estimate, the predicted backlog, burst promotion order, lossy mode either/or and its exit,
         settling pre-empted by damage, the third tier's share, demotion only when settled); e2e: on the 8 Mbit/s
         simulated link, after the link was limited once, a static page (foot full of text, say) scrolled: JPEG patches
         within a few hundred ms, then settled losslessly at the lowest tier and demoted; the viewer ends up exact.

### Lower priority

5c. **System tray (StatusNotifierItem host).** Apps like JuK, Discord, Steam, chat clients and network/Bluetooth applets
    put an icon in "the system tray" and keep running when their window closes. On a Linux desktop the tray is a
    freedesktop/KDE D-Bus protocol, not Wayland: apps register their `org.kde.StatusNotifierItem` with a
    `org.kde.StatusNotifierWatcher`, and the panel registers as a `StatusNotifierHost` and draws the icons. Today
    `kded5` (D-Bus activated by KDE apps) provides a watcher but nothing hosts, so Qt reports a tray and apps "dock"
    into one nobody draws: JuK, closed, keeps running (and playing) invisibly, reachable only by launching it again.
    - The session process provides the watcher (if none is on the bus) and registers as the host, like it serves
      `org.freedesktop.Notifications`; it forwards the items to the viewer over the session WebSocket.
    - The viewer shows each item's icon (`IconName` through the XDG icon theme like other icons, or `IconPixmap` data)
      in the taskbar's tray area, left of the mute toggle, with its `ToolTip`; `Status: Passive` items are hidden,
      `NeedsAttention` uses its attention icon.
    - Clicks: left click `Activate(x, y)` (usually shows/hides the window), middle click `SecondaryActivate`, wheel
      `Scroll`. Right click (or `ItemIsMenu`) shows the item's menu, read from its `com.canonical.dbusmenu` object
      (labels, enabled, toggles/radios, separators, submenus), as one of our own animated context menus; choosing an
      entry sends the dbusmenu `Event` "clicked". `ContextMenu(x, y)` only for items without a dbusmenu.
    - Legacy XEmbed tray icons (old X11 apps) are not supported.
    - e2e: a small test item (e.g. a Python/GDBus script) registering an icon and a menu; check the icon shows, a
      click activates, a menu entry is delivered, and the icon goes when the item's bus name goes.

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
   - **The viewer's layout runs ahead of the server's, for long stretches** (tricky, needs care to cover every case):
     moves and resizes are only sent when the drag ends, so during a drag the server's positions and sizes are stale,
     and its idea of what covers what is wrong. A window being dragged (or stretched while resizing) reveals parts of
     the windows it covered, and covers others; the same goes for the minimize, restore and maximize animations and
     for windows following a dragged parent. If the server held back damage for regions it thinks are hidden, the
     viewer would show stale content there (or nothing, for a surface never sent). Likely approach: the viewer tells
     the server when an interaction or animation starts and ends. On start, the server recomputes visibility with the
     windows involved occluding nothing (and not considered occluded themselves), and immediately sends the damage
     accumulated in every region that is no longer guaranteed hidden: the drag may uncover any of it from the very
     first frame (a window moved or shrunk away from what it covered). While it runs, those regions get updates as
     usual. On end, the server recomputes with the final layout, and regions hidden again start accumulating. Cases to
     check: drags, resizes (stretched content), the window menu's Move/Size, animations, dialogs moving with their
     parent, a viewport shrink moving windows, stacking changes from a click, a second viewer taking over mid-drag.
     Probably a fork, not a Sonnet task.
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
    is manual (see `packages/gateway` docs). Must run `node packages/gateway/dist/build-dconf.js` in the installed tree
    (regenerates the dconf profile with the installed path, see 4c step 3). New package dependencies from audio (item
    5): `pipewire`, `pipewire-pulse` and `wireplumber` (Ubuntu 24.04: PipeWire 1.0.5, WirePlumber 0.4.17; WirePlumber
    0.5 has another configuration format), `gstreamer1.0-pulseaudio` (`pulsesrc`), `gstreamer1.0-plugins-base`
    (`opusenc`, `audioconvert`) and `gstreamer1.0-plugins-good` (`rtpopuspay`, `rtpstreampay`), `util-linux`
    (`setpriv`). New build requirements from the QOI patches (item 5b): `clang` and `lld` (`wasm-ld`, for the viewer's
    wasm patch decoder; the build fails with "install lld (apt install lld)" if it is missing), and from item 5b
    phase 2 `libjpeg-dev` (libjpeg-turbo, for JPEG patches; at run time `libjpeg-turbo8`). The audio configuration is generated by the build (`dist/audio-config`), nothing else to install. Must
    not enable or touch the user's own PipeWire units. Could later also enable kernel BBR (see
    [Transport and congestion control](#transport-and-congestion-control)); not for now, to keep installation simple.

14. **Two-factor sign-in via PAM prompts** (lowest priority of all). Only makes sense once the core infrastructure is
    verified sound and free of vulnerabilities.

### Needs verification on other hardware

- Real PAM sign-in (needs root).
- GPU (dmabuf) buffers on a machine with a GPU.
- GPU acceleration path of Core 2: `--encoder auto` picking `vaapih264`/`nvh264`, and streaming surfaces sent as
  hardware video (key frame on promotion, crisp patch render on demotion, video frames in slots). Only unit tested.
- Item 5b phase 2's video: constant QP (`QP_HIGH` 24, `QP_LOW` 32) on nvh264enc and vaapih264enc, and whether they take
  a QP change while playing (`setQuality`); if not, the pipelines have to be rebuilt on a change.
- Lossy encoding on a real slow link (only the simulated `--dev-link-kbps` one is tested): when it goes lossy, how JPEG
  at quality 70 looks, how often it flaps; phase 3's bursts and settling with real apps scrolling.
- Congestion control on real links: slow, distant (100-300 ms), Wi-Fi and mobile. Only the simulated link and
  loopback are tested.
- Congestion control sharing a bottleneck with other traffic (a download filling the router's buffer). Not in the
  simulated scenarios; the possible failure would be periodic throughput dips about every 10 s (the competing queue
  raising the measured base delay until it looks like a path change).
- A real game rendering on the CPU (llvmpipe) as a streaming surface: no GL app is installed on the development
  machine, so only the synthetic busy client was measured.
- Firefox: whether a mouse back button over the desktop is fully blocked.

### Known issues

- Pinning two apps in quick succession once left only one pinned; not reproduced since.
- By design, a single busy surface that the server keeps up with stays normal, so its encoding runs at normal
  priority (one 640x480 busy client alone: about 42% busy, about 85% of a core). Larger ones cross the 60% line
  (1920x1080: promoted); somewhere around 1280x720 is the border. `PROMOTE_FRACTION` is the knob if this matters.
- Input on a Wayland subsurface or popup the app just moved (`wl_subsurface.set_position`, `xdg_popup.reposition`)
  can land off by the move for about a round trip: the viewer picks the surface and computes surface coordinates from
  the positions in the last scene it has. Not seen with a real app (they rarely move subsurfaces in response to the
  pointer; the X11 version of this, a window dragging itself, is fixed: the core uses X11's own window position). Fix
  if it shows: send coordinates relative to the window's main surface and let the core find the surface under the
  point in wlroots' current surface tree (`wlr_xdg_surface_surface_at`), as a local compositor does.
