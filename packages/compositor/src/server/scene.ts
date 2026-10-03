/**
 * The window scene: what an attached viewer (browser) needs to show and drive a server-side session.
 *
 * The server is authoritative for all state (windows, surface trees, layout, stacking, focus). The viewer is the
 * window manager and does everything that doesn't need state: it renders, hit-tests, runs interactive move/resize and
 * decides placement, and reports its decisions back here, where they are stored so a later viewer gets the same layout.
 *
 * Message types are documented in packages/viewer/src/protocol.ts.
 */
import { WlSurfaceResource } from '@gfld/compositor-protocol'
import { AxisEvent } from '../AxisEvent'
import { ButtonCode, ButtonEvent } from '../ButtonEvent'
import { DesktopSurface, RemoteWindowManager } from '../desktop/Desktop'
import { KeyEvent } from '../KeyEvent'
import { ORIGIN, minusPoint, Point } from '../math/Point'
import { Size } from '../math/Size'
import Output from '../Output'
import Session from '../Session'
import Surface from '../Surface'
import View from '../View'
import { EvDevKeyCode } from '../Xkb'
import { ServerCursor, ServerRenderer } from './ServerRenderer'

export type ControlMessage = { type: string; [key: string]: any }

export type SceneSurface = { id: string; x: number; y: number; width: number; height: number }

export type SceneWindow = {
  /** surface key of the window's main surface */
  id: string
  title: string
  appId: string
  activated: boolean
  maximized: boolean
  fullscreen: boolean
  /** false until the viewer decided where the window goes */
  placed: boolean
  /** position of the main surface's origin in output coordinates */
  x: number
  y: number
  /** window geometry (excludes e.g. client side shadows), relative to the main surface origin */
  geometry: { x: number; y: number; width: number; height: number }
  /**
   * Size of the configure the committed content reflects (xdg_toplevel only; 0x0 = client's choice). Lets the viewer
   * tell when the client caught up with a size it asked for, even if the client rounds the size (e.g. to cells).
   */
  configuredSize?: { width: number; height: number }
  /** all surfaces of the window (subsurfaces, popups, child windows), bottom to top, relative to the window origin */
  surfaces: SceneSurface[]
}

export interface WindowSceneEndpoint {
  attach(send: (message: ControlMessage) => void): void

  detach(): void

  handleMessage(message: ControlMessage): void
}

export function surfaceKey(surface: Surface): string {
  return `${surface.resource.client.id}/${surface.resource.id}`
}

type WindowMetadata = { title: string; appId: string; activated: boolean; placed: boolean }

// AxisEvent wants the DOM WheelEvent delta mode constants
const DOM_DELTA_PIXEL = 0
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2

export class WindowScene implements WindowSceneEndpoint, RemoteWindowManager {
  private send?: (message: ControlMessage) => void
  private lastSceneJSON = ''
  private readonly metadata = new Map<string, WindowMetadata>()

  constructor(
    private readonly session: Session,
    private readonly output: Output,
    private readonly setOutputSize: (size: Size) => void,
  ) {
    session.windowManager = this
    const renderer = this.renderer
    renderer.onRendered = () => this.sendSceneIfChanged()
    renderer.onCursorChanged = (cursor) => this.sendCursor(cursor)

    const events = session.userShell.events
    events.surfaceTitleUpdated = (surface, title) => {
      this.metadataFor(surface).title = title
      this.session.renderer.render()
    }
    events.surfaceAppIdUpdated = (surface, appId) => {
      this.metadataFor(surface).appId = appId
      this.session.renderer.render()
    }
    events.surfaceActivationUpdated = (surface, active) => {
      this.metadataFor(surface).activated = active
      this.session.renderer.render()
    }
    events.surfaceDestroyed = (surface) => {
      this.metadata.delete(`${surface.client.id}/${surface.id}`)
      this.session.renderer.render()
    }
  }

  private get renderer(): ServerRenderer {
    return this.session.renderer as ServerRenderer
  }

  attach(send: (message: ControlMessage) => void): void {
    this.send = send
    this.lastSceneJSON = ''
    this.sendSceneIfChanged()
    this.sendCursor(this.renderer.cursor)
  }

  detach(): void {
    this.send = undefined
    this.renderer.pickOverride = undefined
    const seat = this.session.globals.seat
    // nobody is pressing keys or buttons anymore
    seat.notifyKeyboardFocusOut()
    this.session.flush()
  }

  // ---------------------------------------------------------------------------------------------------------------
  // server -> viewer

  private metadataFor(surface: { id: number; client: { id: string } }): WindowMetadata {
    const key = `${surface.client.id}/${surface.id}`
    let metadata = this.metadata.get(key)
    if (metadata === undefined) {
      metadata = { title: '', appId: '', activated: false, placed: false }
      this.metadata.set(key, metadata)
    }
    return metadata
  }

  private sendSceneIfChanged() {
    if (this.send === undefined) {
      return
    }
    const scene = { type: 'scene', windows: this.windows(), focus: this.keyboardFocus() }
    const sceneJSON = JSON.stringify(scene)
    if (sceneJSON === this.lastSceneJSON) {
      return
    }
    this.lastSceneJSON = sceneJSON
    this.send(scene)
  }

