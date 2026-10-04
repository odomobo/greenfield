/**
 * X11 apps' windows (XWayland, native/wlr-core/src/wlr_core_xwayland.c). The core reports them like xdg toplevels, so
 * the window policy is the same for both; what's left for X11 is here.
 *
 * X11 windows have absolute positions, and X11 apps use them: menus and tooltips are placed in root coordinates, and
 * the pointer's position is translated with them. So X11 windows are told where the window scene puts them (Wayland
 * apps can't know). Only changes are sent: each one is an X11 ConfigureNotify for the app.
 */
export class X11Windows {
  /** X11 window sid -> the position it was last told (undefined: not told yet) */
  private readonly positions = new Map<number, { x: number; y: number } | undefined>()

  constructor(private readonly setPosition: (sid: number, x: number, y: number) => void) {}

  added(sid: number): void {
    this.positions.set(sid, undefined)
  }

  removed(sid: number): void {
    this.positions.delete(sid)
  }

  has(sid: number): boolean {
    return this.positions.has(sid)
  }

  /** The scene shows this window's surface at x, y (output coordinates). */
  shownAt(sid: number, x: number, y: number): void {
    if (!this.positions.has(sid)) {
      return
    }
    // || 0: no -0 (a maximized window is at minus its geometry's offset, which is 0 for X11 windows)
    const position = { x: x || 0, y: y || 0 }
    const known = this.positions.get(sid)
    if (known?.x !== position.x || known?.y !== position.y) {
      this.positions.set(sid, position)
      this.setPosition(sid, position.x, position.y)
    }
  }
}
