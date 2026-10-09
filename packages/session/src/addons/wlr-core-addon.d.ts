/**
 * The wlroots core (native/wlr-core). Surfaces are identified by a session-unique sid; a toplevel by the sid of its
 * surface.
 */
declare namespace wlrCore {
  export type FrameEncoder = unknown

  /**
   * Events, called synchronously from inside the calls below (wlroots runs on this thread):
   * - client-new(clientId, pid), client-destroy(clientId): Wayland connections (pid from the socket's credentials, 0 if
   *   unknown)
   * - surface-new(sid, key): key is "clientId/sid", never reused in the session (unlike the surface's protocol id)
   * - surface-commit(sid, hasBuffer, newBuffer, bufferWidth, bufferHeight, bufferDamage, width, height, input,
   *   hasFrameCallbacks): damage is in buffer coordinates, input in surface coordinates (both flat x, y, w, h)
   * - surface-map(sid), surface-unmap(sid), surface-destroy(sid)
   * - toplevel-new(sid, x11, pid): x11 is true for an X11 window (XWayland), pid the X11 client's, toplevel-destroy(sid), toplevel-title(sid, title), toplevel-app-id(sid, appId),
   *   toplevel-parent(sid, parentSid | 0), toplevel-request-move(sid), toplevel-request-resize(sid, edges),
   *   toplevel-request-maximize(sid, maximized), toplevel-request-fullscreen(sid, fullscreen),
   *   toplevel-request-minimize(sid), toplevel-request-activate(sid) (xdg-activation)
   * - cursor-surface(sid | 0, hotspotX, hotspotY), cursor-shape(name)
   * - drag-start(iconSid | 0), drag-icon(iconSid | 0, x, y) (the icon's offset from the pointer), drag-end(): a drag of
   *   a remote app (the seat's pointer drag)
   * - clipboard-text(text): an app set the clipboard selection (not one we set from the browser); its text
   * - pointer-constraint(sid, active, confined): an app's pointer lock (or confinement) became active or ended
   * - toplevel-icon(sid, width, height, rgba | null): an X11 window's _NET_WM_ICON
   * - toplevel-decorated(sid, decorated): whether the viewer draws our frame around the window (xdg-decoration: server
   *   side mode given, or the decoration object gone; X11: _MOTIF_WM_HINTS)
   * - x11-geometry(sid): an X11 override-redirect window (menu, tooltip) moved, the window it belongs to changed
   *
   * X11 override-redirect windows aren't toplevels: their surfaces are part of the windowSurfaces() of the X11 window
   * they belong to.
   */
  export type EventHandler = (type: string, ...args: any[]) => void

  /**
   * Start the core with a headless output of this size. fd: wlroots' event loop, call dispatch() when readable.
   * x11Display: the X11 display (":1") X11 apps get as DISPLAY, served by Xwayland once one connects; absent if
   * XWayland isn't available or GFLD_XWAYLAND=0.
   */
  export function create(
    onEvent: EventHandler,
    width: number,
    height: number,
    keyboard?: { model?: string; layout?: string; variant?: string; options?: string },
  ): { socket: string; fd: number; x11Display?: string }

  export function dispatch(): void

  export function setOutputSize(width: number, height: number): void

  /** The viewer's scale (devicePixelRatio): the output's scale, and the preferred scale of every surface. */
  export function setOutputScale(scale: number): void

  /** sid 0: the pointer is over nothing of ours */
  /**
   * sx, sy: where the viewer has the point on the surface; x, y: on the output. For an X11 surface the core uses x, y
   * and where X11 has the window (the viewer can be a round trip behind a window that moves itself).
   */
  export function pointerMotion(sid: number, sx: number, sy: number, x: number, y: number, timeMs: number): void

  /** button: Linux input code (BTN_LEFT, ...) */
  export function pointerButton(button: number, pressed: boolean, timeMs: number): void

  /**
   * discrete: the v120 value (120 per wheel click, wl_pointer.axis_value120), 0 for smooth scrolling. finger: the
   * source is a touchpad rather than a wheel.
   */
  export function pointerAxis(
    horizontal: boolean,
    value: number,
    discrete: number,
    timeMs: number,
    finger?: boolean,
  ): void

  /** Relative motion (pointer-constraints: the pointer is locked in the viewer), in surface units. */
  export function pointerRelative(dx: number, dy: number, timeMs: number): void

  /** The viewer's lock ended: deactivate the constraint (until the pointer leaves its surface and comes back). */
  export function pointerConstraintRelease(): void

