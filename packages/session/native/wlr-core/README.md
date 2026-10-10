# wlroots core

A session's Wayland side on wlroots 0.17.4. It replaced the libwayland fork and the TypeScript protocol implementation
(deleted in wave 2 C of the migration, ARCHITECTURE.md): every session runs on it, with the desktop shell.
Since wave 2 B, X11 apps run too (XWayland).

## Layout

- `native/wlroots`: the wlroots submodule, pinned to the 0.17.4 tag (`git submodule update --init`). CMake builds it
  with meson as a static library (headless backend only, no session, with XWayland) against Ubuntu 24.04's packages,
  as part of the normal build. It's rebuilt from scratch when its meson options (`WLR_MESON_OPTIONS` in
  CMakeLists.txt) change, otherwise only when `build/wlroots/libwlroots.a` is missing: delete `build/wlroots` after
  changing the submodule.
- `native/wlr-core/src/wlr_core.c`: the wiring, as a Node addon (`wlr-core-addon.node`). wlroots implements the
  protocols; the addon reports clients (with their pid), surfaces, commits (buffer damage, input region), toplevels and
  their requests, and cursors to JavaScript, and takes input, configures and frame callbacks from it.
- `native/wlr-core/src/wlr_core_xwayland.c`: X11 apps. wlroots' XWayland (an X11 display per session, Xwayland
  started when the first X11 app connects) and its X11 window manager. Managed X11 windows are reported like xdg
  toplevels (`toplevel-new(sid, x11 = true)`, title, WM_CLASS as app id, WM_TRANSIENT_FOR as parent, move, resize,
  maximize, fullscreen and minimize requests), so the policy is the same for both; override-redirect windows (menus,
  tooltips) are surfaces of the window they belong to, at their X11 position relative to it (popups of it, see the
  scene protocol). `setPosition` tells X11 apps where the scene shows their windows; a shown window's own configure
  requests are granted, position included (`toplevel-request-position`: apps that drag themselves with XMoveWindow or
  place themselves move, as under other X11 window managers; the viewer still has the last word while the user drags
  or resizes the window). `wlr_core_internal.h` is what it shares with `wlr_core.c`.
- `native/wlr-core/src/wlr_core_clipboard.c`: the clipboard bridge (wave 3 E). A remote app's selection is read through a
  non-blocking pipe on the `wl_event_loop` (text mime types in the order text/plain;charset=utf-8, UTF8_STRING,
  text/plain, TEXT, STRING; at most 4 MB, 3 s) and reported as `clipboard-text`; `setClipboardText` makes the browser's
  text the seat's selection through a server-side `wlr_data_source` (its `send` writes without blocking). The
  primary selection stays between remote apps (browsers have none).
- `native/wlr-core/src/wlr_core_dnd.c`: drag and drop (wave 3 E). Between remote apps: `request_start_drag` becomes a
  seat pointer drag, the icon surface is reported (`drag-start`, `drag-icon`, `drag-end`). Files from the user's
  computer: a drag of ours with a `text/uri-list` source (`startFileDrag`, `fileDragAccepted`, `dropFileDrag`,
  `cancelFileDrag`, `provideFiles`), driven by `src/wlroots/FileDrops.ts`.
- Decorations (Core item 4): `xdg-decoration` (`wlr_xdg_decoration_manager_v1`, in `wlr_core.c`) answers a decoration
  object with the mode the app asked for if that's client side (Chrome with its own title bar), server side otherwise
  (foot, Qt; also when the app has no preference), and X11 managed windows are decorated unless `_MOTIF_WM_HINTS` has no title
  (`wlr_core_xwayland.c`); both emit `toplevel-decorated(sid, decorated)`. The viewer draws the frame, the policy
  (`WlrCompositor.ts`) subtracts it when maximizing and centering dialogs.
- xdg-shell is version 6 (Core item 4b): `setBounds(sid, w, h)` sets a toplevel's configure bounds (the policy sends
  the output minus our frame from the first commit on; false before that); wlroots advertises its default
  `wm_capabilities` (window menu, maximize, fullscreen, minimize), and `show_window_menu` is reported as
  `toplevel-request-window-menu(sid, x, y)` (main surface coordinates), which the viewer answers with our window menu.
  The `suspended` state isn't used.
