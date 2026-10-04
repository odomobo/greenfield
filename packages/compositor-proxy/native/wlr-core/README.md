# wlroots core

A session's Wayland side on wlroots 0.17.4. It replaced the libwayland fork and the TypeScript protocol implementation
(deleted in wave 2 C of the migration, ROADMAP.md, Core item 1): every session runs on it, with the desktop shell.
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
  tooltips) are surfaces of the window they belong to, at their X11 position relative to it. `setPosition` tells X11
  apps where the scene shows their windows. `wlr_core_internal.h` is what it shares with `wlr_core.c`.
- `native/wlr-core/src/wlr_core_clipboard.c`: the clipboard bridge (wave 3 E). A remote app's selection is read through a
  non-blocking pipe on the `wl_event_loop` (text mime types in the order text/plain;charset=utf-8, UTF8_STRING,
  text/plain, TEXT, STRING; at most 4 MB, 3 s) and reported as `clipboard-text`; `setClipboardText` makes the browser's
  text the seat's selection through a server-side `wlr_data_source` (its `send` writes without blocking). The
  primary selection stays between remote apps (browsers have none).
- `native/wlr-core/src/wlr_core_dnd.c`: drag and drop (wave 3 E). Between remote apps: `request_start_drag` becomes a
  seat pointer drag, the icon surface is reported (`drag-start`, `drag-icon`, `drag-end`). Files from the user's
  computer: a drag of ours with a `text/uri-list` source (`startFileDrag`, `fileDragAccepted`, `dropFileDrag`,
  `cancelFileDrag`, `provideFiles`), driven by `src/wlroots/FileDrops.ts`.
- `native/wlr-core/src/xwayland_sockets.c`: replaces wlroots' `xwayland/sockets.c` at link time (see the gotchas).
- `native/wlr-core/src/wlr_core_encoder.c`: the existing GStreamer encoder (`native/encoding`), compiled into the same
  addon against the system libwayland (`shim/westfield.h`), fed from wlroots buffers. `src/westfield-egl.c`,
  `westfield-dmabuf.c` and `drm_format_set.c` (with their headers) are the encoder's EGL and dmabuf helpers.
- `src/wlroots/WlrCompositor.ts`: the policy, like the TypeScript compositor's `server/scene.ts`: window positions,
  stacking, activation and keyboard focus, minimize, maximize, child windows centered on their parent, frame pacing,
  and one `SurfaceEncoder` per surface. It is both the `WindowSceneEndpoint` and the `SurfaceContent` of a `ViewerHost`.
  The native core is passed in (`WlrNative`), so `src/wlroots/test/` tests the policy against a fake core.
- `src/wlroots/X11.ts`: what's left for X11 windows on the TypeScript side: telling them their position when the scene
  moves them.
- `src/wlroots/Apps.ts`: the session's app processes: launched by the desktop shell (with the session's
  `WAYLAND_DISPLAY`, and `DISPLAY` for X11 apps), or connected on their own (from the client's credentials; a client of
  a launched app's child process belongs to that app). Ending the session sends them SIGTERM.
- `packages/gateway/src/session-process.ts`: the session process: `WlrCompositor`, `Apps`, the desktop shell
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
- Encoding: small surfaces as patches, busy surfaces as H.264 (86 video frames while foot scrolled, with the viewer's
  pacing simulated); lazy patch capture unchanged (the buffer stays locked until the next commit).
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

## Not done yet (later waves of the migration)

Clipboard images and files (only text crosses to the browser), drag and drop with X11 apps (untested), fullscreen, popup
unconstraining to the output, Caps/Num Lock sync, keyboard layout from the session's locale, telling apps the output
scale, GPU (dmabuf) buffers. Server-owned window state with sequence numbers (wave 2 A).

X11 specifically, not done: X11 apps without their own decorations (xev, xterm) can't be moved by the user, since the
viewer has no title bars of its own yet (ROADMAP.md, decorations) nor a modifier-drag; X11 apps started from a terminal
inside the session aren't tracked by `Apps` (they don't connect to Wayland; `_NET_WM_PID` would do); minimizing isn't
told to X11 apps; activation requests (`_NET_ACTIVE_WINDOW`) and positions apps ask for (USPosition) are ignored, the
viewer places windows; unmanaged window types that aren't override-redirect (some toolkits' menus) are ordinary
windows.

## The migration

ROADMAP.md, Core item 1, "Work plan: four waves". Wave 1 (this stack as the default, with the desktop shell, CI and
tests) and wave 2 B (XWayland) are done.

## Packages

Ubuntu 24.04: the build needs `meson`, `libwayland-dev`, `wayland-protocols`, `libpixman-1-dev`, `libxkbcommon-dev`,
`libgbm-dev`, `libgles-dev`, and for XWayland `xwayland` (also at run time), `libxcb1-dev`, `libxcb-composite0-dev`,
`libxcb-ewmh-dev`, `libxcb-icccm4-dev`, `libxcb-render0-dev`, `libxcb-res0-dev`, `libxcb-xfixes0-dev` (the full list is
in packages/gateway/README.md, "Building"; CI installs them). The optional `libxcb-errors-dev` isn't packaged for
Ubuntu 24.04: wlroots is built with `-Dxcb-errors=disabled`. The X11 end-to-end test needs x11-utils (xev, xfontsel,
xwininfo).
