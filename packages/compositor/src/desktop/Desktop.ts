import { Point } from '../math/Point'
import Surface from '../Surface'
import { RectWithInfo } from '../math/Rect'
import { Size } from '../math/Size'
import SurfaceRole from '../SurfaceRole'
import { FloatingDesktopSurface } from './FloatingDesktopSurface'

export interface DesktopSurfaceRole extends SurfaceRole {
  requestClose(): void

  queryMaximized(): boolean

  queryFullscreen(): boolean

  queryGeometry(): RectWithInfo

  queryMinSize(): Size

  queryMaxSize(): Size

  configureMaximized(maximized: boolean): void

  configureFullscreen(fullscreen: boolean): void

  configureSize(size: Size): void

  configureActivated(activated: boolean): void

  configureResizing(resizing: boolean): void
}

/**
 * Window management that is done elsewhere, e.g. by the viewer (browser) of a server-side session. Interactive move and
 * resize requests are forwarded to it instead of being handled by a compositor pointer grab.
 */
export interface RemoteWindowManager {
  requestMove(desktopSurface: DesktopSurface): void

  requestResize(desktopSurface: DesktopSurface, edges: number): void
}

export interface DesktopSurface {
  removed(): void
  commit(): void
  setParent(parent: DesktopSurface | undefined): void
  setTitle(title: string): void
  setAppId(appId: string): void
  move(serial: number): void
  resize(serial: number, edges: number): void
  setMaximized(enable: boolean): void
  setFullscreen(enabled: boolean): void
  minimize(): void
  add(): void
  activate(): void
  gainFocus(): void
  loseFocus(): void

  setXWaylandPosition(position: Point): void
  popupGrab(serial: number): void

  init(): void

  surface: Surface
  role: DesktopSurfaceRole
}

export function createDesktopSurface(surface: Surface, desktopSurfaceRole: DesktopSurfaceRole): DesktopSurface {
  return new FloatingDesktopSurface(surface, desktopSurfaceRole)
}
