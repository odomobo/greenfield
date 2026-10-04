/**
 * The session's Wayland side (ROADMAP.md, Core item 1): wlroots 0.17 (native/wlr-core) implements the protocols; this
 * is the policy, as the TypeScript compositor's window scene (packages/compositor/src/server/scene.ts) was: window
 * positions, stacking, focus and minimize state, frame pacing, and the encoding of every surface's content.
 *
 * The viewer, the scene protocol, the transport and the encoding policy (SurfaceEncoder) are shared with the old stack.
 *
 * This module must not import anything that loads the libwayland fork's addons (Encoder.ts, SurfaceBufferEncoding.ts,
 * wayland-server.ts, FrameFeedback.ts, legacy.ts): the fork and the system libwayland that wlroots uses share
 * the libwayland-server.so.0 soname, so only one of them can be loaded in a process. */
import type * as WlrCoreAddon from '../addons/wlr-core-addon'
import { createLogger } from '../Logger.js'
import { ProcessingDuration, scheduleFrameCallback } from '../FramePacing.js'
import { EncoderPool } from '../encoding/EncoderPool.js'
import { EncodingContext, EncodingSink, SurfaceEncoder, SurfaceHost } from '../encoding/SurfaceEncoder.js'
import { encodePng } from '../encoding/png.js'
import { Rect } from '../encoding/region.js'
import { SurfaceContent, ViewerHost, WindowSceneEndpoint } from '../viewer/ViewerHost.js'
import { ControlMessage } from '../viewer/ViewerTransport.js'
import type { Patch, SceneRect, SceneSurface, SceneWindow } from '@gfld/scene-protocol'
import { EvDevKeyCode } from './keys.js'
import { Apps } from './Apps.js'

const logger = createLogger('wlroots')
/** GFLD_WLR_TRACE=1: log wlroots events and viewer messages */
const TRACE = process.env.GFLD_WLR_TRACE === '1'

type H264Encoder = 'x264' | 'nvh264' | 'vaapih264'

/** The native core (native/wlr-core), injectable so the policy can be tested without wlroots. */
export type WlrNative = Omit<typeof WlrCoreAddon, 'create'> & {
  create(onEvent: WlrCoreAddon.EventHandler, width: number, height: number): { socket: string; fd: number }
}

/** Watches a file descriptor, calls back when it's readable (the poll addon in production). */
export type FdWatcher = (fd: number, readable: () => void) => void

/** Wayland clients coming and going, with their process (0 if unknown). */
export interface ClientListener {
  clientConnected(clientId: number, pid: number): void

  clientDisconnected(clientId: number): void
}

/** Input regions with more rectangles than this are sent as their bounding box. */
const MAX_INPUT_RECTS = 64

/** DOM button to Linux input button code */
const LINUX_BUTTONS: Record<number, number> = { 0: 0x110, 1: 0x112, 2: 0x111, 3: 0x113, 4: 0x114 }
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2
const LINE_SCROLL_AMOUNT = 12

/** A pooled GStreamer video encoder that encodes surfaces' current wlroots buffers. */
class WlrEncoder {
  private readonly native: WlrCoreAddon.FrameEncoder
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
  processing: ProcessingDuration
  frameScheduled: boolean
}

type Window = {
  sid: number
  title: string
  appId: string
  parent?: number
  placed: boolean
  minimized: boolean
  /** position of the main surface's origin; a child window's is relative to its parent */
  x: number
  y: number
  /** the last window change sequence number from the viewer applied to this window (scene protocol) */
  seq: number
}

const inactiveSink: EncodingSink = {
  active: false,
  sendFrame: () => undefined,
  sendPatch: (_surface: string, _patch: Patch, done: (sent: boolean) => void) => done(false),
  requireKeyFrame: () => undefined,
  dropPatches: () => undefined,
}

export class WlrCompositor implements WindowSceneEndpoint, SurfaceContent {
  readonly waylandDisplay: string
  private send?: (message: ControlMessage) => void
  private sink: EncodingSink = inactiveSink
  private readonly encoding: EncodingContext<WlrEncoder>
  private readonly surfaces = new Map<number, Surface>()
  private readonly sids = new Map<string, number>()
  private readonly windows = new Map<number, Window>()
  /** window sids, bottom to top */
  private stack: number[] = []
  private active = 0
  private pageFocused = true
  private contentSerial = 0
  private output = { width: 1280, height: 720 }
  private lastSceneJSON = ''
  private sceneScheduled = false
  viewerScale = 1
  clientListener?: ClientListener