- `native/wlr-core/src/xwayland_sockets.c`: replaces wlroots' `xwayland/sockets.c` at link time (see the gotchas).
- Video encoding isn't in this addon: the GStreamer encoder is the video codec's (`packages/video-codec`, its own addon
  with its EGL and dmabuf helpers), which reads frames that `takeFrame` hands out.
- `src/wlroots/WlrCompositor.ts`: the policy, like the TypeScript compositor's `server/scene.ts`: window positions,
  stacking, activation and keyboard focus, minimize, maximize, child windows centered on their parent, frame pacing,
  and one `Surface` (`src/surface`, rendering's view of it) per surface. It is both the `WindowSceneEndpoint` and the `SurfaceContent` of a `ViewerHost`.
  The native core is passed in (`WlrNative`), so `src/wlroots/test/` tests the policy against a fake core.
- `src/wlroots/X11.ts`: what's left for X11 windows on the TypeScript side: telling them their position when the scene
  moves them.
- `src/wlroots/Apps.ts`: the session's app processes: launched by the desktop shell (with the session's
  `WAYLAND_DISPLAY`, and `DISPLAY` for X11 apps), or connected on their own (from the client's credentials; a client of
  a launched app's child process belongs to that app). Ending the session sends them SIGTERM.
- `packages/session/src/session-process.ts`: the session process: `WlrCompositor`, `Apps`, the desktop shell
  (`shell/service.ts`), the session environment (`session-environment.ts`).
  `GFLD_WLR_TRACE=1` logs events and viewer messages; `GFLD_WLR_DEBUG=1` turns on wlroots' own debug log;
  `GFLD_XWAYLAND=0` turns X11 apps off.

## What was verified (headless Chrome through the gateway, `--dev-auth`)

Wave 1: `scripts/test-gateway.sh` passes on it unchanged (Apps menu, launching from it, pinning, taskbar minimize and
restore, maximize, notifications, typing, mouse back button as BTN_SIDE, reattach with identical pixels, viewer-side
resizing, logging out ends the apps), plus a check that the session really runs on wlroots. Unit tests for
`WlrCompositor` (fake core) and `Apps`.

Wave 2 B (X11), in `scripts/e2e/x11.sh` (part of `scripts/test-gateway.sh`, about 2 s) and unit tests (`X11.test.ts`):
xev maps as a desktop window with its title, launched from the Apps menu with the session's `DISPLAY`; X11 knows its
position (xwininfo agrees with the viewer); clicks and keys reach it; xfontsel's WM_CLASS is its app id (its taskbar
button is its desktop entry's, by `StartupWMClass`); one of its menus (override-redirect) shows with its window where
X11 has it, not as a window of its own, and closes when an entry is chosen; closing both from the taskbar
(WM_DELETE_WINDOW) ends them. By hand, gtk4-demo with `GDK_BACKEND=x11` (its own decorations): moving it by its title
bar (`_NET_WM_MOVERESIZE` → viewer interaction), its menu (override-redirect, attached to its button), Escape closing
it, the About dialog (WM_TRANSIENT_FOR: a child window centred on its parent, X11 told), maximize and restore from its
own buttons (`_NET_WM_STATE`), back where it was.

The prototype, by hand:

- foot: maps, placed by the viewer, typing `ls -l /` + Enter shows the output; click to focus; client-side decorations
  (subsurfaces) shown and clickable; cursors via cursor-shape-v1 (`text`, `default`, `e-resize`); resize by dragging
  its edge (xdg_toplevel.resize → viewer interaction → configure); maximize button (request → configure to the output
  size, placed at the output origin).
- gtk4-demo: maps with its client-side shadow and input region; its own cursor surface; its menu (xdg_popup, part of the
  window's surface list); the About dialog (`set_parent`, centered on the parent, stacked above it).
- Encoding (as of wave 1; replaced by Core 2a, see "Encoding policy" in ARCHITECTURE.md): small surfaces as patches, busy
  surfaces as H.264 (86 video frames while foot scrolled, with the viewer's pacing simulated); lazy patch capture
  unchanged (the buffer stays locked until the next commit).
- Reattach: closing the browser, signing in again and reopening the session brings back all three windows with a mean
  luma difference of 0.00.

## Gotchas found

- **Buffers**: wlroots unlocks `surface->current.buffer` right after the commit event, so the core locks it itself
  until the next commit (and video encodings lock it until the encoder is done, which delays the client's release like
  `whenIdle` does today). `current.committed` accumulates over commits, it doesn't say what this commit changed: a new
  buffer is detected by `current.buffer` being set.
- **No renderer**: `wlr_compositor_create(display, 5, NULL)` and `wlr_shm_create` with explicit formats: wlroots then
  doesn't copy shared memory buffers into textures. The headless output is enabled without `wlr_output_init_render`.
- **Re-entrancy**: events are delivered to JavaScript synchronously, and JavaScript calls back in (configure, focus).
  Flushing clients from inside an event can destroy a client in the middle of another client's destruction (a double
  free on app exit). The core doesn't flush while JavaScript handles an event; the outermost call flushes.
- **Event loop**: wlroots' `wl_event_loop` fd is polled with the existing poll addon (`dispatch()` when readable).
  wlroots schedules configures as idle sources, so every call from JavaScript ends with
  `wl_event_loop_dispatch_idle` + `wl_display_flush_clients`.
- **Frame callbacks**: wlroots sends none on its own; `wlr_surface_send_frame_done` sends all of a surface's pending
  callbacks, driven by the existing frame pacing (now `src/FramePacing.ts`, free of native code).
- **Keyboard state**: wlroots' xkb state is built from key events alone, so a key-up the viewer's page never sees (a
  browser shortcut, Alt+Tab) leaves a modifier held forever. The browser's `getModifierState()` is the truth instead:
  `syncModifiers` (before every input event) releases modifier keys the browser doesn't hold and sets modifiers it
  holds without a key in the mask (`wlr_keyboard_notify_modifiers` only notifies clients on a change);
  `releaseAllKeys` runs when the page loses focus or the viewer goes. A release of a key that's up (and a press of one
  that's down) is dropped, so a key released early isn't released twice. AltGr's modifier is whatever the keymap's
  `ISO_Level3_Shift` sets (Mod5 usually).
- **Build**: wlroots 0.17 with `-Db_ndebug=true` fails `-Werror` (variables only used in asserts), so it's built with
  `werror=false`. Its Wayland and X11 backends can't be disabled in 0.17; the addon links libwayland-client too
  (harmless).
- **Encoder**: `frame_buffer.user_data` belongs to the encoder (its reference count); the locked buffer travels
  alongside it.

- **The session process must not have `WAYLAND_DISPLAY` set** to its own display (wave 1): GStreamer's GL (in the
  encoder) then connects to it as a Wayland client of its own session. Apps get it when launched (`Apps`); the
  session's environment doesn't.
- **Activation when a window goes away** (wave 1): the prototype left nothing focused when the active window closed.
  Now a closed dialog gives the focus back to its parent, otherwise the topmost shown (not minimized) window gets it.

Clipboard and drag and drop (wave 3 E):

- **Selections are read lazily**: `set_selection` fires inside wlroots' dispatch, where the app's write end of the pipe
  is only sent at the next flush (the outermost call flushes), so the reader is an event source on the loop, not a
  blocking `read`. An app that never closes its end is dropped after 3 s; a newer selection cancels the reader.
- **No echo**: the browser's text is a `wlr_data_source` of our own (recognized by its `impl`), so `set_selection` for it
  isn't read back. `Clipboard.ts` also remembers the last text, so the same text isn't set twice.
- **Browsers**: writing the clipboard needs focus and often a gesture, reading needs permission. The viewer reads
  `navigator.clipboard.readText()` on Ctrl+V, Ctrl+Shift+V and Shift+Insert and holds the key events until the text
  is sent (key events behind it keep their order); a refused write is retried on the next input and when the page
  gets focus. Without `readText` it uses the `paste` event. Headless Chrome needs `clipboard-read` and
  `clipboard-write` granted (`scripts/e2e/browser-driver.js` does).
- **Drags and the pointer**: `wlr_seat_start_pointer_drag` clears the pointer focus and installs a grab; the existing
  `pointerMotion` (enter on a new surface, then motion) is all that moves the drag. While a drag goes on the viewer
  must name the surface under the pointer, not the one the press started on (`drag` message). A drag icon's
  `current.dx/dy` are per commit, so the offset is the sum over its commits.
- **The drop needs an accepted action**: `drag_handle_pointer_button` drops only if the app answered the enter with
  `accept` and `set_actions` (`source->accepted && current_dnd_action`), else the drag just ends. A drag of files
  therefore waits (`FileDrops.release`, up to 0.5 s) for the app before releasing the button.
- **Faked button**: a drag needs a pointer button held (`grab_button`, `button_count`). For files from the browser we
  start the drag and then notify BTN_LEFT pressed under the drag's pointer grab, which swallows it, so no app sees a
  click; the release goes the same way. `provideFiles` finds the source through `seat->drag_source`, which keeps it
  alive after the drop until the next drag.
- **Uploads**: the data source of a file drag keeps the receivers' pipes until the upload is complete
  (`provideFiles`), so a big upload delays the app's read of the drop, not the session. Files are saved in
  `$XDG_CACHE_HOME/greenfield/drops/<random>/` (default `~/.cache`; the e2e scripts point it into their work
  directory), 2 GiB and 1000 files at most per drop, and directories older than a day are removed when a session
  starts. Apps that can't read the user's cache directory (some sandboxes) can't take the files.
- **Tests**: foot sets the clipboard through OSC 52, which needs no wl-clipboard here; `scripts/e2e/dnd-client.c` is a
  Wayland client built by `dnd.sh` (gcc, wayland-scanner, wayland-protocols).

XWayland (wave 2 B):

- **X11 sockets**: wlroots 0.17 insists on creating `/tmp/.X11-unix/X<n>`. That fails on WSL (WSLg mounts the
  directory read-only); on a multi-user server where the directory doesn't exist yet, wlroots creates it 0755, owned by
  the first session's user, so other users' sessions can't create theirs; and it unlinks the path before binding,
  which removes a live X server's socket that has no lock file (WSLg's `:0`). `xwayland_sockets.c` replaces wlroots'
  file at link time (the archive member isn't linked when all its symbols are defined already; keep its three
  functions' signatures in sync with `native/wlroots/xwayland/sockets.h`). It uses the abstract socket (what X11
  clients on Linux try first), skips displays someone serves (a live lock file, a socket file someone listens on, the
  abstract name), creates the filesystem socket in `/tmp/.X11-unix` only if it may, else in `$XDG_RUNTIME_DIR` (Xwayland
  wants two listening sockets), and removes its lock file and socket when the process exits (the session process
  exits without tearing wlroots down). That needs a real exit: logging out used to kill the session process with a
  second SIGTERM (its handler was `once`), so it now handles every SIGTERM/SIGINT. A stale lock (a killed session) is
  reclaimed by the next session that tries that display.
