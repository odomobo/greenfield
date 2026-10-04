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
   * - surface-new(sid, key): key is "clientId/surface object id"
   * - surface-commit(sid, hasBuffer, newBuffer, bufferWidth, bufferHeight, bufferDamage, width, height, input,
   *   hasFrameCallbacks): damage is in buffer coordinates, input in surface coordinates (both flat x, y, w, h)
   * - surface-map(sid), surface-unmap(sid), surface-destroy(sid)
   * - toplevel-new(sid, x11): x11 is true for an X11 window (XWayland), toplevel-destroy(sid), toplevel-title(sid, title), toplevel-app-id(sid, appId),
   *   toplevel-parent(sid, parentSid | 0), toplevel-request-move(sid), toplevel-request-resize(sid, edges),
   *   toplevel-request-maximize(sid, maximized), toplevel-request-fullscreen(sid, fullscreen),
   *   toplevel-request-minimize(sid)
   * - cursor-surface(sid | 0, hotspotX, hotspotY), cursor-shape(name)
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
  ): { socket: string; fd: number; x11Display?: string }

  export function dispatch(): void

  export function setOutputSize(width: number, height: number): void

  /** sid 0: the pointer is over nothing of ours */
  export function pointerMotion(sid: number, sx: number, sy: number, timeMs: number): void

  /** button: Linux input code (BTN_LEFT, ...) */
  export function pointerButton(button: number, pressed: boolean, timeMs: number): void

  export function pointerAxis(horizontal: boolean, value: number, discrete: number, timeMs: number): void

  /** evdev key code */
  export function key(code: number, pressed: boolean, timeMs: number): void

  /** sid 0: no keyboard focus */
  export function keyboardFocus(sid: number): void

  export function configure(
    sid: number,
    width: number,
    height: number,
    state: { maximized?: boolean; fullscreen?: boolean; activated?: boolean; resizing?: boolean },
  ): void

  export function close(sid: number): void

  export function toplevelState(sid: number):
    | {
        geometry: [number, number, number, number]
        configured: [number, number]
        maximized: boolean
        fullscreen: boolean
      }
    | undefined

  /** The toplevel's mapped surfaces (its own, subsurfaces, popups) bottom to top: [sid, x, y] relative to it. */
  export function windowSurfaces(sid: number): [number, number, number][]

  /** Where the toplevel's surface is on the output. X11 apps are told (no-op for Wayland toplevels). */
  export function setPosition(sid: number, x: number, y: number): void

  export function sendFrameDone(sid: number, timeMs: number): void

  /** RGBA copy of a rectangle of the surface's current buffer, undefined if it can't be read. */
  export function readPixels(sid: number, x: number, y: number, width: number, height: number): Buffer | undefined

  export function createFrameEncoder(
    encoderType: 'nvh264' | 'x264' | 'vaapih264',
    frameEncoded: (sample: Buffer | undefined) => void,
  ): FrameEncoder

  export function destroyFrameEncoder(encoder: FrameEncoder): void

  export function requestKeyUnit(encoder: FrameEncoder): void

  /** Encode the surface's current buffer; it stays locked (not released to the client) until encoded. */
  export function encodeFrame(encoder: FrameEncoder, sid: number, contentSerial: number, creationSerial: number): void
}

export = wlrCore