  constructor(
    config: { h264Encoder: H264Encoder; videoStreams: number },
    private readonly wlr: WlrNative,
    watchFd: FdWatcher,
  ) {
    const currentSink = () => this.sink
    const forwardingSink: EncodingSink = {
      get active() {
        return currentSink().active
      },
      sendFrame: (surface, frame) => this.sink.sendFrame(surface, frame),
      sendPatch: (surface, patch, done) => this.sink.sendPatch(surface, patch, done),
      requireKeyFrame: (surface) => this.sink.requireKeyFrame(surface),
      dropPatches: (surface) => this.sink.dropPatches(surface),
    }
    const pool = new EncoderPool(() => new WlrEncoder(wlr, config.h264Encoder), config.videoStreams)
    pool.warm()
    this.encoding = new EncodingContext(forwardingSink, pool, encodePng, logger)
    this.encoding.startTicking()

    const { socket, fd } = this.wlr.create(
      (type, ...args) => this.onEvent(type, args),
      this.output.width,
      this.output.height,
    )
    this.waylandDisplay = socket
    watchFd(fd, () => this.wlr.dispatch())
    logger.info(`Listening on: WAYLAND_DISPLAY="${socket}" (wlroots).`)
  }

  // -------------------------------------------------------------------------------------------------------------------
  // SurfaceContent