- **Surface destruction order**: wlroots emits the surface's destroy signal before its addons are finished, so our
  surface's destroy listener runs before XWayland dissociates the X11 window from it. The core reports
  `toplevel-destroy` from its own destroy listener (`x11_surface_destroyed`), before `surface-destroy`.
- **Positions**: X11 windows have absolute positions, which X11 apps use for their menus and tooltips and for pointer
  coordinates. The scene's position of each X11 window is sent with `setPosition` when it changes; an override-redirect
  window is shown relative to its owner by the difference of their X11 positions, so they agree either way.
- **Override-redirect owners**: X11 doesn't say which window a menu or tooltip belongs to. The core picks, when it maps:
  the window it's transient for (some toolkits set it), else the X11 window under the pointer, else the one with the
  keyboard focus, else the app's (same pid) topmost window. One that moves by itself reports `x11-geometry`.
- **_NET_WM_STATE**: xwm stores what an app asks for (maximize, fullscreen) in its own copy before telling us; a
  configure without changes (how the policy answers a request it doesn't grant) writes back the state we gave. State
  isn't written to windows that are unmapped (going away): the policy deactivates a closing window.
- **Harmless X11 errors**: closing an app logs a few `xcb error: op 18/19 ... code 3` (BadWindow): wlroots' own
  UnmapNotify handler writes WM_STATE to a window the app already destroyed. Sway logs the same.
- Xwayland falls back to shared-memory buffers here (no linux-dmabuf global, no GPU); its `libEGL warning` /
  `ZINK` lines in the session log are that fallback. Without a compositing manager GTK draws no client-side shadow under
  X11, so an X11 window is exactly its X11 window (geometry 0, 0, width, height). xev doesn't set WM_CLASS.

### Video encoder (`packages/video-codec/native/src/gst_frame_encoder.c`)

Since Core 2a the encoder is only used with GPU acceleration (`--encoder nvh264|vaapih264`, or `auto` finding one) and
only for streaming surfaces (see "Encoding policy" in ARCHITECTURE.md). With `--encoder none` (what `auto` resolves to
without a GPU) no encoder is ever created and everything is sent as patches. Since item 5b phase 2 there is no video on
the CPU at all: the x264 encoder, its CPU pipelines (`videoconvert ! videobox ! x264enc`) and the CPU alpha path are
gone. None of the following is tested here (no GPU).

- **One path.** Every buffer (shared memory or dmabuf) takes the GL pipelines: glupload, glshader (padding and alpha
  extraction), glcolorconvert, (gldownload), the encoder. They're created at warm-up.
- **Fixed quality, variable bitrate**: constant QP, no bitrate cap (nvh264enc `rc-mode=constqp`, `qp-const`;
  vaapih264enc `rate-control=cqp`, `init-qp`). Two levels, `QP_HIGH` and `QP_LOW` at the top of the file:
  `setQuality(encoder, high)` (TypeScript: `H264Encoder.setQuality` of `@nebula/video-codec`, called by the surface's `VideoRenderer` before each frame:
  low while the transport says bandwidth is short) sets the encoder element's QP property while it runs (the element is
  named `encoder` in every pipeline) and forces a key frame. Whether these encoders pick up a QP change while playing
  is unverified (on hardware): if they don't, the pipelines have to be rebuilt on a change.
