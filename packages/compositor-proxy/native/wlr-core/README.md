# wlroots prototype (ROADMAP.md, Core item 1)

A session's Wayland side on wlroots 0.17.4 instead of the libwayland fork and the TypeScript protocol implementation.
Verdict: **go**. foot and gtk4-demo run on it unchanged in the existing viewer, through the existing scene protocol,
transport and encoders.

## Layout

- `native/wlroots`: the wlroots submodule, pinned to the 0.17.4 tag. CMake builds it with meson as a static library
  (headless backend only, no session, no XWayland yet) against Ubuntu 24.04's packages. Opt in with
  `yarn workspace @gfld/compositor-proxy build:wlroots` (it sets `-DGFLD_WLROOTS=ON` in the CMake cache).
- `native/wlr-core/src/wlr_core.c`: the wiring, as a Node addon (`wlr-core-addon.node`). wlroots implements the
  protocols; the addon reports surfaces, commits (buffer damage, input region), toplevels and their requests, and
  cursors to JavaScript, and takes input, configures and frame callbacks from it.
- `native/wlr-core/src/wlr_core_encoder.c`: the existing GStreamer encoder (`native/encoding`), compiled into the same
  addon against the system libwayland (`shim/westfield.h`), fed from wlroots buffers.
- `src/wlroots/WlrCompositor.ts`: the policy, like the TypeScript compositor's `server/scene.ts`: window positions,
  stacking, activation and keyboard focus, minimize, maximize, child windows centered on their parent, frame pacing,
  and one `SurfaceEncoder` per surface. It is both the `WindowSceneEndpoint` and the `SurfaceContent` of a `ViewerHost`.
- `packages/gateway/src/session-process-wlroots.ts`: a session process on it; the gateway starts it instead of
  `session-process.js` when run with `GFLD_WLROOTS=1`. `GFLD_WLR_TRACE=1` logs events and viewer messages.

## What was verified (headless Chrome through the gateway, `--dev-auth`)

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
- **One libwayland per process**: the fork and the system libwayland share the `libwayland-server.so.0` soname. The
  prototype's session process loads only modules without the fork: `ViewerHost` now takes its surface content as a
  parameter, socket tuning moved into the poll addon, frame pacing out of `FrameFeedback.ts`.
- **Build**: wlroots 0.17 with `-Db_ndebug=true` fails `-Werror` (variables only used in asserts), so it's built with
  `werror=false`. Its Wayland and X11 backends can't be disabled in 0.17; the addon links libwayland-client too
  (harmless).
- **Encoder**: `frame_buffer.user_data` belongs to the encoder (its reference count); the locked buffer travels
  alongside it.

## Not part of the prototype (all in the migration)

Desktop shell (Apps menu, launching, notifications), XWayland, the browser clipboard bridge (clipboard between Wayland
apps already works: data device + primary selection), drag and drop, fullscreen, popup unconstraining to the output,
Caps/Num Lock sync, keyboard layout from the session's locale, telling apps the output scale, GPU (dmabuf) buffers.

## Migration estimate (Core item 2)

1. **Swap the core** (about 1 week): make the wlroots build the default (CI gets meson); session-process on
   `WlrCompositor`, with the desktop shell (app launching only needs `WAYLAND_DISPLAY`; client PIDs from
   `wl_client_get_credentials`); fullscreen, popup unconstraining, key repeat, keyboard layout and lock keys; the
   cheap wlroots globals (viewporter, presentation time, xdg-activation, single-pixel buffer, idle inhibit); unit tests
   for `WlrCompositor` with the addon mocked; the e2e test on it. Then delete the libwayland fork, the westfield and
   wayland-server addons, the protocol interceptors and generators, `packages/compositor`, `@gfld/compositor-wasm` and
   `@gfld/xtsb`.
2. **HiDPI, server side** (1 day): output scale and `wp_fractional_scale_v1` from the viewer's reported scale.
3. **XWayland** (2-3 days): `wlr_xwayland` with its window manager; map X11 windows (including override-redirect menus
   and tooltips) to scene windows. Needs the xcb dev packages and Xwayland (below).
4. **Clipboard with the browser** (about 2 days): a server-side `wlr_data_source` for text from the browser (on Ctrl+V,
   which is when the viewer may read the clipboard), and reading the selection through a pipe to send it to the
   viewer; primary selection the same way. X11 <-> Wayland sync comes with wlr_xwayland.
5. **Drag and drop** (2-3 days): between remote apps through wlroots' seat drags, with the drag icon shown by the
   viewer; then local files into remote apps (upload to the session, offered as `text/uri-list`).
6. **GPU buffers** (1-2 days, needs hardware to verify): linux-dmabuf with the GLES2 renderer, dmabuf readback for
   patches and dmabuf import for video, ported from `native/encoding/src/pixels.c` and the fork path.

About 2-3 weeks of agent work in total; step 1 alone gives today's features on wlroots.

## Packages

Ubuntu 24.04, beyond what the build needs today: `meson` (installed here). XWayland (step 3) needs `xwayland`,
`libxcb-composite0-dev`, `libxcb-ewmh-dev`, `libxcb-icccm4-dev`, `libxcb-render0-dev`, `libxcb-res0-dev`,
`libxcb-xfixes0-dev`, and optionally `libxcb-errors-dev`.