  private sendCursor(cursor: ServerCursor) {
    if (this.send === undefined) {
      return
    }
    switch (cursor.kind) {
      case 'surface':
        this.send({ type: 'cursor', kind: 'surface', surface: surfaceKey(cursor.view.surface), hotspot: cursor.hotspot })
        break
      case 'named':
        this.send({ type: 'cursor', kind: 'named', name: cursor.name })
        break
      default:
        this.send({ type: 'cursor', kind: cursor.kind })
    }
  }

  private keyboardFocus(): string | null {
    const focus = this.session.globals.seat.keyboard.focus
    return focus ? surfaceKey(focus.getMainSurface()) : null
  }

  private windows(): SceneWindow[] {
    const windows: SceneWindow[] = []
    for (const view of this.renderer.sceneGraph.topLevelViews) {
      // child windows (dialogs) are part of their parent's surface tree
      if (view.parent || view.destroyed || !view.mapped) {
        continue
      }
      const desktopSurface = view.surface.role?.desktopSurface
      if (desktopSurface === undefined || view.surface.size === undefined) {
        continue
      }
      const key = surfaceKey(view.surface)
      const metadata = this.metadataFor({ id: view.surface.resource.id, client: view.surface.resource.client })
      const origin = view.viewToSceneSpace(ORIGIN)
      const geometry = view.surface.geometry
      windows.push({
        id: key,
        title: metadata.title,
        appId: metadata.appId,
        activated: metadata.activated,
        maximized: desktopSurface.role.queryMaximized(),
        fullscreen: desktopSurface.role.queryFullscreen(),
        placed: metadata.placed,
        x: Math.round(origin.x),
        y: Math.round(origin.y),
        geometry: {
          x: geometry.position.x,
          y: geometry.position.y,
          width: geometry.size.width,
          height: geometry.size.height,
        },
        configuredSize: desktopSurface.role.queryConfiguredSize?.(),
        surfaces: this.windowSurfaces(view, origin),
      })
    }
    return windows
  }

  private windowSurfaces(rootView: View, origin: Point): SceneSurface[] {
    const surfaces: SceneSurface[] = []
    const add = (view: View) => {
      for (const surfaceChild of view.surface.children) {
        const childView = surfaceChild.surface.role?.view
        if (childView === undefined || childView.destroyed) {
          continue
        }
        // A surface's children include itself (for stacking). Only the root isn't added by its parent.
        if (childView === view && view !== rootView) {
          continue
        }
        const { size } = childView.surface
        if (childView.mapped && size && childView.surface.state.buffer) {
          const position = minusPoint(childView.viewToSceneSpace(ORIGIN), origin)
          surfaces.push({
            id: surfaceKey(childView.surface),
            x: Math.round(position.x),
            y: Math.round(position.y),
            width: size.width,
            height: size.height,
          })
        }
        if (childView !== view) {
          add(childView)
        }
      }
    }
    add(rootView)
    return surfaces
  }

  requestMove(desktopSurface: DesktopSurface): void {
    this.send?.({ type: 'interactive', mode: 'move', window: surfaceKey(desktopSurface.surface) })
  }

  requestResize(desktopSurface: DesktopSurface, edges: number): void {
    this.send?.({ type: 'interactive', mode: 'resize', window: surfaceKey(desktopSurface.surface), edges })
  }

  // ---------------------------------------------------------------------------------------------------------------
  // viewer -> server

  handleMessage(message: ControlMessage): void {
    switch (message.type) {
      case 'hello':
      case 'output':
        this.updateOutput(message.output ?? message)
        break
      case 'pointer':
        this.pointerMotion(message)
        break
      case 'button':
        this.pointerButton(message)
        break
      case 'axis':
        this.pointerAxis(message)
        break
      case 'key':
        this.key(message)
        break
      case 'focus':
        if (message.focused) {
          this.session.globals.seat.notifyKeyboardFocusIn()
        } else {
          this.session.globals.seat.notifyKeyboardFocusOut()
        }
        this.session.flush()
        break
      case 'window.move':
        this.moveWindow(message)
        break
      case 'window.activate':
        this.findDesktopSurface(message.window)?.activate()
        this.session.flush()
        this.session.renderer.render()
        break
      case 'window.resize':
        this.resizeWindow(message)
        break
      case 'window.maximize':
        this.findDesktopSurface(message.window)?.setMaximized(Boolean(message.maximized))
        this.session.flush()
        break
      case 'window.close':
        this.findDesktopSurface(message.window)?.role.requestClose()
        this.session.flush()
        break
      default:
        this.session.logger.warn(`Unknown viewer message: ${message.type}`)
    }
  }

