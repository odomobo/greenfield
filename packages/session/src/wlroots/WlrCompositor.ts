/**
 * The session's Wayland side (ARCHITECTURE.md): wlroots 0.17 (native/wlr-core) implements the protocols; this
 * is the policy: window
 * positions, stacking, focus and minimize state, frame pacing, and the encoding of every surface's content.
 */
import type * as WlrCoreAddon from '../addons/wlr-core-addon'
import { createLogger } from '../Logger.js'
import { scheduleFrameCallback } from '../FramePacing.js'
import { EncoderPool } from '../encoding/EncoderPool.js'
import {
  EncodingContext,
  EncodingSink,
  PatchOrder,
  PatchShape,
  SurfaceEncoder,
  SurfaceHost,
  VideoQuality,
} from '../encoding/SurfaceEncoder.js'
import { encodePng } from '../encoding/png.js'
import { NORMAL_ENCODE_NICE, NORMAL_ENCODE_WORKERS, PatchWorkerPool } from '../encoding/PatchWorkerPool.js'
import type { Rect } from '@nebula/session-contracts'
import { SurfaceContent, ViewerHost, WindowSceneEndpoint } from '../viewer/ViewerHost.js'
import { ControlMessage, SimulatedLink } from '../viewer/ViewerTransport.js'
import { frameInsets, type SceneRect, type SceneSurface, type SceneWindow } from '@gfld/scene-protocol'
import { EvDevKeyCode } from './keys.js'
import { Apps } from './Apps.js'
import { X11Windows } from './X11.js'
import { KeyboardConfig, systemKeyboardConfig } from './keyboard-config.js'
import { Clipboard } from './Clipboard.js'
import { FileDrops } from './FileDrops.js'

const logger = createLogger('wlroots')
/** GFLD_WLR_TRACE=1: log wlroots events and viewer messages */
const TRACE = process.env.GFLD_WLR_TRACE === '1'

/** The hardware video encoders; without one (`undefined`) everything is sent as lossless patches. */
type H264Encoder = 'nvh264' | 'vaapih264' | 'x264'

/** The native core (native/wlr-core), injectable so the policy can be tested without wlroots. */
export type WlrNative = Omit<typeof WlrCoreAddon, 'create'> & {
  create(
    onEvent: WlrCoreAddon.EventHandler,
    width: number,
    height: number,
    keyboard?: KeyboardConfig,
  ): { socket: string; fd: number; x11Display?: string }
}

/** Watches a file descriptor, calls back when it's readable (the poll addon in production). */
export type FdWatcher = (fd: number, readable: () => void) => void

/** Wayland clients coming and going, with their process (0 if unknown). */
export interface ClientListener {
  clientConnected(clientId: number, pid: number): void

  clientDisconnected(clientId: number): void

  /** An X11 window (by its surface's sid) was mapped; pid: the X11 client's process (0 if unknown). */
  x11WindowMapped?(sid: number, pid: number): void

  x11WindowGone?(sid: number): void
}

/** Input regions with more rectangles than this are sent as their bounding box. */
const MAX_INPUT_RECTS = 64

/** DOM button to Linux input button code */
const LINUX_BUTTONS: Record<number, number> = { 0: 0x110, 1: 0x112, 2: 0x111, 3: 0x113, 4: 0x114 }
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2
/** Wayland's axis value of one wheel click (what libinput reports), and the v120 value of one click */
const CLICK_AXIS_VALUE = 15
const V120_CLICK = 120
/** a click's DOM delta in lines (Firefox) */
const LINES_PER_CLICK = 3

/** A pooled GStreamer video encoder that encodes surfaces' current wlroots buffers. */
class WlrEncoder {
  private readonly native: WlrCoreAddon.FrameEncoder
  private quality: VideoQuality = 'high'
  private readonly queue: { resolve: (frame: Buffer) => void; reject: (error: Error) => void }[] = []

  constructor(
    private readonly wlr: WlrNative,
    type: H264Encoder,
  ) {
    this.native = wlr.createFrameEncoder(type, (frame) => {
      const task = this.queue.shift()
      if (frame) {
        task?.resolve(frame)
      } else {
        task?.reject(new Error('Buffer encoding failed.'))
      }
    })
  }

  encode(sid: number, contentSerial: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const task = { resolve, reject }
      this.queue.push(task)
      try {
        this.wlr.encodeFrame(this.native, sid, contentSerial, 0)
      } catch (e: any) {
        this.queue.splice(this.queue.indexOf(task), 1)
        reject(e)
      }
    })
  }

  requestKeyUnit(): void {
    this.wlr.requestKeyUnit(this.native)
  }

  setQuality(quality: VideoQuality): void {
    if (quality !== this.quality) {
      this.quality = quality
      this.wlr.setQuality(this.native, quality === 'high')
    }
  }

  destroy(): void {
    this.wlr.destroyFrameEncoder(this.native)
  }
}

type Surface = {
  sid: number
  key: string
  mapped: boolean
  /** surface size (surface coordinates) */
  width: number
  height: number
  /** input region, undefined: the whole surface */
  input?: SceneRect[]
  buffer?: { width: number; height: number; contentSerial: number }
  encoder?: SurfaceEncoder<WlrEncoder>
  frameScheduled: boolean
}

type Window = {
  sid: number
  title: string
  appId: string
  parent?: number
  placed: boolean
  minimized: boolean
  /** the viewer draws our frame around it (xdg-decoration server side mode, an X11 window that doesn't say it has none) */
  decorated: boolean
  /** position of the main surface's origin; a child window's is relative to its parent */
  x: number
  y: number
  /** the last window change sequence number from the viewer applied to this window (scene protocol) */
  seq: number
  /** the app's own icon (X11 _NET_WM_ICON) as a PNG data URL */
  icon?: string
  /** the configure bounds the app was last told, "width x height" (Wayland windows) */
  bounds?: string
}