  setFrameSink(sink: EncodingSink): void {
    this.sink = sink
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
          processing: new ProcessingDuration(),
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
          x: 0,
          y: 0,
          seq: 0,
        })
        break
      case 'toplevel-destroy': {
        const window = this.windows.get(args[0])
        this.windows.delete(args[0])
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
        // not part of the prototype: answer with the current state, as xdg-shell requires
        this.wlr.configure(args[0], -1, -1, {})
        break
      case 'toplevel-request-minimize': {
        const window = this.windows.get(args[0])
        if (window) {
          this.setMinimized(this.rootOf(window), true)
        }
        break
      }
      case 'cursor-surface': {
        const [sid, x, y] = args as [number, number, number]
        this.send?.(
          sid
            ? { type: 'cursor', kind: 'surface', surface: this.keyOf(sid), hotspot: { x, y } }
            : {
                type: 'cursor',
                kind: 'hidden',
              },
        )
        break
      }
      case 'cursor-shape':
        this.send?.({ type: 'cursor', kind: 'named', name: args[0] })
        break
    }
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
    const commitTimestamp = performance.now()
    surface.width = width
    surface.height = height
    surface.input = inputRegion(input, width, height)

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
      void this.encoderOf(surface)
        .commit(damage)
        .then(() => surface.processing.record(commitTimestamp))
    }

    if (hasFrameCallbacks && !surface.frameScheduled) {
      surface.frameScheduled = true
      scheduleFrameCallback(surface.processing.average, (time) => {
        surface.frameScheduled = false
        if (this.surfaces.get(sid) === surface) {
          this.wlr.sendFrameDone(sid, time)
        }
      })
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
        readPixels: (rect) => this.wlr.readPixels(surface.sid, rect.x, rect.y, rect.width, rect.height),
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
      // a child window (dialog) is centered on its parent, the viewer only places top level windows
      const [px, py, pw, ph] = parentState.geometry
      const [cx, cy, cw, ch] = state.geometry
      window.x = Math.round(px + pw / 2 - (cx + cw / 2))
      window.y = Math.round(py + ph / 2 - (cy + ch / 2))
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

  private rootOf(window: Window): Window {
    let root = window
    while (root.parent !== undefined && this.windows.has(root.parent)) {
      root = this.windows.get(root.parent)!
    }
    return root
  }

  /** Absolute position of a window's main surface. */
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
      // raise it, with its children above it
      this.stack = this.stack.filter((other) => other !== sid)
      this.stack.push(sid)
    }
    this.wlr.keyboardFocus(this.pageFocused ? sid : 0)
    this.scheduleScene()
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

  private setMaximized(sid: number, maximized: boolean) {
    if (maximized) {
      this.wlr.configure(sid, this.output.width, this.output.height, { maximized: true })
    } else {
      this.wlr.configure(sid, 0, 0, { maximized: false })
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // WindowSceneEndpoint: server -> viewer

  attach(send: (message: ControlMessage) => void): void {
    this.send = send
    this.lastSceneJSON = ''
    this.sendSceneIfChanged()
    send({ type: 'cursor', kind: 'default' })
  }

  detach(): void {
    this.send = undefined
    this.wlr.keyboardFocus(0)
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
    if (json !== this.lastSceneJSON) {
      this.lastSceneJSON = json
      this.send(scene)
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
      // maximized and fullscreen windows cover the output; their own position is kept for when they're restored
      const { x, y } =
        state.maximized || state.fullscreen ? { x: -state.geometry[0], y: -state.geometry[1] } : this.positionOf(window)
      const parent = window.parent === undefined ? undefined : this.surfaces.get(window.parent)
      windows.push({
        id: surface.key,
        parent: parent?.mapped ? parent.key : undefined,
        title: window.title,
        appId: window.appId,
        activated: this.active === window.sid,
        maximized: state.maximized,
        fullscreen: state.fullscreen,
        minimized: this.rootOf(window).minimized,
        placed: window.placed,
        seq: window.seq,
        x,
        y,
        geometry: { x: state.geometry[0], y: state.geometry[1], width: state.geometry[2], height: state.geometry[3] },
        configuredSize: { width: state.configured[0], height: state.configured[1] },
        surfaces: this.windowSurfaces(window.sid),
      })
    }
    return windows
  }

  private windowSurfaces(sid: number): SceneSurface[] {
    const surfaces: SceneSurface[] = []
    for (const [childSid, x, y] of this.wlr.windowSurfaces(sid)) {
      const surface = this.surfaces.get(childSid)
      if (surface?.buffer) {
        surfaces.push({ id: surface.key, x, y, width: surface.width, height: surface.height, input: surface.input })
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
        this.pointerMotion(message)
        break
      case 'button':
        this.pointerMotion(message)
        this.wlr.pointerButton(LINUX_BUTTONS[Number(message.button)] ?? 0x110, Boolean(message.pressed), time(message))
        break
      case 'axis':
        this.pointerMotion(message)
        this.pointerAxis(message)
        break
      case 'key': {
        const code: number | undefined = EvDevKeyCode[message.code as keyof typeof EvDevKeyCode]
        if (code !== undefined) {
          this.wlr.key(code, Boolean(message.pressed), time(message))
        }
        break
      }
      case 'focus':
        this.pageFocused = Boolean(message.focused)
        this.wlr.keyboardFocus(this.pageFocused ? this.active : 0)
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
          this.wlr.close(window.sid)
        }
        break
      }
      default:
        logger.info(`Unhandled viewer message: ${message.type}`)
    }
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
    if (scale > 0 && scale <= 16) {
      this.viewerScale = scale
    }
    const width = Math.round(Number(size.width))
    const height = Math.round(Number(size.height))
    if (!(width > 0 && height > 0)) {
      return
    }
    this.output = { width, height }
    this.wlr.setOutputSize(width, height)
    for (const window of this.windows.values()) {
      if (this.wlr.toplevelState(window.sid)?.maximized) {
        this.setMaximized(window.sid, true)
      }
    }
  }

  private pointerMotion(message: ControlMessage) {
    const sid = typeof message.surface === 'string' ? this.sids.get(message.surface) ?? 0 : 0
    if (sid === 0) {
      this.send?.({ type: 'cursor', kind: 'default' })
    }
    this.wlr.pointerMotion(sid, Number(message.sx) || 0, Number(message.sy) || 0, time(message))
  }

  private pointerAxis(message: ControlMessage) {
    const mode = Number(message.deltaMode) || 0
    const surface = this.surfaces.get(this.sids.get(String(message.surface)) ?? 0)
    const scale = (delta: number, page: number) =>
      mode === DOM_DELTA_LINE ? delta * LINE_SCROLL_AMOUNT : mode === DOM_DELTA_PAGE ? delta * page : delta / 3
    const deltaX = Number(message.deltaX) || 0
    const deltaY = Number(message.deltaY) || 0
    if (deltaX) {
      this.wlr.pointerAxis(
        true,
        scale(deltaX, surface?.width ?? 0),
        mode === DOM_DELTA_LINE ? Math.sign(deltaX) : 0,
        time(message),
      )
    }
    if (deltaY) {
      this.wlr.pointerAxis(
        false,
        scale(deltaY, surface?.height ?? 0),
        mode === DOM_DELTA_LINE ? Math.sign(deltaY) : 0,
        time(message),
      )
    }
  }
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
export function startWlrootsCompositor(config: { h264Encoder: H264Encoder; videoStreams?: number }): {
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
    { h264Encoder: config.h264Encoder, videoStreams: config.videoStreams ?? 4 },
    native,
    (fd, readable) => {
      startPoll(fd, readable)
    },
  )
  const apps = new Apps(compositor.waylandDisplay)
  compositor.clientListener = apps
  return { viewerHost: new ViewerHost(compositor, compositor), compositor, apps }
}