  private updateOutput(size: { width?: number; height?: number }) {
    const width = Math.round(Number(size.width))
    const height = Math.round(Number(size.height))
    if (!(width > 0 && height > 0)) {
      return
    }
    this.setOutputSize({ width, height })
    this.output.update()
    // maximized and fullscreen windows follow the output size
    for (const view of this.renderer.sceneGraph.topLevelViews) {
      const desktopSurface = view.surface.role?.desktopSurface
      if (desktopSurface?.role.queryFullscreen()) {
        desktopSurface.setFullscreen(true)
      } else if (desktopSurface?.role.queryMaximized()) {
        desktopSurface.setMaximized(true)
      }
    }
    this.session.flush()
  }

  private findSurface(key: unknown): Surface | undefined {
    if (typeof key !== 'string') {
      return undefined
    }
    const separator = key.lastIndexOf('/')
    const client = this.session.display.clients[key.substring(0, separator)]
    const resource = client?.connection.wlObjects[Number(key.substring(separator + 1))]
    if (resource instanceof WlSurfaceResource) {
      const surface = resource.implementation as Surface
      return surface.destroyed ? undefined : surface
    }
    return undefined
  }

  private findDesktopSurface(key: unknown): DesktopSurface | undefined {
    return this.findSurface(key)?.role?.desktopSurface
  }

  /**
   * Point the pointer at what the viewer picked. Returns the position in output (scene) coordinates.
   */
  private applyPick(message: ControlMessage): Point {
    const view = this.findSurface(message.surface)?.role?.view
    this.renderer.pickOverride = { view }
    if (view && typeof message.sx === 'number' && typeof message.sy === 'number') {
      // exact surface local coordinates, independent of where the viewer currently shows the window
      return view.viewToSceneSpace({ x: message.sx, y: message.sy })
    }
    return { x: Number(message.x) || 0, y: Number(message.y) || 0 }
  }

  private buttonEvent(message: ControlMessage, position: Point, released: boolean): ButtonEvent {
    return {
      x: position.x,
      y: position.y,
      timestamp: Number(message.time) || Date.now(),
      buttonCode: (Number(message.button) || ButtonCode.MAIN) as ButtonCode,
      released,
      buttons: Number(message.buttons) || 0,
      sceneId: '',
    }
  }

  private pointerMotion(message: ControlMessage) {
    const position = this.applyPick(message)
    const seat = this.session.globals.seat
    seat.notifyMotion(this.buttonEvent(message, position, false))
    seat.notifyFrame()
    this.session.flush()
  }

  private pointerButton(message: ControlMessage) {
    const position = this.applyPick(message)
    const seat = this.session.globals.seat
    // make sure focus and position match before the button
    seat.notifyMotion(this.buttonEvent(message, position, false))
    seat.notifyButton(this.buttonEvent(message, position, !message.pressed))
    seat.notifyFrame()
    this.session.flush()
  }

  private pointerAxis(message: ControlMessage) {
    const position = this.applyPick(message)
    const seat = this.session.globals.seat
    seat.notifyMotion(this.buttonEvent(message, position, false))
    const axisEvent: AxisEvent = {
      deltaMode: Number(message.deltaMode) || DOM_DELTA_PIXEL,
      DOM_DELTA_LINE,
      DOM_DELTA_PAGE,
      DOM_DELTA_PIXEL,
      deltaX: Number(message.deltaX) || 0,
      deltaY: Number(message.deltaY) || 0,
      timestamp: Number(message.time) || Date.now(),
      sceneId: '',
    }
    seat.notifyAxis(axisEvent)
    seat.notifyFrame()
    this.session.flush()
  }

  private key(message: ControlMessage) {
    const evdevKeyCode: EvDevKeyCode | undefined = EvDevKeyCode[message.code as keyof typeof EvDevKeyCode]
    if (evdevKeyCode === undefined) {
      return
    }
    const keyEvent: KeyEvent = {
      keyCode: { evdevKeyCode, x11KeyCode: evdevKeyCode + 8 },
      timeStamp: Number(message.time) || Date.now(),
      pressed: Boolean(message.pressed),
      capsLock: Boolean(message.capsLock),
      numLock: Boolean(message.numLock),
    }
    this.session.globals.seat.notifyKey(keyEvent)
    this.session.flush()
  }

  private moveWindow(message: ControlMessage) {
    const surface = this.findSurface(message.window)
    const view = surface?.role?.view
    if (surface === undefined || view === undefined || view.parent) {
      return
    }
    const x = Math.round(Number(message.x))
    const y = Math.round(Number(message.y))
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return
    }
    this.metadataFor({ id: surface.resource.id, client: surface.resource.client }).placed = true
    view.positionOffset = minusPoint({ x, y }, surface.surfaceChildSelf.position)
    this.session.renderer.render()
  }

  private resizeWindow(message: ControlMessage) {
    const desktopSurface = this.findDesktopSurface(message.window)
    if (desktopSurface === undefined) {
      return
    }
    const width = Math.max(1, Math.round(Number(message.width)))
    const height = Math.max(1, Math.round(Number(message.height)))
    // The viewer runs the interaction: it keeps the anchored edge in place and sends the final position (window.move)
    // once the client committed the final size, so the window isn't moved here.
    desktopSurface.role.configureResizing(!message.done)
    desktopSurface.role.configureSize({ width, height })
    this.session.flush()
  }
}