const inactiveSink: EncodingSink = {
  active: false,
  bandwidthLimited: false,
  linkBandwidth: undefined,
  queuedBytes: () => 0,
  sendFrame: (_surface, _frame, _class, done) => done(false),
  sendPatch: (_surface, _patch, _tier, done) => done(false),
}

export class WlrCompositor implements WindowSceneEndpoint, SurfaceContent {
  readonly waylandDisplay: string
  /** the X11 display for X11 apps (XWayland), undefined if there's none */
  readonly x11Display?: string
  private readonly x11: X11Windows
  private readonly clipboard: Clipboard
  private readonly fileDrops: FileDrops
  private send?: (message: ControlMessage) => void
  private sink: EncodingSink = inactiveSink
  private readonly encoding: EncodingContext<WlrEncoder>
  private readonly surfaces = new Map<number, Surface>()
  private readonly sids = new Map<string, number>()
  private readonly windows = new Map<number, Window>()
  /** where each Wayland window was last said to be shown (popupOrigin) */
  private readonly shownAt = new Map<number, { x: number; y: number }>()
  /** window sids, bottom to top */
  private stack: number[] = []
  private active = 0
  private pageFocused = true
  private contentSerial = 0
  /** a drag and drop between remote apps is going on; its icon surface */
  private drag?: { icon?: { sid: number; x: number; y: number } }
  private output = { width: 1280, height: 720 }
  private lastSceneJSON = ''
  /** surfaces destroyed since the last scene, for the viewer to forget (sent with the next one) */
  private destroyedSurfaces: string[] = []
  private sceneScheduled = false
  viewerScale = 1
  clientListener?: ClientListener
  /** the pointer lock or confinement the app has on a surface (pointer-constraints), while it's active */
  private constraint?: { sid: number; confined: boolean }

  constructor(
    config: { h264Encoder?: H264Encoder; videoStreams: number; patchOrder?: PatchOrder; patchShape?: PatchShape },
    private readonly wlr: WlrNative,
    watchFd: FdWatcher,
    /** where files dropped from the user's computer are saved */
    dropsDirectory?: string,
  ) {
    const currentSink = () => this.sink
    const forwardingSink: EncodingSink = {
      get active() {
        return currentSink().active
      },
      get bandwidthLimited() {
        return currentSink().bandwidthLimited
      },
      get linkBandwidth() {
        return currentSink().linkBandwidth
      },
      queuedBytes: (surface) => this.sink.queuedBytes(surface),
      sendFrame: (surface, frame, surfaceClass, done) => this.sink.sendFrame(surface, frame, surfaceClass, done),
      sendPatch: (surface, patch, tier, done) => this.sink.sendPatch(surface, patch, tier, done),
    }
    // without a hardware encoder the pool has size 0 and no video encoder is ever created; one that fails to create is
    // reported once and the pool then behaves the same
    const h264Encoder = config.h264Encoder
    const pool = new EncoderPool<WlrEncoder>(
      () => new WlrEncoder(wlr, h264Encoder!),
      h264Encoder ? config.videoStreams : 0,
      (error) =>
        logger.error(`Video encoder ${h264Encoder} is unavailable (${error.message}), sending lossless patches only.`),
    )
    pool.warm()
    const streamingPool = new PatchWorkerPool(logger)
    const normalPool = new PatchWorkerPool(logger, NORMAL_ENCODE_WORKERS, NORMAL_ENCODE_NICE)
    this.encoding = new EncodingContext(
      forwardingSink,
      pool,
      {
        normal: (rgba, width, height, opaque) => normalPool.encode(rgba, width, height, opaque),
        streaming: streamingPool,
      },
      logger,
    )
    this.encoding.patchOrder = config.patchOrder ?? 'oldest'
    this.encoding.patchShape = config.patchShape ?? 'bands'
    this.encoding.startTicking()

    this.clipboard = new Clipboard((text) => this.wlr.setClipboardText(text))
    this.fileDrops = new FileDrops(
      this.wlr,
      (target) => this.pointerMotion(target),
      (surface) => (typeof surface === 'string' ? this.sids.get(surface) : undefined),
      dropsDirectory,
    )
    this.x11 = new X11Windows((sid, x, y) => this.wlr.setPosition(sid, x, y))
    const { socket, fd, x11Display } = this.wlr.create(
      (type, ...args) => this.onEvent(type, args),
      this.output.width,
      this.output.height,
      systemKeyboardConfig(),
    )
    this.waylandDisplay = socket
    this.x11Display = x11Display
    watchFd(fd, () => this.wlr.dispatch())
    logger.info(
      `Listening on: WAYLAND_DISPLAY="${socket}" (wlroots)` + (x11Display ? `, DISPLAY="${x11Display}".` : '.'),
    )
  }

  // -------------------------------------------------------------------------------------------------------------------
  // SurfaceContent

  setFrameSink(sink: EncodingSink): void {
    this.sink = sink
  }

  unencodedBytes(): number {
    return this.encoding.unencodedBytes
  }

  requestKeyFrame(key: string): void {
    const sid = this.sids.get(key)
    const surface = sid === undefined ? undefined : this.surfaces.get(sid)
    if (surface?.encoder && this.sink.active) {
      void surface.encoder.refresh()
    }
  }