- **Padding is at the top left**: the image is in the bottom right corner of the coded frame (the viewer's renderer
  crops with `encodedSize`), done in the shader. The shader's output size is set by the appsrc pad probe before the
  caps of a new size reach it. Padding is black (alpha 0 in the alpha stream); coded sizes are multiples of 128.
- Encoded frames are matched to their results on the pipelines' threads: the result queue has a mutex, and
  `has_split_alpha` is set before the first buffer is pushed (a fast encoder could race it).
- (Back when it had the x264 path:) checked with a scratch C harness around `do_gst_frame_encoder_*` and `openh264dec`:
  the decoded frame has the image bottom right, alpha ramp and padding right, delta frames decode, and a size change
  mid-stream starts a new SPS (openh264dec in gst drops one frame there; the browser doesn't). The e2e used to check that the viewer
  decodes foot's video frames without failures (`__viewerTest.videoFrames()`); since Core 2a it runs with
  `--encoder none` and checks patches instead, so the viewer's video decoding is only covered by its unit tests.

Wave 3 D (polish):

- **Fullscreen**: `toplevel-request-fullscreen` is answered with a configure to the output size (and again when the output
  changes); the scene's `fullscreen` flag places the window at the output origin. The output excludes the taskbar,
  so a fullscreen window fills the desktop area and never covers the taskbar (ARCHITECTURE.md). foot
  has no fullscreen key by default (`-o key-bindings.fullscreen=F11`, as the e2e test app does).
- **Popups**: `setPosition` is now told for every window, not only X11 ones (the core keeps it in `gsurf.pos_x/pos_y`);
  a new `xdg_popup` is unconstrained (`wlr_xdg_popup_unconstrain_from_box`) against the output in its root toplevel's
  surface coordinates when it is created. A window moved afterwards doesn't re-constrain its open popups. Checked with
  gtk4-demo's menu near the right edge (slides left into view). X11 override-redirect menus aren't constrained.
- **Keyboard**: `create` takes `{ model, layout, variant, options }` read from `/etc/default/keyboard`
  (`keyboard-config.ts`; `XKB_DEFAULT_*` in the environment wins per field); a layout that doesn't compile falls back to
  xkbcommon's default. `wlr_keyboard_set_repeat_info(25, 600)`: clients repeat keys, the viewer drops the browser's repeats.
  AltGr sync finds `ISO_Level3_Shift` in whatever keymap is compiled (not tried with a non-US layout in a browser: this
  machine's file says `us`).
- **Globals**: viewporter, single-pixel-buffer, idle-inhibit (no renderer needed; idle inhibitors aren't acted on),
  presentation-time (feedback is answered with `presented` when the frame callback is sent, `sendFrameDone`, with
  CLOCK_MONOTONIC, 60 Hz refresh), xdg-activation (`toplevel-request-activate` -> raise, restore if minimized, focus; any
  client with a token may do it: no focus-stealing prevention), xdg-output (one output at the origin, an
  `wlr_output_layout` that exists only for it).

### HiDPI (output scale, `wp_fractional_scale_v1`)

- **Logical vs buffer size.** The output's logical size is the viewer's CSS size; its scale is `ceil(viewer scale)` and
  its mode is the logical size times that integer (what `wl_output` shows legacy clients: mode / scale = logical).
  The exact scale (1.5, 1.25) only goes through `wp_fractional_scale_v1` (clients then need `wp_viewporter`: buffer size
  = round(logical * scale), viewport destination = logical). `setOutputScale` also sets every surface's preferred buffer
  scale. wlroots' `current.width/height` are already logical (buffer / scale, or the viewport destination), so the
  commit report's logical size and the scene stay in CSS pixels, while `buffer->width/height` and the damage
  (`buffer_damage`) are in buffer pixels: patches and video frames are the full-resolution buffer, and the viewer draws
  that texture into the logical rectangle (no protocol field for the buffer size was needed).
- **No output layout means no `wl_surface.enter`**: wlroots only enters surfaces into outputs through a scene or by hand.
  Without an enter, GTK and Qt never learn the output's scale, so `handle_new_surface` calls `wlr_surface_send_enter`.
  The scale is also stored for the surface before the client asks for its `wp_fractional_scale_v1` object
  (`wlr_fractional_scale_v1_notify_scale` creates a placeholder, and the client's object gets the value when created).
- **xdg-output** (`wlr_xdg_output_manager_v1` with a layout holding the output) is needed on a scaled output: without
  it Xwayland sizes the X11 screen by the physical mode (2560x1520 at scale 2, so X11 apps think the screen is twice as
  large as the viewer's desktop).
- **X11 apps stay at 1x** (wlroots 0.17 Xwayland isn't started with `-hidpi`): their surfaces commit buffer scale 1, the
  viewer upscales them (blurry at a ratio above 1, but correctly sized and positioned). Making them sharp needs
  Xwayland's own scaling support, which isn't in wlroots 0.17.
- **A ratio change from the browser**: the viewer sends `output` with the new scale. Its `matchMedia` change listener
  doesn't fire under Playwright's `Emulation.setDeviceMetricsOverride`, so the viewer also compares the ratio on the
  window's `resize` event (real browsers fire it for zoom and monitor changes). The e2e driver's `scale` command
  emulates the change this way (CDP override, session kept open, then a `resize` event).
- **Cursors**: a client cursor surface is rendered at the scale too (its image is larger than its logical size), so the
  `cursor` message carries the surface's logical `size` (re-sent when a commit changes it) and the viewer draws the
  image at that size. Hotspots are logical.
- Checked: foot (native fractional scale + viewporter) at 1, 1.5 and 2 (`scripts/e2e/hidpi.sh`), xev/xfontsel at 2.
  Unchecked: GTK, Qt and Chromium/Firefox on Wayland (legacy integer scale paths and `wl_surface.preferred_buffer_scale`).

Wave 3 H (input and X11 gaps; `src/wlr_core_input.c`):

- **Pointer lock**: `pointer-constraints-v1` and `relative-pointer-v1`. A constraint is activated while its surface has
  the pointer focus (`pointer-constraint(sid, active, confined)` event, `pointer.lock` to the viewer, which requests the
  browser's lock, retrying on the next click if refused, and sends `pointer.relative`; `pointerRelative` ->
  `wlr_relative_pointer_manager_v1_send_relative_motion`). It ends when the app destroys it, the pointer focus or the
  keyboard focus leaves (`WlrCompositor.releaseConstraintIfUnfocused`), or the browser ends the lock (Escape:
  `pointer.unlock` -> `pointerConstraintRelease`, which doesn't re-activate it until the pointer has left the surface).
  Confinement: no browser lock; the core clamps motion over the surface to the region's bounding box, and can't keep the
  pointer from leaving the surface. Not run in a browser here (only unit tests of the message flow).
- **Scrolling**: wlroots 0.17's `value_discrete` is the v120 value (120 per click). A click is 15 axis units (libinput's),
  the viewer marks Chromium's 100 px pixel deltas as clicks (`wheelX`/`wheelY`), line deltas (Firefox) are clicks of 3
  lines; the rest (touchpads) is smooth, source finger, no discrete value (`axisEvents` in WlrCompositor.ts). The old
  code sent discrete 1, which clients got as a twelfth of a click. foot binds `wl_pointer` below version 8, so it sees
  `axis_discrete 1`, not `axis_value120` (wlroots converts for old clients): the e2e test accepts both.
- **Touch**: the seat has the touch capability; the viewer sends pointerType 'touch' events as `touch` messages (down, move,
  up, cancel; a point stays on the surface it went down on), the core calls `wlr_seat_touch_notify_*`. A touch counts as a
  pressed button for window drags the app starts. The canvas has `touch-action: none`. Pen events remain pointer events (no
  tablet protocol). Unit tested only.
- **X11 pid**: wlroots' xwm reads the client's pid with XRes (`xsurface->pid`); `toplevel-new` carries it and `Apps` treats an
  X11 window like a Wayland connection (client id -sid). Processes of clients that connect from inside a launched app
  (started from its terminal) are also SIGTERMed with the session, not only the launched app's process.
- **X11 icons**: `_NET_WM_ICON` is read with `xcb_get_property` on xwm's connection (wlroots' internal `xwayland/xwm.h`
  is on the include path) when the window is mapped and on PropertyNotify (`user_event_handler`). The size nearest 48 px
  (the smallest not smaller) goes to JavaScript as RGBA (`toplevel-icon`), is PNG encoded and sent as `window.icon`
  (resent on attach); the taskbar shows it when the window's app has no desktop entry icon (`GroupIcon`). xclock, xeyes and
  xev set no `_NET_WM_ICON`: the e2e test sets one with xprop (which takes at most 64 values).
- **Resize on release and size limits**: the viewer sends one `window.resize` (`done: true`) when an interactive resize ends, nothing
  while dragging (`done: false` still works server-side, for other viewers). `toplevelState` returns `limits: [minW, minH,
  maxW, maxH]` (0: unbounded): xdg from `toplevel->current.min_width` etc. (the committed state, so a client that changes its
  limits is picked up at its next commit), X11 from `xsurface->size_hints` (`WM_NORMAL_HINTS`, flags PMinSize bit 4 and PMaxSize
  bit 5, read by wlroots' xwm). The X11 path is only unit tested (the fake core), not by e2e. foot sets min size 12x39
  (checked in its WAYLAND_DEBUG log; `desktop.sh` asserts the scene matches). Menu Size with arrow keys continues from the
  rect shown after each press, so presses past a limit are dropped and the opposite arrow acts right away.

## Not done yet (later waves of the migration)

Clipboard images and files (only text crosses to the browser), drag and drop with X11 apps (untested), sharp X11 apps
on HiDPI (Xwayland stays 1x in wlroots 0.17), GPU (dmabuf) buffers (wave 4).

X11 specifically, not done: X11 apps without their own decorations (xev, xterm) can be moved only with the window menu's
Move (taskbar button or preview card), until the viewer has title bars of its own (ARCHITECTURE.md, decorations); minimizing isn't
told to X11 apps; activation requests (`_NET_ACTIVE_WINDOW`) and positions apps ask for (USPosition) are ignored, the
viewer places windows; unmanaged window types that aren't override-redirect (some toolkits' menus) are ordinary
windows.

## The migration

ARCHITECTURE.md, "Work plan: four waves". Wave 1 (this stack as the default, with the desktop shell, CI and
tests) and wave 2 B (XWayland) are done.

## Packages

Ubuntu 24.04: the build needs `meson`, `libwayland-dev`, `wayland-protocols`, `libpixman-1-dev`, `libxkbcommon-dev`,
`libgbm-dev`, `libgles-dev`, and for XWayland `xwayland` (also at run time), `libxcb1-dev`, `libxcb-composite0-dev`,
`libxcb-ewmh-dev`, `libxcb-icccm4-dev`, `libxcb-render0-dev`, `libxcb-res0-dev`, `libxcb-xfixes0-dev` (the full list is
in packages/session/README.md, "Building"; CI installs them). The optional `libxcb-errors-dev` isn't packaged for
Ubuntu 24.04: wlroots is built with `-Dxcb-errors=disabled`. The X11 end-to-end test needs x11-utils (xev, xfontsel,
xwininfo).