  /** A touch point: phase 0 down, 1 motion, 2 up, 3 cancel; sx, sy in the surface the point went down on. */
  /** sx, sy and x, y as for pointerMotion */
  export function touch(
    phase: number,
    sid: number,
    id: number,
    sx: number,
    sy: number,
    x: number,
    y: number,
    timeMs: number,
  ): void

  /** evdev key code. A press of a key that's down, or a release of a key that's up, is dropped. */
  export function key(code: number, pressed: boolean, timeMs: number): void

  /**
   * Makes the keyboard's modifiers agree with the viewer's, before an input event: modifier keys the viewer doesn't
   * hold anymore are released, modifiers it holds without a key are set in the mask. modifiers: bits 0 Ctrl, 1 Shift,
   * 2 Alt, 3 Meta, 4 AltGr, 5 Caps Lock, 6 Num Lock. eventCode: the evdev code of the key event that follows (0: not
   * a key event), which is left to its own event.
   */
  export function syncModifiers(modifiers: number, eventCode: number, timeMs: number): void

  /** Releases every key that's held (and any modifier held without a key); the locks stay. */
  export function releaseAllKeys(): void

  /** sid 0: no keyboard focus */
  export function keyboardFocus(sid: number): void

  export function configure(
    sid: number,
    width: number,
    height: number,
    state: { maximized?: boolean; fullscreen?: boolean; activated?: boolean; resizing?: boolean },
  ): void

  export function close(sid: number): void

  /**
   * The largest sensible size for a Wayland toplevel (xdg_toplevel.configure_bounds), sent with its next configure.
   * False if it couldn't be applied yet (before the toplevel's first commit) or the sid isn't a Wayland toplevel.
   */
  export function setBounds(sid: number, width: number, height: number): boolean

  export function toplevelState(sid: number):
    | {
        geometry: [number, number, number, number]
        configured: [number, number]
        /** [minWidth, minHeight, maxWidth, maxHeight] in window geometry pixels, 0: unbounded */
        limits: [number, number, number, number]
        maximized: boolean
        fullscreen: boolean
      }
    | undefined

  /** The toplevel's mapped surfaces (its own, subsurfaces, popups) bottom to top: [sid, x, y] relative to it. */
  /** [sid, x, y, popup] bottom to top: the window's own surfaces, then its popups' (xdg popups, X11 override-redirect) */
  export function windowSurfaces(sid: number): [number, number, number, boolean][]

  /** Where the toplevel's surface is on the output. X11 apps are told; for Wayland toplevels the core keeps their popups inside the output. */
  export function setPosition(sid: number, x: number, y: number): void

  export function sendFrameDone(sid: number, timeMs: number): void

  /**
   * RGBA copy of a rectangle of the surface's current buffer, undefined if it can't be read. `opaque` is true if all
   * its alpha is 255: the buffer's format has no alpha, or the rectangle lies in the surface's opaque region, or the
   * copy found no alpha below 255.
   */
  export function readPixels(
    sid: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): { pixels: Uint8Array; opaque: boolean } | undefined

  /**
   * Makes this text the seat's clipboard selection (a server-side data source, text mime types only), replacing the
   * apps' selection. It is not reported back as a clipboard-text event.
   */
  export function setClipboardText(text: string): void

  /**
   * Files dragged in from the user's computer (see wlr_core_dnd.c): startFileDrag starts a drag, over the client of this
   * surface, that offers text/uri-list (false if it can't: a drag is going on, no such surface); the pointer motion
   * calls that follow move it. fileDragAccepted: the app under the pointer accepted. dropFileDrag releases it (the
   * app gets the drop if it accepted, else the drag is over); cancelFileDrag ends it. provideFiles gives the
   * text/uri-list the apps' receive requests are answered with (those that wait, and those to come).
   */
  export function startFileDrag(sid: number): boolean

  export function fileDragAccepted(): boolean

  export function dropFileDrag(timeMs: number): void

  export function cancelFileDrag(): void

  export function provideFiles(list: string): void

  export function createFrameEncoder(
    encoderType: 'nvh264' | 'vaapih264',
    frameEncoded: (sample: Buffer | undefined) => void,
  ): FrameEncoder

  export function destroyFrameEncoder(encoder: FrameEncoder): void

  export function requestKeyUnit(encoder: FrameEncoder): void

  /** The quality (a constant QP) of the frames from the next one on, which starts with a key frame if it changed. */
  export function setQuality(encoder: FrameEncoder, high: boolean): void

  /** Encode the surface's current buffer; it stays locked (not released to the client) until encoded. */
  export function encodeFrame(encoder: FrameEncoder, sid: number, contentSerial: number, creationSerial: number): void
}

export = wlrCore