  requestKeyFramesForAllSurfaces(): void {
    for (const key of this.sids.keys()) {
      this.requestKeyFrame(key)
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // wlroots events

  private onEvent(type: string, args: any[]) {
    if (TRACE && type !== 'surface-commit') {
      logger.info(`event ${type} ${JSON.stringify(args)}`)
    }
    switch (type) {
      case 'client-new':
        this.clientListener?.clientConnected(args[0], args[1])
        break
      case 'client-destroy':
        this.clientListener?.clientDisconnected(args[0])
        break
      case 'surface-new': {
        const [sid, key] = args as [number, string]
        this.surfaces.set(sid, {
          sid,
          key,
          mapped: false,
          width: 0,
          height: 0,
          frameScheduled: false,
        })
        this.sids.set(key, sid)
        break
      }
      case 'surface-commit':
        this.surfaceCommitted(...(args as Parameters<WlrCompositor['surfaceCommitted']>))
        break
      case 'surface-map':
      case 'surface-unmap': {
        const surface = this.surfaces.get(args[0])
        if (surface) {
          surface.mapped = type === 'surface-map'
        }
        const window = this.windows.get(args[0])
        if (window && type === 'surface-map') {
          this.windowMapped(window)
        } else if (window && this.active === window.sid) {
          this.activateNext(window)
        }
        this.scheduleScene()
        break
      }
      case 'surface-destroy': {
        const surface = this.surfaces.get(args[0])
        if (surface) {
          surface.encoder?.destroy()
          this.surfaces.delete(surface.sid)
          this.sids.delete(surface.key)
          if (this.send) {
            this.destroyedSurfaces.push(surface.key)
            this.scheduleScene()
          }
        }
        break
      }
      case 'toplevel-new':
        this.windows.set(args[0], {
          sid: args[0],
          title: '',
          appId: '',
          placed: false,
          minimized: false,
          decorated: false,
          x: 0,
          y: 0,
          seq: 0,
        })
        if (args[1] === true) {
          this.x11.added(args[0])
          this.clientListener?.x11WindowMapped?.(args[0], Number(args[2]) || 0)
        }
        break
      case 'toplevel-destroy': {
        const window = this.windows.get(args[0])
        this.windows.delete(args[0])
        if (this.x11.has(args[0])) {
          this.clientListener?.x11WindowGone?.(args[0])
        }
        this.x11.removed(args[0])
        this.shownAt.delete(args[0])
        this.stack = this.stack.filter((sid) => sid !== args[0])
        if (window && this.active === window.sid) {
          this.activateNext(window)
        }
        this.scheduleScene()
        break
      }
      case 'toplevel-title':
      case 'toplevel-app-id': {
        const window = this.windows.get(args[0])
        if (window) {
          window[type === 'toplevel-title' ? 'title' : 'appId'] = args[1] ?? ''
          this.scheduleScene()
        }
        break
      }
      case 'toplevel-decorated': {
        const window = this.windows.get(args[0])
        if (window && window.decorated !== Boolean(args[1])) {
          window.decorated = Boolean(args[1])
          // a maximized window fills the output below its title bar (and the app's own title bar goes or comes)
          const state = this.wlr.toplevelState(window.sid)
          if (state?.maximized) {
            this.setMaximized(window.sid, true)
          } else if (state && !state.fullscreen && this.surfaces.get(window.sid)?.mapped && !this.x11.has(window.sid)) {
            // a shown Wayland window is told its size: Chrome, switching to our frame, draws without its shadow but
            // keeps its old window geometry (inset by the shadow) until it's resized, so our frame would overlap it
            this.wlr.configure(window.sid, state.geometry[2], state.geometry[3], {})
          }
          this.updateBounds(window)
          this.scheduleScene()
        }
        break
      }
      case 'toplevel-request-window-menu': {
        // the app's own title bar was right-clicked: the viewer opens our window menu there (main surface coordinates)
        const [sid, x, y] = args as [number, number, number]
        if (this.windows.has(sid)) {
          this.send?.({ type: 'window-menu-requested', window: this.keyOf(sid), x, y })
        }
        break
      }
      case 'toplevel-parent': {
        const window = this.windows.get(args[0])
        if (window) {
          window.parent = args[1] || undefined
          this.scheduleScene()
        }
        break
      }
      case 'toplevel-request-move':
        this.send?.({ type: 'interactive', mode: 'move', window: this.keyOf(args[0]) })
        break
      case 'toplevel-request-resize':
        this.send?.({ type: 'interactive', mode: 'resize', window: this.keyOf(args[0]), edges: args[1] })
        break
      case 'toplevel-request-maximize':
        this.send?.({ type: 'maximize-requested', window: this.keyOf(args[0]), maximized: args[1] })
        this.setMaximized(args[0], args[1])
        break
      case 'toplevel-request-fullscreen':
        this.setFullscreen(args[0], Boolean(args[1]))
        break
      case 'toplevel-request-activate': {
        // xdg-activation: an app asks for its window to be shown and focused, like a click on it
        const window = this.windows.get(args[0])
        if (window && this.surfaces.get(args[0])?.mapped) {
          this.setMinimized(this.rootOf(window), false)
          this.activate(window.sid)
        }
        break
      }
      case 'toplevel-request-minimize': {
        const window = this.windows.get(args[0])
        if (window) {
          this.setMinimized(this.rootOf(window), true)
        }
        break
      }
      case 'cursor-surface': {
        const [sid, x, y] = args as [number, number, number]
        this.cursorSurface = sid ? { sid, hotspot: { x, y } } : undefined
        this.sendCursorSurface()
        break
      }
      case 'cursor-shape':
        this.send?.({ type: 'cursor', kind: 'named', name: args[0] })
        break
      case 'drag-start':
        this.drag = { icon: args[0] ? { sid: args[0], x: 0, y: 0 } : undefined }
        this.send?.({ type: 'cursor', kind: 'named', name: 'grabbing' })
        this.sendDrag()
        break
      case 'drag-icon':
        if (this.drag) {
          this.drag.icon = args[0] ? { sid: args[0], x: args[1], y: args[2] } : undefined
          this.sendDrag()
        }
        break
      case 'drag-end':
        this.drag = undefined
        this.sendDrag()
        break
      case 'clipboard-text':
        this.clipboard.remoteText(args[0])
        break
      case 'x11-geometry':
        this.scheduleScene()
        break
      case 'toplevel-request-position': {
        // an X11 app moved its own window (it was told already): that's where the window is now, as if the viewer had
        // moved it (the viewer still has the last word while it drags or resizes the window, and keeps it on screen)
        const window = this.windows.get(args[0])
        if (window) {
          const parent = window.parent === undefined ? undefined : this.windows.get(window.parent)
          const origin = parent ? this.positionOf(parent) : { x: 0, y: 0 }
          window.x = args[1] - origin.x
          window.y = args[2] - origin.y
          window.placed = true
          this.scheduleScene()
        }
        break
      }
      case 'toplevel-icon':
        this.windowIcon(args[0], args[1], args[2], args[3])
        break
      case 'pointer-constraint': {
        const [sid, active, confined] = args as [number, boolean, boolean]
        this.constraint = active ? { sid, confined } : undefined
        this.send?.({ type: 'pointer.lock', surface: this.keyOf(sid), locked: active, confined })
        break
      }
    }
  }

  /** The client's cursor image (the surface and its hotspot), and the logical size we last told the viewer. */
  private cursorSurface?: { sid: number; hotspot: { x: number; y: number }; sentSize?: string }

  private sendCursorSurface() {
    const cursor = this.cursorSurface
    if (cursor === undefined) {
      this.send?.({ type: 'cursor', kind: 'hidden' })
      return
    }
    const surface = this.surfaces.get(cursor.sid)
    // the logical size, which differs from the image's size when the app renders at the viewer's scale
    const size =
      surface && surface.width > 0 && surface.height > 0 ? { width: surface.width, height: surface.height } : undefined
    cursor.sentSize = JSON.stringify(size)
    this.send?.({
      type: 'cursor',
      kind: 'surface',
      surface: this.keyOf(cursor.sid),
      hotspot: cursor.hotspot,
      ...(size && { size }),
    })
  }

  private surfaceCommitted(
    sid: number,
    hasBuffer: boolean,
    newBuffer: boolean,
    bufferWidth: number,
    bufferHeight: number,
    bufferDamage: Int32Array,
    width: number,
    height: number,
    input: Int32Array,
    hasFrameCallbacks: boolean,
  ) {
    const surface = this.surfaces.get(sid)
    if (surface === undefined) {
      return
    }
    // (a toplevel's first commit: the initial configure, which carries the bounds, hasn't gone out yet)
    const window = this.windows.get(sid)
    if (window) {
      this.updateBounds(window)
    }
    surface.width = width
    surface.height = height
    surface.input = inputRegion(input, width, height)
    if (this.cursorSurface?.sid === sid && this.cursorSurface.sentSize !== JSON.stringify({ width, height })) {
      this.sendCursorSurface()
    }

    if (!hasBuffer) {
      surface.buffer = undefined
      surface.encoder?.bufferDetached()
    } else if (newBuffer) {
      surface.buffer = { width: bufferWidth, height: bufferHeight, contentSerial: ++this.contentSerial }
      const damage: Rect[] = []
      for (let i = 0; i < bufferDamage.length; i += 4) {
        damage.push({
          x: bufferDamage[i],
          y: bufferDamage[i + 1],
          width: bufferDamage[i + 2],
          height: bufferDamage[i + 3],
        })
      }
      void this.encoderOf(surface).commit(damage)
    }

    if (hasFrameCallbacks && !surface.frameScheduled) {
      surface.frameScheduled = true
      // held while the surface's slots are full of damage: an app slows down to what can be sent (but see MIN_FRAME_RATE;
      // not for video, a whole frame at a time)
      scheduleFrameCallback(
        () => surface.encoder?.readyForFrame ?? true,
        (time) => {
          surface.frameScheduled = false
          if (this.surfaces.get(sid) === surface) {
            this.wlr.sendFrameDone(sid, time)
          }
        },
        () => !surface.encoder?.usesVideo,
      )
    }
    this.scheduleScene()
  }

  private encoderOf(surface: Surface): SurfaceEncoder<WlrEncoder> {
    if (surface.encoder === undefined) {
      const host: SurfaceHost<WlrEncoder> = {
        currentBuffer: () =>
          surface.buffer && {
            bufferId: surface.sid,
            creationSerial: 0,
            contentSerial: surface.buffer.contentSerial,
            width: surface.buffer.width,
            height: surface.buffer.height,
          },
        takeFrame: () => surface.buffer && this.wlr.takeFrame(surface.sid, surface.buffer.contentSerial),
        encodeVideo: (encoder, buffer) => encoder.encode(surface.sid, buffer.contentSerial),
      }
      surface.encoder = new SurfaceEncoder(surface.key, host, this.encoding)
    }
    return surface.encoder
  }

  private windowMapped(window: Window) {
    const parentState = window.parent === undefined ? undefined : this.wlr.toplevelState(window.parent)
    const state = this.wlr.toplevelState(window.sid)
    if (!window.placed && parentState && state) {
      // a child window (dialog) is centered on its parent, the viewer only places top level windows; the frames are
      // part of what is centered (the outer rectangles are). Positions are relative to the parent's.
      const parentOuter = this.outerRect(this.windows.get(window.parent!), parentState)
      const outer = this.outerRect(window, state)
      window.x = Math.round(parentOuter.x + parentOuter.width / 2 - (outer.x + outer.width / 2))
      window.y = Math.round(parentOuter.y + parentOuter.height / 2 - (outer.y + outer.height / 2))
      window.placed = true
    }
    this.stack = this.stack.filter((sid) => sid !== window.sid)
    this.stack.push(window.sid)
    this.activate(window.sid)
  }

  // -------------------------------------------------------------------------------------------------------------------
  // window management

  private keyOf(sid: number): string {
    return this.surfaces.get(sid)?.key ?? ''
  }

  /** The outer rectangle of a window (its geometry with its frame, see the scene protocol), relative to its surface origin. */
  private outerRect(
    window: Window | undefined,
    state: { geometry: [number, number, number, number]; maximized: boolean; fullscreen: boolean },
  ): SceneRect {
    const [x, y, width, height] = state.geometry
    const insets = frameInsets({
      decorated: window?.decorated,
      maximized: state.maximized,
      fullscreen: state.fullscreen,
    })
    return {
      x: x - insets.left,
      y: y - insets.top,
      width: width + insets.left + insets.right,
      height: height + insets.top + insets.bottom,
    }
  }

  private rootOf(window: Window): Window {
    let root = window
    while (root.parent !== undefined && this.windows.has(root.parent)) {
      root = this.windows.get(root.parent)!
    }
    return root
  }

  /** Absolute position of a window's main surface. */
  /** Tells the core where a Wayland window's surface is shown (it keeps popups inside the output), when it changed. */
  private popupOrigin(sid: number, x: number, y: number) {
    const known = this.shownAt.get(sid)
    if (known?.x !== x || known?.y !== y) {
      this.shownAt.set(sid, { x, y })
      this.wlr.setPosition(sid, x, y)
    }
  }

  private positionOf(window: Window): { x: number; y: number } {
    const parent = window.parent === undefined ? undefined : this.windows.get(window.parent)
    if (parent === undefined) {
      return { x: window.x, y: window.y }
    }
    const origin = this.positionOf(parent)
    return { x: origin.x + window.x, y: origin.y + window.y }
  }

  private activate(sid: number) {
    if (this.active && this.active !== sid && this.windows.has(this.active)) {
      this.wlr.configure(this.active, -1, -1, { activated: false })
    }
    this.active = sid
    if (sid) {
      this.wlr.configure(sid, -1, -1, { activated: true })
      // raise it with its parents (a dialog brings its main window along), its children above it
      const raised = [sid]
      for (let window = this.windows.get(sid); window?.parent !== undefined && this.windows.has(window.parent);) {
        if (raised.includes(window.parent)) {
          break
        }
        raised.unshift(window.parent)
        window = this.windows.get(window.parent)
      }
      this.stack = this.stack.filter((other) => !raised.includes(other))
      this.stack.push(...raised)
    }
    this.wlr.keyboardFocus(this.pageFocused ? sid : 0)
    this.releaseConstraintIfUnfocused()
    this.scheduleScene()
  }

  /** The app's pointer lock ends when its window isn't the focused one anymore (or the page lost focus). */
  private releaseConstraintIfUnfocused() {
    if (!this.constraint) {
      return
    }
    const focused = this.pageFocused && this.active !== 0
    if (!focused || !this.wlr.windowSurfaces(this.active).some(([sid]) => sid === this.constraint?.sid)) {
      this.releaseConstraint()
    }
  }

  private releaseConstraint() {
    if (this.constraint) {
      // the core answers with pointer-constraint(active = false), which tells the viewer
      this.wlr.pointerConstraintRelease()
    }
  }

  private windowIcon(sid: number, width: number, height: number, rgba: Buffer | null) {
    const window = this.windows.get(sid)
    if (window === undefined) {
      return
    }
    const send = (icon: string | null) => {
      if (this.windows.get(sid) === window) {
        window.icon = icon ?? undefined
        this.send?.({ type: 'window.icon', window: this.keyOf(sid), icon })
      }
    }
    if (rgba === null) {
      send(null)
      return
    }
    void encodePng(rgba, width, height).then(
      (png) => send(`data:image/png;base64,${png.toString('base64')}`),
      (error: Error) => logger.error(`Can't encode the icon of window ${sid}: ${error.message}`),
    )
  }

  /** The active window went away: its parent (a dialog closed) or else the topmost window shown gets the focus. */
  private activateNext(gone: Window) {
    const shown = (sid: number) => {
      const window = this.windows.get(sid)
      return (
        window !== undefined &&
        sid !== gone.sid &&
        this.surfaces.get(sid)?.mapped === true &&
        !this.rootOf(window).minimized
      )
    }
    const parent = gone.parent !== undefined && shown(gone.parent) ? gone.parent : undefined
    this.activate(parent ?? [...this.stack].reverse().find(shown) ?? 0)
  }

  private setMinimized(window: Window, minimized: boolean) {
    if (window.minimized === minimized) {
      return
    }
    window.minimized = minimized
    if (minimized && this.active && this.rootOf(this.windows.get(this.active) ?? window) === window) {
      this.activate(0)
    }
    this.scheduleScene()
  }

  /**
   * Tell a Wayland window the largest sensible size for it (xdg_toplevel.configure_bounds), when that changed: the
   * output (which excludes the taskbar) minus our frame. Apps use it to pick their initial size, so they fit. Sent
   * when the window opens and when its decorations change, not when the output does (see updateOutput).
   */
  private updateBounds(window: Window) {
    if (this.x11.has(window.sid)) {
      return
    }
    const insets = frameInsets({ decorated: window.decorated })
    const width = Math.max(0, this.output.width - insets.left - insets.right)
    const height = Math.max(0, this.output.height - insets.top - insets.bottom)
    const bounds = `${width}x${height}`
    // (not applied before the window's first commit: tried again then)
    if (window.bounds !== bounds && this.wlr.setBounds(window.sid, width, height)) {
      window.bounds = bounds
    }
  }

  /** The window covers the output (the viewer shows it above its taskbar), or goes back to its own size. */
  private setFullscreen(sid: number, fullscreen: boolean) {
    if (fullscreen) {
      this.wlr.configure(sid, this.output.width, this.output.height, { fullscreen: true })
    } else {
      this.wlr.configure(sid, 0, 0, { fullscreen: false })
    }
  }

  private setMaximized(sid: number, maximized: boolean) {
    if (maximized) {
      // the app gets the output minus the frame (a decorated window keeps its title bar on screen)
      const { top, bottom } = frameInsets({ decorated: this.windows.get(sid)?.decorated, maximized: true })
      this.wlr.configure(sid, this.output.width, this.output.height - top - bottom, { maximized: true })
    } else {
      this.wlr.configure(sid, 0, 0, { maximized: false })
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // WindowSceneEndpoint: server -> viewer

  attach(send: (message: ControlMessage) => void): void {
    this.send = send
    this.clipboard.attach(send)
    if (this.drag) {
      this.sendDrag()
    }
    this.lastSceneJSON = ''
    // (a new viewer starts from nothing: it has nothing to forget)
    this.destroyedSurfaces = []
    this.sendSceneIfChanged()
    send({ type: 'cursor', kind: 'default' })
    for (const window of this.windows.values()) {
      if (window.icon) {
        send({ type: 'window.icon', window: this.keyOf(window.sid), icon: window.icon })
      }
    }
    if (this.constraint) {
      send({ type: 'pointer.lock', surface: this.keyOf(this.constraint.sid), locked: true, ...this.constraint })
    }
  }

  detach(): void {
    this.send = undefined
    this.clipboard.detach()
    this.fileDrops.leave()
    this.wlr.releaseAllKeys()
    this.wlr.keyboardFocus(0)
  }

  private sendDrag() {
    const icon = this.drag?.icon
    this.send?.({
      type: 'drag',
      active: this.drag !== undefined,
      icon: icon && { surface: this.keyOf(icon.sid), x: icon.x, y: icon.y },
    })
  }

  private scheduleScene() {
    if (!this.sceneScheduled) {
      this.sceneScheduled = true
      setImmediate(() => {
        this.sceneScheduled = false
        this.sendSceneIfChanged()
      })
    }
  }

  private sendSceneIfChanged() {
    if (this.send === undefined) {
      return
    }
    const scene = {
      type: 'scene',
      windows: this.sceneWindows(),
      focus: this.pageFocused && this.active ? this.keyOf(this.active) : null,
    }
    const json = JSON.stringify(scene)
    const destroyed = this.destroyedSurfaces
    if (json !== this.lastSceneJSON || destroyed.length > 0) {
      this.lastSceneJSON = json
      this.destroyedSurfaces = []
      // (with the scene that no longer shows them: the viewer fades a closed window out from its content first)
      this.send(destroyed.length > 0 ? { ...scene, destroyed } : scene)
    }
  }

  /** Bottom to top; a child window right above its parent (and its parent's other children). */
  private orderedWindows(): Window[] {
    const ordered: Window[] = []
    const add = (window: Window) => {
      ordered.push(window)
      for (const sid of this.stack) {
        const child = this.windows.get(sid)
        if (child?.parent === window.sid) {
          add(child)
        }
      }
    }
    for (const sid of this.stack) {
      const window = this.windows.get(sid)
      if (window && (window.parent === undefined || !this.windows.has(window.parent))) {
        add(window)
      }
    }
    return ordered
  }

  private sceneWindows(): SceneWindow[] {
    const windows: SceneWindow[] = []
    for (const window of this.orderedWindows()) {
      const surface = this.surfaces.get(window.sid)
      const state = this.wlr.toplevelState(window.sid)
      if (surface === undefined || !surface.mapped || state === undefined) {
        continue
      }
      // maximized and fullscreen windows cover the output (a maximized decorated one below its title bar); their own
      // position is kept for when they're restored
      const insets = frameInsets({
        decorated: window.decorated,
        maximized: state.maximized,
        fullscreen: state.fullscreen,
      })
      const { x, y } =
        state.maximized || state.fullscreen
          ? { x: insets.left - state.geometry[0], y: insets.top - state.geometry[1] }
          : this.positionOf(window)
      this.x11.shownAt(window.sid, x, y)
      if (!this.x11.has(window.sid)) {
        this.popupOrigin(window.sid, x, y)
      }
      const parent = window.parent === undefined ? undefined : this.surfaces.get(window.parent)
      windows.push({
        id: surface.key,
        parent: parent?.mapped ? parent.key : undefined,
        title: window.title,
        appId: window.appId,
        activated: this.active === window.sid,
        maximized: state.maximized,
        fullscreen: state.fullscreen,
        ...(window.decorated ? { decorated: true } : {}),
        minimized: this.rootOf(window).minimized,
        placed: window.placed,
        seq: window.seq,
        x,
        y,
        geometry: { x: state.geometry[0], y: state.geometry[1], width: state.geometry[2], height: state.geometry[3] },
        configuredSize: { width: state.configured[0], height: state.configured[1] },
        ...limitFields(state.limits),
        surfaces: this.windowSurfaces(window.sid),
      })
    }
    return windows
  }

  private windowSurfaces(sid: number): SceneSurface[] {
    const surfaces: SceneSurface[] = []
    for (const [childSid, x, y, popup] of this.wlr.windowSurfaces(sid)) {
      const surface = this.surfaces.get(childSid)
      if (surface?.buffer) {
        const { key: id, width, height, input } = surface
        surfaces.push(popup ? { id, x, y, width, height, input, popup } : { id, x, y, width, height, input })
      }
    }
    return surfaces
  }

  // -------------------------------------------------------------------------------------------------------------------
  // WindowSceneEndpoint: viewer -> server

  handleMessage(message: ControlMessage): void {
    if (TRACE && message.type !== 'pointer') {
      logger.info(`viewer ${JSON.stringify(message)}`)
    }
    this.recordWindowChange(message)
    switch (message.type) {
      case 'hello':
      case 'output':
        this.updateOutput((message.output ?? message) as { width?: unknown; height?: unknown; scale?: unknown })
        break
      case 'pointer':
        this.syncModifiers(message, 0)
        this.pointerMotion(message)
        break
      case 'button':
        this.syncModifiers(message, 0)
        this.pointerMotion(message)
        this.wlr.pointerButton(LINUX_BUTTONS[Number(message.button)] ?? 0x110, Boolean(message.pressed), time(message))
        break
      case 'axis':
        this.syncModifiers(message, 0)
        this.pointerMotion(message)
        this.pointerAxis(message)
        break
      case 'pointer.relative':
        // the pointer is locked in the browser: movement without a position
        if (this.constraint && !this.constraint.confined) {
          this.wlr.pointerRelative(Number(message.dx) || 0, Number(message.dy) || 0, time(message))
        }
        break
      case 'pointer.unlock':
        // the browser ended the lock (Escape, focus lost)
        this.releaseConstraint()
        break
      case 'touch':
        this.syncModifiers(message, 0)
        this.touch(message)
        break
      case 'key': {
        // (a numeric enum maps numbers back to names too, and inherits toString & co.: only own numeric values)
        const value: unknown = Object.prototype.hasOwnProperty.call(EvDevKeyCode, String(message.code))
          ? EvDevKeyCode[message.code as keyof typeof EvDevKeyCode]
          : undefined
        const code = typeof value === 'number' ? value : undefined
        this.syncModifiers(message, code ?? 0)
        if (code !== undefined) {
          this.wlr.key(code, Boolean(message.pressed), time(message))
        }
        break
      }
      case 'clipboard':
        this.clipboard.viewerText(message.text)
        break
      case 'file-drag':
        this.syncModifiers(message, 0)
        if (message.over) {
          this.fileDrops.over(message)
        } else {
          this.fileDrops.leave()
        }
        break
      case 'file-drop':
        this.fileDrops.drop(message)
        break
      case 'focus':
        this.pageFocused = Boolean(message.focused)
        if (!this.pageFocused) {
          // keys released while the page doesn't have focus never reach it: let go of them now, while the app still
          // has keyboard focus to see the releases
          this.wlr.releaseAllKeys()
        }
        this.wlr.keyboardFocus(this.pageFocused ? this.active : 0)
        this.releaseConstraintIfUnfocused()
        this.scheduleScene()
        break
      case 'window.move': {
        const window = this.windowOf(message.window)
        const x = Math.round(Number(message.x))
        const y = Math.round(Number(message.y))
        if (window && Number.isFinite(x) && Number.isFinite(y)) {
          const parent = window.parent === undefined ? undefined : this.windows.get(window.parent)
          const origin = parent ? this.positionOf(parent) : { x: 0, y: 0 }
          window.x = x - origin.x
          window.y = y - origin.y
          window.placed = true
          this.scheduleScene()
        }
        break
      }
      case 'window.activate': {
        const window = this.windowOf(message.window)
        if (window) {
          this.setMinimized(this.rootOf(window), false)
          this.activate(window.sid)
        }
        break
      }
      case 'window.minimize': {
        const window = this.windowOf(message.window)
        if (window) {
          this.setMinimized(this.rootOf(window), Boolean(message.minimized))
        }
        break
      }
      case 'window.resize': {
        const window = this.windowOf(message.window)
        if (window) {
          const width = Math.max(1, Math.round(Number(message.width)))
          const height = Math.max(1, Math.round(Number(message.height)))
          this.wlr.configure(window.sid, width, height, { resizing: !message.done })
        }
        break
      }
      case 'window.maximize': {
        const window = this.windowOf(message.window)
        if (window) {
          this.setMaximized(window.sid, Boolean(message.maximized))
        }
        break
      }
      case 'window.close': {
        const window = this.windowOf(message.window)
        if (window) {
          logger.info(`The viewer closes window ${message.window} (${window.title ?? ''}).`)
          this.wlr.close(window.sid)
        }
        break
      }
      default:
        logger.info(`Unhandled viewer message: ${message.type}`)
    }
  }

  handleFileChunk(id: number, data: Uint8Array): void {
    this.fileDrops.chunk(id, data)
  }

  /**
   * A window change from the viewer: remember its sequence number, so the next scene tells the viewer the server has
   * applied it (and every change before it), whether or not it changed anything (e.g. a move to where the window is,
   * or a request the server corrected or ignored). Messages are applied in order, so the scene that carries this
   * number reflects this change. See the scene protocol.
   */
  private recordWindowChange(message: ControlMessage) {
    if (!message.type.startsWith('window.') || message.type === 'window.close') {
      return
    }
    const window = this.windowOf(message.window)
    const seq = Number(message.seq)
    if (window && Number.isSafeInteger(seq) && seq > window.seq) {
      window.seq = seq
      this.scheduleScene()
    }
  }

  private windowOf(key: unknown): Window | undefined {
    const sid = typeof key === 'string' ? this.sids.get(key) : undefined
    return sid === undefined ? undefined : this.windows.get(sid)
  }

  private updateOutput(size: { width?: unknown; height?: unknown; scale?: unknown }) {
    const scale = Number(size.scale)
    if (scale >= 1 && scale <= 16) {
      this.viewerScale = scale
      // apps are told to render at this scale, and the output keeps its logical size (CSS pixels)
      this.wlr.setOutputScale(scale)
    }
    const width = Math.round(Number(size.width))
    const height = Math.round(Number(size.height))
    if (!(width > 0 && height > 0)) {
      return
    }
    this.output = { width, height }
    this.wlr.setOutputSize(width, height)
    // (open windows aren't told new bounds: GTK shrinks to fit them, and a window the viewer moves back into a
    // narrower page must keep its size; windows that open later get the new ones)
    for (const window of this.windows.values()) {
      const state = this.wlr.toplevelState(window.sid)
      if (state?.maximized) {
        this.setMaximized(window.sid, true)
      }
      if (state?.fullscreen) {
        this.setFullscreen(window.sid, true)
      }
    }
  }

  /**
   * Makes the keyboard's modifiers agree with the browser's (the message's `modifiers`, see the scene protocol)
   * before the input event. eventCode: the evdev code of a key event (0: not one).
   */
  private syncModifiers(message: ControlMessage, eventCode: number) {
    const bits = modifierBits(message.modifiers)
    if (bits !== undefined) {
      this.wlr.syncModifiers(bits, eventCode, time(message))
    }
  }

  private pointerMotion(message: ControlMessage) {
    const sid = typeof message.surface === 'string' ? (this.sids.get(message.surface) ?? 0) : 0
    if (sid === 0) {
      this.send?.({ type: 'cursor', kind: 'default' })
    }
    const [sx, sy, x, y] = [message.sx, message.sy, message.x, message.y].map((value) => Number(value) || 0)
    this.wlr.pointerMotion(sid, sx, sy, x, y, time(message))
  }

  private pointerAxis(message: ControlMessage) {
    const surface = this.surfaces.get(this.sids.get(String(message.surface)) ?? 0)
    for (const event of axisEvents(message, surface?.width ?? 0, surface?.height ?? 0)) {
      this.wlr.pointerAxis(event.horizontal, event.value, event.discrete, time(message), event.finger)
    }
  }

  /** A touch point (pointerType 'touch'), by the surface it started on: phase down, move, up or cancel. */
  private touch(message: ControlMessage) {
    const phases: Record<string, number> = { down: 0, move: 1, up: 2, cancel: 3 }
    const phase = phases[String(message.phase)]
    if (phase === undefined) {
      return
    }
    const sid = typeof message.surface === 'string' ? (this.sids.get(message.surface) ?? 0) : 0
    const [sx, sy, x, y] = [message.sx, message.sy, message.x, message.y].map((value) => Number(value) || 0)
    this.wlr.touch(phase, sid, Number(message.id) || 0, sx, sy, x, y, time(message))
  }
}

/**
 * wl_pointer.axis events for a viewer 'axis' message. A wheel click is 15 axis units and a v120 value of 120 (what
 * wl_pointer.axis_value120 carries, wlroots 0.17's `value_discrete`), so apps scroll by whole clicks; a touchpad
 * (finger source) scrolls smoothly in pixels with no discrete value. The viewer says which it is: DOM line deltas are
 * wheel clicks (Firefox: 3 lines each), and `wheelX`/`wheelY` (v120 values) mark pixel-mode clicks (Chromium).
 */
export function axisEvents(
  message: ControlMessage,
  width: number,
  height: number,
): { horizontal: boolean; value: number; discrete: number; finger: boolean }[] {
  const mode = Number(message.deltaMode) || 0
  const events = []
  for (const horizontal of [true, false]) {
    const delta = Number(horizontal ? message.deltaX : message.deltaY) || 0
    if (delta === 0) {
      continue
    }
    const wheel = Number(horizontal ? message.wheelX : message.wheelY) || 0
    if (mode === DOM_DELTA_LINE) {
      const clicks = delta / LINES_PER_CLICK
      events.push({
        horizontal,
        value: clicks * CLICK_AXIS_VALUE,
        discrete: Math.round(clicks * V120_CLICK),
        finger: false,
      })
    } else if (mode === DOM_DELTA_PAGE) {
      events.push({
        horizontal,
        value: delta * (horizontal ? width : height),
        discrete: Math.round(delta * V120_CLICK),
        finger: false,
      })
    } else if (wheel !== 0) {
      events.push({
        horizontal,
        value: (wheel / V120_CLICK) * CLICK_AXIS_VALUE,
        discrete: Math.round(wheel),
        finger: false,
      })
    } else {
      events.push({ horizontal, value: delta / 3, discrete: 0, finger: true })
    }
  }
  return events
}

/** The scene protocol's Modifiers as the native core's bits, undefined if they aren't there. */
export function modifierBits(modifiers: unknown): number | undefined {
  if (typeof modifiers !== 'object' || modifiers === null) {
    return undefined
  }
  const m = modifiers as Record<string, unknown>
  const names = ['ctrl', 'shift', 'alt', 'meta', 'altGr', 'capsLock', 'numLock']
  return names.reduce((bits, name, bit) => (m[name] === true ? bits | (1 << bit) : bits), 0)
}

function time(message: ControlMessage): number {
  return (Number(message.time) || Date.now()) >>> 0
}

/** The input region, clipped to the surface by wlroots; undefined if it's the whole surface. */
function inputRegion(rects: Int32Array, width: number, height: number): SceneRect[] | undefined {
  if (rects.length === 4 && rects[0] <= 0 && rects[1] <= 0 && rects[2] >= width && rects[3] >= height) {
    return undefined
  }
  const boxes: SceneRect[] = []
  for (let i = 0; i < rects.length; i += 4) {
    boxes.push({ x: rects[i], y: rects[i + 1], width: rects[i + 2], height: rects[i + 3] })
  }
  if (boxes.length > MAX_INPUT_RECTS) {
    const x0 = Math.min(...boxes.map((box) => box.x))
    const y0 = Math.min(...boxes.map((box) => box.y))
    const x1 = Math.max(...boxes.map((box) => box.x + box.width))
    const y1 = Math.max(...boxes.map((box) => box.y + box.height))
    return [{ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }]
  }
  return boxes
}

/** Start the session's Wayland side on wlroots, with its app processes. */
export function startWlrootsCompositor(config: {
  h264Encoder?: H264Encoder
  videoStreams?: number
  /** development only: a simulated slow link to the viewer (see SimulatedLink) */
  link?: SimulatedLink
  /** development only: the order a surface's queued patches are captured in (see PatchOrder) */
  patchOrder?: PatchOrder
  /** development only: how large damage is split into patches (see PatchShape) */
  patchShape?: PatchShape
}): {
  viewerHost: ViewerHost
  compositor: WlrCompositor
  apps: Apps
} {
  // loaded here, not at import: tests use the policy with a fake core
  /* eslint-disable @typescript-eslint/no-var-requires */
  const native = require('../addons/wlr-core-addon') as WlrNative
  const { startPoll } = require('../addons/proxy-poll-addon') as typeof import('../addons/proxy-poll-addon')
  /* eslint-enable @typescript-eslint/no-var-requires */
  const compositor = new WlrCompositor(
    {
      h264Encoder: config.h264Encoder,
      videoStreams: config.videoStreams ?? 4,
      patchOrder: config.patchOrder,
      patchShape: config.patchShape,
    },
    native,
    (fd, readable) => {
      startPoll(fd, readable)
    },
  )
  const apps = new Apps(compositor.waylandDisplay)
  apps.x11Display = compositor.x11Display
  compositor.clientListener = apps
  return { viewerHost: new ViewerHost(compositor, compositor, { link: config.link }), compositor, apps }
}

/** The scene's size limit fields: only the ones that are set (0 is unbounded). */
function limitFields([minWidth, minHeight, maxWidth, maxHeight]: [number, number, number, number]) {
  return {
    ...(minWidth > 0 ? { minWidth } : {}),
    ...(minHeight > 0 ? { minHeight } : {}),
    ...(maxWidth > 0 ? { maxWidth } : {}),
    ...(maxHeight > 0 ? { maxHeight } : {}),
  }
}
