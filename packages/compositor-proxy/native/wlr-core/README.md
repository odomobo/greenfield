# wlroots core

A session's Wayland side on wlroots 0.17.4. It replaced the libwayland fork and the TypeScript protocol implementation
(deleted in wave 2 C of the migration, ROADMAP.md, Core item 1): every session runs on it, with the desktop shell.

## Layout

- `native/wlroots`: the wlroots submodule, pinned to the 0.17.4 tag (`git submodule update --init`). CMake builds it
  with meson as a static library (headless backend only, no session, no XWayland yet) against Ubuntu 24.04's packages,
  as part of the normal build. It's only built when `build/wlroots/libwlroots.a` is missing: delete `build/wlroots`
  after changing the submodule.
- `native/wlr-core/src/wlr_core.c`: the wiring, as a Node addon (`wlr-core-addon.node`). wlroots implements the
  protocols; the addon reports clients (with their pid), surfaces, commits (buffer damage, input region), toplevels and
  their requests, and cursors to JavaScript, and takes input, configures and frame callbacks from it.
- `native/wlr-core/src/wlr_core_encoder.c`: the existing GStreamer encoder (`native/encoding`), compiled into the same
  addon against the system libwayland (`shim/westfield.h`), fed from wlroots buffers. `src/westfield-egl.c`,
  `westfield-dmabuf.c` and `drm_format_set.c` (with their headers) are the encoder's EGL and dmabuf helpers.
- `src/wlroots/WlrCompositor.ts`: the policy, like the TypeScript compositor's `server/scene.ts`: window positions,
  stacking, activation and keyboard focus, minimize, maximize, child windows centered on their parent, frame pacing,
  and one `SurfaceEncoder` per surface. It is both the `WindowSceneEndpoint` and the `SurfaceContent` of a `ViewerHost`.
  The native core is passed in (`WlrNative`), so `src/wlroots/test/` tests the policy against a fake core.
- `src/wlroots/Apps.ts`: the session's app processes: launched by the desktop shell (with the session's
  `WAYLAND_DISPLAY`), or connected on their own (from the client's credentials; a client of a launched app's child
  process belongs to that app). Ending the session sends them SIGTERM.
- `packages/gateway/src/session-process.ts`: the session process: `WlrCompositor`, `Apps`, the desktop shell
  (`shell/service.ts`), the session environment (`session-environment.ts`).
  `GFLD_WLR_TRACE=1` logs events and viewer messages; `GFLD_WLR_DEBUG=1` turns on wlroots' own debug log.

## What was verified (headless Chrome through the gateway, `--dev-auth`)

Wave 1: `scripts/test-gateway.sh` passes on it unchanged (Apps menu, launching from it, pinning, taskbar minimize and
restore, maximize, notifications, typing, mouse back button as BTN_SIDE, reattach with identical pixels, viewer-side
resizing, logging out ends the apps), plus a check that the session really runs on wlroots. Unit tests for
`WlrCompositor` (fake core) and `Apps`. The prototype, by hand:

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

## Not done yet (later waves of the migration)

XWayland, the browser clipboard bridge (clipboard between Wayland apps already works: data device + primary selection),
drag and drop, fullscreen, popup unconstraining to the output, Caps/Num Lock sync, keyboard layout from the session's
locale, telling apps the output scale, GPU (dmabuf) buffers. Server-owned window state with sequence numbers (wave 2 A).

## The migration

ROADMAP.md, Core item 1, "Work plan: three waves". Wave 1 (this stack as the default, with the desktop shell, CI and
tests) is done.

## Packages

Ubuntu 24.04: the build needs `meson`, `libwayland-dev`, `wayland-protocols`, `libpixman-1-dev`, `libxkbcommon-dev`,
`libgbm-dev`, `libgles-dev` (the full list is in packages/gateway/README.md, "Building"). XWayland (wave 2) needs
`xwayland`, `libxcb-composite0-dev`, `libxcb-ewmh-dev`, `libxcb-icccm4-dev`, `libxcb-render0-dev`, `libxcb-res0-dev`,
`libxcb-xfixes0-dev`. The optional `libxcb-errors-dev` isn't packaged for Ubuntu 24.04.
