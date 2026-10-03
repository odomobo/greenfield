import { Connection } from './connection'
import { KeyFrameNeeded, SurfaceDecoder } from './decoder'
import { Rect, Renderer } from './gl/renderer'
import { Animation, EASE_IN, EASE_OUT, lerpRect } from './animation'
import { parseEncodedFrame, Patch, SceneSurface, SceneWindow, ServerMessage, ViewerMessage } from './protocol'

type Point = { x: number; y: number }

type Pick = { window: SceneWindow; surface: string; sx: number; sy: number }

type Size = { width: number; height: number }

type Interaction =
  | { mode: 'move'; window: string; startPointer: Point; startPosition: Point; lastSent: number }
  /** startRect: the window geometry rect (output coordinates) when the resize started */
  | { mode: 'resize'; window: string; edges: number; startPointer: Point; startRect: Rect }

/**
 * A window being resized is shown at the size the user is dragging to, without waiting for the client: its latest
 * content is stretched into `rect` (window geometry, output coordinates). Once the drag ended and the client committed
 * the final size, the window is positioned so the anchored edges stay put and the override is dropped.
 */
type ResizeOverride = { rect: Rect; edges: number; finalSize?: Size; settleTimer?: ReturnType<typeof setTimeout> }

/**
 * A minimize, restore, maximize or unmaximize being animated: the window's latest content is scaled from one rect to
 * another (window geometry, output coordinates), nothing is resized on the client for it. A maximize/unmaximize keeps
 * showing the end rect after the animation until the client committed the new state (or SETTLE_TIMEOUT).
 */
type WindowAnimation = {
  kind: 'minimize' | 'restore' | 'maximize' | 'unmaximize'
  animation: Animation
  from: Rect
  to: Rect
  fromOpacity: number
  toOpacity: number
  /** maximize/unmaximize: when to give up waiting for the client after the animation ended */
  deadline?: number
}

type Cursor =
  | { kind: 'default' | 'hidden' }
  | { kind: 'named'; name: string }
  | { kind: 'surface'; surface: string; hotspot: Point }

// xdg_toplevel resize edges
const EDGE_TOP = 1
const EDGE_BOTTOM = 2
const EDGE_LEFT = 4
const EDGE_RIGHT = 8

const MOVE_SEND_INTERVAL = 50
/** How much of a window (geometry) must stay inside the output, so it can always be grabbed and moved back. */
const MIN_VISIBLE = 80
/** Give up waiting for a client to commit the final size of a resize after this long. */
const RESIZE_SETTLE_TIMEOUT = 2000
/** Durations of the window state animations, ms. Subtle and short. */
const STATE_ANIMATION_MS = 150

export type ShellWindow = SceneWindow & { shownMinimized: boolean }

/**
 * The viewer side of a session: shows the server's window scene and acts as its window manager. Everything that
 * doesn't need session state happens here (rendering, hit testing, implicit grabs, interactive move/resize, placement);
 * decisions are reported to the server, which stores them.
 */
export class Desktop {
  private windows: SceneWindow[] = []
  /** window positions overridden locally during an interactive move, until the server confirms them */
  private readonly localPositions = new Map<string, Point>()
  private readonly resizeOverrides = new Map<string, ResizeOverride>()
  private output: Size = { width: 0, height: 0 }
  private readonly placementSent = new Set<string>()
  private readonly decoders = new Map<string, SurfaceDecoder>()
  private readonly keyFrameRequested = new Set<string>()
  private cursor: Cursor = { kind: 'default' }
  /** minimized state the viewer asked for, until the server's scene agrees */
  private readonly localMinimized = new Map<string, boolean>()
  private readonly animations = new Map<string, WindowAnimation>()
  /** geometry of windows before they were maximized, to animate back to */
  private readonly restoreRects = new Map<string, Rect>()

  /** Called whenever the window list or a window's state changes. */
  onWindowsChanged: (windows: ShellWindow[]) => void = () => {
    /* noop */
  }
  /** Where a window goes when minimized (its taskbar button), in page coordinates. */
  minimizeTarget: (window: string) => DOMRect | undefined = () => undefined

  private pointer: Point = { x: 0, y: 0 }
  /** where the current button press started; interactions the client starts on a press are measured from here */
  private pressPointer: Point = { x: 0, y: 0 }
  private buttons = 0
  /** implicit grab: while a button is held, pointer events go to the surface the press started on */
  private grab?: Pick
  private interaction?: Interaction
  private pendingResize?: { window: string; width: number; height: number; edges: number }

  private renderScheduled = false
  private readonly decodeDurations: number[] = []
  private lastFrameTimestamp = 0
  private refreshInterval = 16

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: Renderer,
    private readonly connection: Connection,
  ) {
    this.installInputHandlers()
    new ResizeObserver(() => {
      const output = this.renderer.resize()
      this.output = output
      this.connection.send({ type: 'output', width: output.width, height: output.height })
      this.keepWindowsVisible()
      this.scheduleRender()
    }).observe(canvas)
    setInterval(() => this.sendFeedback(), 500)
    this.measureRefreshRate()
  }

  /**
   * A new connection: everything we had is stale, the server sends a full snapshot and key frames.
   */
  reset(): void {
    this.clear()
    const output = this.renderer.resize()
    this.output = output
    this.connection.send({ type: 'hello', output })
    if (document.hasFocus() && document.activeElement === this.canvas) {
      this.connection.send({ type: 'focus', focused: true })
    }
  }

  /**
   * Forget the session's windows and content (disconnected, or about to connect to another session).
   */
  clear(): void {
    for (const decoder of this.decoders.values()) {
      decoder.close()
    }
    this.decoders.clear()
    this.frameSizes.clear()
    this.keyFrameRequested.clear()
    this.renderer.clearAll()
    this.windows = []
    this.localPositions.clear()
    for (const override of this.resizeOverrides.values()) {
      clearTimeout(override.settleTimer)
    }
    this.resizeOverrides.clear()
    this.placementSent.clear()
    this.localMinimized.clear()
    this.animations.clear()
    this.restoreRects.clear()
    this.grab = undefined
    this.interaction = undefined
    this.buttons = 0
    this.scheduleRender()
    this.onWindowsChanged([])
  }

  /**
   * Current windows as shown (with local position overrides). For tests.
   */
  debugWindows(): (SceneWindow & { shownX: number; shownY: number; shownGeometry: Rect; hasContent: boolean })[] {
    return this.windows.map((window) => {
      const position = this.windowPosition(window)
      return {
        ...window,
        shownX: position.x,
        shownY: position.y,
        shownGeometry: this.shownGeometry(window),
        hasContent: window.surfaces.every((surface) => this.renderer.hasContent(surface.id)),
      }
    })
  }

  /** The output size the viewer reports. For tests. */
  debugOutput(): Size {
    return this.output
  }

  /** The running move/resize interaction, if any. For tests. */
  debugInteraction(): string | null {
    return this.interaction?.mode ?? null
  }

  /** Whether a resize is still waiting for its client to commit the final size. For tests. */
  debugResizing(): boolean {
    return this.resizeOverrides.size > 0
  }

  /** Running state animations by window. For tests. */
  debugAnimations(): Record<string, string> {
    return Object.fromEntries([...this.animations].map(([id, { kind }]) => [id, kind]))
  }

  // -------------------------------------------------------------------------------------------------------------------
  // window management for the shell (taskbar)

  private isMinimized(window: SceneWindow): boolean {
    return this.localMinimized.get(window.id) ?? window.minimized
  }

  /** Minimized and not animating anymore: not shown, not pickable. */
  private isHidden(window: SceneWindow): boolean {
    const animation = this.animations.get(window.id)
    return this.isMinimized(window) && animation?.kind !== 'minimize'
  }

  /** Give the keyboard to the session. */
  focus(): void {
    this.canvas.focus()
  }

  shellWindows(): ShellWindow[] {
    return this.windows.map((window) => ({ ...window, shownMinimized: this.isMinimized(window) }))
  }

  private notifyWindowsChanged() {
    this.onWindowsChanged(this.shellWindows())
  }

  /** Bring a window to the front and give it the keyboard, restoring it if it's minimized. */
  activateWindow(id: string): void {
    const window = this.windows.find((w) => w.id === id)
    if (window === undefined) {
      return
    }
    if (this.isMinimized(window)) {
      this.startRestoreAnimation(window)
      this.localMinimized.set(id, false)
    }
    this.connection.send({ type: 'window.activate', window: id })
    this.canvas.focus()
    this.notifyWindowsChanged()
    this.scheduleRender()
  }

  minimizeWindow(id: string): void {
    const window = this.windows.find((w) => w.id === id)
    if (window === undefined || this.isMinimized(window)) {
      return
    }
    this.startMinimizeAnimation(window)
    this.localMinimized.set(id, true)
    // the server moves the keyboard focus to the next window
    this.connection.send({ type: 'window.minimize', window: id, minimized: true })
    this.notifyWindowsChanged()
    this.scheduleRender()
  }

  setMaximized(id: string, maximized: boolean): void {
    const window = this.windows.find((w) => w.id === id)
    if (window === undefined || window.fullscreen) {
      return
    }
    if (this.isMinimized(window)) {
      this.activateWindow(id)
    }
    // ask right away, the animation runs while the client redraws
    this.connection.send({ type: 'window.maximize', window: id, maximized })
    this.startMaximizeAnimation(window, maximized)
  }

  closeWindow(id: string): void {
    this.connection.send({ type: 'window.close', window: id })
  }

  /**
   * The window's current content scaled to fit maxWidth x maxHeight, for previews. Works for minimized windows too.
   */
  renderPreview(id: string, maxWidth: number, maxHeight: number): ImageData | undefined {
    const window = this.windows.find((w) => w.id === id)
    if (window === undefined || window.geometry.width <= 0 || window.geometry.height <= 0) {
      return undefined
    }
    const { geometry } = window
    const scale = Math.min(maxWidth / geometry.width, maxHeight / geometry.height, 1)
    const width = Math.max(1, Math.round(geometry.width * scale))
    const height = Math.max(1, Math.round(geometry.height * scale))
    const draws = window.surfaces.map((surface) => ({
      surface: surface.id,
      rect: {
        x: (surface.x - geometry.x) * scale,
        y: (surface.y - geometry.y) * scale,
        width: surface.width * scale,
        height: surface.height * scale,
      },
    }))
    return this.renderer.snapshot(draws, width, height)
  }

  // -------------------------------------------------------------------------------------------------------------------
  // state animations

  /** The taskbar button rect, in output coordinates, or a spot above the window if there's no button. */
  private minimizedRect(window: SceneWindow, from: Rect): Rect {
    const target = this.minimizeTarget(window.id)
    const canvasRect = this.canvas.getBoundingClientRect()
    const centerX = target ? target.x + target.width / 2 - canvasRect.x : from.x + from.width / 2
    const centerY = target ? target.y + target.height / 2 - canvasRect.y : -24
    // shrink to about twice the button's width
    const scale = Math.min(1, ((target?.width ?? 40) * 2) / Math.max(1, from.width))
    const width = from.width * scale
    const height = from.height * scale
    return { x: centerX - width / 2, y: centerY - height / 2, width, height }
  }

  private currentRect(window: SceneWindow): Rect {
    return this.shownGeometry(window)
  }

  private startMinimizeAnimation(window: SceneWindow, from = this.currentRect(window)) {
    this.animations.set(window.id, {
      kind: 'minimize',
      animation: new Animation(STATE_ANIMATION_MS, EASE_IN),
      from,
      to: this.minimizedRect(window, from),
      fromOpacity: 1,
      toOpacity: 1,
    })
    this.interruptInteraction(window.id)
  }

  private startRestoreAnimation(window: SceneWindow) {
    const to = this.restingRect(window)
    this.animations.set(window.id, {
      kind: 'restore',
      animation: new Animation(STATE_ANIMATION_MS, EASE_OUT),
      from: this.minimizedRect(window, to),
      to,
      fromOpacity: 1,
      toOpacity: 1,
    })
  }

  private startMaximizeAnimation(window: SceneWindow, maximized: boolean) {
    const from = this.currentRect(window)
    let to: Rect | undefined
    if (maximized) {
      if (!window.maximized) {
        this.restoreRects.set(window.id, from)
      }
      to = { x: 0, y: 0, width: this.output.width, height: this.output.height }
    } else {
      // where it was before it was maximized; unknown if it was maximized before we attached: no animation
      to = this.restoreRects.get(window.id)
      this.restoreRects.delete(window.id)
    }
    if (to === undefined || this.isHidden(window)) {
      return
    }
    this.interruptInteraction(window.id)
    this.animations.set(window.id, {
      kind: maximized ? 'maximize' : 'unmaximize',
      // maximize starts slow and accelerates out, restore starts fast and eases out
      animation: new Animation(STATE_ANIMATION_MS, maximized ? EASE_IN : EASE_OUT),
      from,
      to,
      fromOpacity: 1,
      toOpacity: 1,
    })
    this.scheduleRender()
  }

  /** Where a window rests when it's not animating: its scene geometry (or the rect of a resize in progress). */
  private restingRect(window: SceneWindow): Rect {
    const override = this.resizeOverrides.get(window.id)
    if (override) {
      return override.rect
    }
    const position = this.windowPosition(window)
    return {
      x: position.x + window.geometry.x,
      y: position.y + window.geometry.y,
      width: window.geometry.width,
      height: window.geometry.height,
    }
  }

  /** A state change of the window ends a move/resize of it. */
  private interruptInteraction(id: string) {
    if (this.interaction?.window === id) {
      this.interaction = undefined
      this.applyCursor()
    }
    const override = this.resizeOverrides.get(id)
    if (override) {
      clearTimeout(override.settleTimer)
      this.resizeOverrides.delete(id)
    }
  }

  /** The animated rect and opacity of a window right now, if it's animating. */
  private animatedState(window: SceneWindow): { rect: Rect; opacity: number } | undefined {
    const state = this.animations.get(window.id)
    if (state === undefined) {
      return undefined
    }
    const progress = state.animation.progress()
    return {
      rect: lerpRect(state.from, state.to, progress),
      opacity: state.fromOpacity + (state.toOpacity - state.fromOpacity) * progress,
    }
  }

  /** Has the client caught up with the state a maximize/unmaximize animation shows? */
  private animationSettled(window: SceneWindow, state: WindowAnimation): boolean {
    if (state.kind === 'maximize') {
      return window.maximized && this.clientCaughtUp(window, { width: state.to.width, height: state.to.height })
    }
    return !window.maximized
  }

  /** Drop finished animations. Returns whether any are still running (and need frames). */
  private advanceAnimations(): boolean {
    const now = performance.now()
    let running = false
    let changed = false
    for (const [id, state] of [...this.animations]) {
      const window = this.windows.find((w) => w.id === id)
      if (window === undefined) {
        this.animations.delete(id)
        continue
      }
      if (!state.animation.done(now)) {
        running = true
        continue
      }
      if (state.kind === 'maximize' || state.kind === 'unmaximize') {
        if (state.deadline === undefined) {
          state.deadline = now + RESIZE_SETTLE_TIMEOUT
          setTimeout(() => this.scheduleRender(), RESIZE_SETTLE_TIMEOUT + 1)
        }
        // hold the end rect until the client committed; a scene update or the deadline ends it
        if (!this.animationSettled(window, state) && now < state.deadline) {
          continue
        }
      }
      this.animations.delete(id)
      changed = true
    }
    if (changed) {
      this.keepWindowsVisible()
    }
    return running
  }

  // -------------------------------------------------------------------------------------------------------------------
  // server -> viewer

  handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'scene':
        this.updateScene(message.windows)
        break
      case 'cursor':
        this.cursor = message
        this.applyCursor()
        break
      case 'interactive':
        this.startInteraction(message)
        break
      case 'maximize-requested': {
        const window = this.windows.find((w) => w.id === message.window)
        if (window) {
          this.startMaximizeAnimation(window, message.maximized)
        }
        break
      }
    }
  }

  private decoderFor(surface: string): SurfaceDecoder {
    let decoder = this.decoders.get(surface)
    if (decoder === undefined) {
      decoder = new SurfaceDecoder()
      this.decoders.set(surface, decoder)
    }
    return decoder
  }

  /** A whole-surface video frame. */
  handleFrame(surface: string, data: Uint8Array): void {
    const frame = parseEncodedFrame(data)
    this.frameSizes.set(surface, frame.size)
    const start = performance.now()
    this.decoderFor(surface)
      .decode(frame)
      .then(
        (decoded) => {
          this.recordDecodeDuration(performance.now() - start)
          this.keyFrameRequested.delete(surface)
          this.renderer.upload(surface, decoded)
          this.scheduleRender()
        },
        (error) => this.decodeFailed(surface, error),
      )
  }

  /** A lossless update of part of a surface, drawn over what it shows now (applied right away, in order). */
  handlePatch(surface: string, patch: Patch): void {
    this.frameSizes.set(surface, patch.surfaceSize)
    const start = performance.now()
    this.decoderFor(surface)
      .decodePatch(patch)
      .then(
        (decoded) => {
          this.recordDecodeDuration(performance.now() - start)
          this.keyFrameRequested.delete(surface)
          this.renderer.patch(surface, decoded)
          this.scheduleRender()
        },
        (error) => this.decodeFailed(surface, error),
      )
  }

  /** Ask the server for the whole surface again (once until something decodes). */
  private decodeFailed(surface: string, error: unknown) {
    if (!(error instanceof KeyFrameNeeded)) {
      console.warn(`Failed to decode content of surface ${surface}:`, error)
    }
    if (!this.keyFrameRequested.has(surface)) {
      this.keyFrameRequested.add(surface)
      this.connection.send({ type: 'keyframe', surface })
    }
  }

  private updateScene(windows: SceneWindow[]) {
    const previous = new Map(this.windows.map((window) => [window.id, window]))
    const previousRects = new Map(this.windows.map((window) => [window.id, this.shownGeometry(window)]))
    this.windows = windows
    for (const window of windows) {
      const local = this.localMinimized.get(window.id)
      if (local !== undefined) {
        if (local === window.minimized) {
          this.localMinimized.delete(window.id)
        }
        continue
      }
      // minimized or restored by the client or another viewer
      const before = previous.get(window.id)
      if (before && before.minimized !== window.minimized && !this.animations.has(window.id)) {
        if (window.minimized) {
          this.startMinimizeAnimation(window, previousRects.get(window.id))
        } else {
          this.startRestoreAnimation(window)
        }
      }
    }
    for (const id of [...this.localMinimized.keys()]) {
      if (!windows.some((window) => window.id === id)) {
        this.localMinimized.delete(id)
      }
    }
    for (const id of [...this.restoreRects.keys()]) {
      if (!windows.some((window) => window.id === id)) {
        this.restoreRects.delete(id)
      }
    }
    const surfaces = new Set<string>()
    let placedCount = 0
    for (const window of windows) {
      for (const surface of window.surfaces) {
        surfaces.add(surface.id)
      }
      // drop local overrides the server caught up with
      const local = this.localPositions.get(window.id)
      if (local && local.x === window.x && local.y === window.y && this.interaction?.window !== window.id) {
        this.localPositions.delete(window.id)
      }
      if (window.placed) {
        placedCount++
      }
    }
    for (const id of [...this.localPositions.keys()]) {
      if (!windows.some((window) => window.id === id)) {
        this.localPositions.delete(id)
      }
    }
    for (const [id, override] of [...this.resizeOverrides]) {
      const window = windows.find((w) => w.id === id)
      if (window === undefined) {
        clearTimeout(override.settleTimer)
        this.resizeOverrides.delete(id)
      } else if (override.finalSize && this.clientCaughtUp(window, override.finalSize)) {
        this.settleResize(window)
      }
    }
    for (const [id, state] of [...this.animations]) {
      const window = windows.find((w) => w.id === id)
      if (
        window &&
        (state.kind === 'maximize' || state.kind === 'unmaximize') &&
        state.animation.done() &&
        this.animationSettled(window, state)
      ) {
        this.animations.delete(id)
      }
    }
    // the viewer decides where new windows go
    for (const window of windows) {
      if (window.placed || window.maximized || window.fullscreen || this.placementSent.has(window.id)) {
        continue
      }
      this.placementSent.add(window.id)
      const cascade = 40 + (placedCount++ % 10) * 32
      const position = this.keepVisible(window, { x: cascade - window.geometry.x, y: cascade - window.geometry.y })
      this.localPositions.set(window.id, position)
      this.connection.send({ type: 'window.move', window: window.id, ...position })
    }
    // also covers positions chosen by the server or client (e.g. dialogs) and windows coming back after a reattach
    this.keepWindowsVisible()
    // Content of surfaces that are gone. The cursor surface isn't part of any window.
    const cursorSurface = this.cursor.kind === 'surface' ? this.cursor.surface : undefined
    for (const surface of [...this.decoders.keys()]) {
      if (!surfaces.has(surface) && surface !== cursorSurface && !this.isLiveSurface(surface)) {
        this.decoders.get(surface)?.close()
        this.decoders.delete(surface)
        this.frameSizes.delete(surface)
        this.renderer.delete(surface)
      }
    }
    this.scheduleRender()
    this.notifyWindowsChanged()
  }

  /**
   * Surfaces can have content before they show up in the scene (e.g. a window that isn't mapped yet), only forget
   * surfaces of clients that are gone.
   */
  private isLiveSurface(surface: string): boolean {
    const clientId = surface.substring(0, surface.lastIndexOf('/'))
    return this.windows.some((window) => window.id.startsWith(`${clientId}/`))
  }

  private windowPosition(window: SceneWindow): Point {
    return this.localPositions.get(window.id) ?? { x: window.x, y: window.y }
  }

  /** The window geometry rect as shown, in output coordinates. */
  private shownGeometry(window: SceneWindow): Rect {
    return this.animatedState(window)?.rect ?? this.restingRect(window)
  }

  /**
   * Where each surface of a window is shown, in output coordinates. A window being resized is stretched so its
   * geometry fills the override rect.
   */
  private surfaceRects(window: SceneWindow): { surface: SceneSurface; rect: Rect; scaleX: number; scaleY: number }[] {
    const target = this.animatedState(window)?.rect ?? this.resizeOverrides.get(window.id)?.rect
    const { geometry } = window
    if (target === undefined || geometry.width <= 0 || geometry.height <= 0) {
      const position = this.windowPosition(window)
      return window.surfaces.map((surface) => ({
        surface,
        rect: { x: position.x + surface.x, y: position.y + surface.y, width: surface.width, height: surface.height },
        scaleX: 1,
        scaleY: 1,
      }))
    }
    const scaleX = target.width / geometry.width
    const scaleY = target.height / geometry.height
    return window.surfaces.map((surface) => ({
      surface,
      rect: {
        x: target.x + (surface.x - geometry.x) * scaleX,
        y: target.y + (surface.y - geometry.y) * scaleY,
        width: surface.width * scaleX,
        height: surface.height * scaleY,
      },
      scaleX,
      scaleY,
    }))
  }

  /**
   * A position for the window such that at least MIN_VISIBLE of its geometry is inside the output and its top edge
   * (where client side title bars are) isn't above the output, so it can always be grabbed and moved back.
   */
  private keepVisible(window: SceneWindow, position: Point): Point {
    const { geometry } = window
    if (this.output.width <= 0 || this.output.height <= 0) {
      return position
    }
    const visibleWidth = Math.min(MIN_VISIBLE, geometry.width)
    const visibleHeight = Math.min(MIN_VISIBLE, geometry.height)
    let x = position.x + geometry.x
    let y = position.y + geometry.y
    x = Math.max(visibleWidth - geometry.width, Math.min(x, this.output.width - visibleWidth))
    y = Math.max(0, Math.min(y, this.output.height - visibleHeight))
    return { x: Math.round(x - geometry.x), y: Math.round(y - geometry.y) }
  }

  /** Move windows that ended up (mostly) outside the output back in, and tell the server. */
  private keepWindowsVisible() {
    for (const window of this.windows) {
      if (
        window.maximized ||
        window.fullscreen ||
        !window.placed ||
        this.resizeOverrides.has(window.id) ||
        this.animations.has(window.id) ||
        this.interaction?.window === window.id
      ) {
        continue
      }
      const position = this.windowPosition(window)
      const visible = this.keepVisible(window, position)
      if (visible.x !== position.x || visible.y !== position.y) {
        this.localPositions.set(window.id, visible)
        this.connection.send({ type: 'window.move', window: window.id, ...visible })
        this.scheduleRender()
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // rendering

  scheduleRender(): void {
    if (this.renderScheduled) {
      return
    }
    this.renderScheduled = true
    requestAnimationFrame(() => {
      this.renderScheduled = false
      this.render()
    })
  }

  private render() {
    const animating = this.advanceAnimations()
    this.renderer.beginFrame()
    for (const window of this.windows) {
      if (this.isHidden(window)) {
        continue
      }
      const opacity = this.animatedState(window)?.opacity ?? 1
      for (const { surface, rect } of this.surfaceRects(window)) {
        this.renderer.drawSurface(surface.id, rect, opacity)
      }
    }
    if (animating) {
      this.scheduleRender()
    }
    if (this.cursor.kind === 'surface') {
      const { surface, hotspot } = this.cursor
      const size = this.cursorSize(surface)
      if (size) {
        this.renderer.drawSurface(surface, {
          x: this.pointer.x - hotspot.x,
          y: this.pointer.y - hotspot.y,
          width: size.width,
          height: size.height,
        })
      }
    }
  }

  /**
   * Latest frame size per surface. Cursor surfaces aren't part of the scene, so this is where their size comes from.
   */
  private readonly frameSizes = new Map<string, { width: number; height: number }>()

  private cursorSize(surface: string): { width: number; height: number } | undefined {
    return this.frameSizes.get(surface)
  }

  private applyCursor() {
    switch (this.cursor.kind) {
      case 'default':
        this.canvas.style.cursor = 'default'
        break
      case 'hidden':
      case 'surface':
        // client cursors are drawn by the renderer
        this.canvas.style.cursor = 'none'
        break
      case 'named':
        this.canvas.style.cursor = this.cursor.name
        break
    }
    this.scheduleRender()
  }

  // -------------------------------------------------------------------------------------------------------------------
  // input

  private pick(point: Point): Pick | undefined {
    for (let w = this.windows.length - 1; w >= 0; w--) {
      const window = this.windows[w]
      const kind = this.animations.get(window.id)?.kind
      if (this.isHidden(window) || kind === 'minimize' || kind === 'restore') {
        continue
      }
      const rects = this.surfaceRects(window)
      for (let s = rects.length - 1; s >= 0; s--) {
        const { surface, rect, scaleX, scaleY } = rects[s]
        // TODO respect the surface input region (e.g. client side shadows)
        if (
          point.x >= rect.x &&
          point.y >= rect.y &&
          point.x < rect.x + rect.width &&
          point.y < rect.y + rect.height
        ) {
          return { window, surface: surface.id, sx: (point.x - rect.x) / scaleX, sy: (point.y - rect.y) / scaleY }
        }
      }
    }
    return undefined
  }

  /**
   * Re-resolve a grabbed surface's local coordinates, the window may have moved since the press.
   */
  private grabTarget(point: Point): Pick | undefined {
    if (this.grab === undefined) {
      return undefined
    }
    const window = this.windows.find((w) => w.id === this.grab!.window.id)
    const placed = window && this.surfaceRects(window).find(({ surface }) => surface.id === this.grab!.surface)
    if (window === undefined || placed === undefined) {
      return undefined
    }
    const { surface, rect, scaleX, scaleY } = placed
    return {
      window,
      surface: surface.id,
      sx: (point.x - rect.x) / scaleX,
      sy: (point.y - rect.y) / scaleY,
    }
  }

  private target(point: Point, time: number) {
    const pick = this.grab ? this.grabTarget(point) : this.pick(point)
    return {
      surface: pick?.surface ?? null,
      sx: pick?.sx,
      sy: pick?.sy,
      x: point.x,
      y: point.y,
      time: Math.round(time),
    }
  }

  private installInputHandlers() {
    const canvas = this.canvas
    const point = (event: MouseEvent): Point => ({ x: event.offsetX, y: event.offsetY })

    canvas.addEventListener('contextmenu', (event) => event.preventDefault())

    canvas.addEventListener('pointermove', (event) => {
      this.pointer = point(event)
      if (this.cursor.kind === 'surface') {
        this.scheduleRender()
      }
      if (this.interaction) {
        this.continueInteraction()
        return
      }
      this.connection.send({ type: 'pointer', buttons: event.buttons, ...this.target(this.pointer, event.timeStamp) })
    })

    canvas.addEventListener('pointerdown', (event) => {
      canvas.focus()
      canvas.setPointerCapture(event.pointerId)
      this.pointer = point(event)
      if (this.buttons === 0) {
        this.pressPointer = this.pointer
        this.grab = this.pick(this.pointer)
        if (this.grab && !this.grab.window.activated) {
          this.connection.send({ type: 'window.activate', window: this.grab.window.id })
        }
      }
      this.buttons = event.buttons
      this.connection.send({
        type: 'button',
        button: event.button,
        pressed: true,
        buttons: event.buttons,
        ...this.target(this.pointer, event.timeStamp),
      })
      event.preventDefault()
    })

    // The mouse's back/forward buttons (3/4) belong to the remote app, not the browser's history. Browsers navigate on
    // their release, so cancel every event of the press. (They're forwarded with the other buttons above and below.)
    for (const type of ['mousedown', 'mouseup', 'auxclick'] as const) {
      canvas.addEventListener(type, (event) => {
        if (event.button === 3 || event.button === 4) {
          event.preventDefault()
        }
      })
    }

    canvas.addEventListener('pointerup', (event) => {
      if (event.button === 3 || event.button === 4) {
        event.preventDefault()
      }
      this.pointer = point(event)
      if (this.interaction) {
        this.endInteraction()
      }
      this.connection.send({
        type: 'button',
        button: event.button,
        pressed: false,
        buttons: event.buttons,
        ...this.target(this.pointer, event.timeStamp),
      })
      this.buttons = event.buttons
      if (this.buttons === 0) {
        this.grab = undefined
      }
    })

    canvas.addEventListener('pointercancel', () => {
      if (this.interaction) {
        this.endInteraction()
      }
      this.interaction = undefined
      this.grab = undefined
      this.buttons = 0
    })

    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        this.pointer = point(event)
        this.connection.send({
          type: 'axis',
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          ...this.target(this.pointer, event.timeStamp),
        })
      },
      { passive: false },
    )

    const key = (event: KeyboardEvent, pressed: boolean) => {
      // the client repeats keys itself (wl_keyboard.repeat_info)
      if (event.repeat) {
        event.preventDefault()
        return
      }
      event.preventDefault()
      this.connection.send({
        type: 'key',
        code: event.code,
        pressed,
        capsLock: event.getModifierState('CapsLock'),
        numLock: event.getModifierState('NumLock'),
        time: Math.round(event.timeStamp),
      })
    }
    canvas.addEventListener('keydown', (event) => key(event, true))
    canvas.addEventListener('keyup', (event) => key(event, false))
    canvas.addEventListener('focus', () => this.connection.send({ type: 'focus', focused: true }))
    canvas.addEventListener('blur', () => this.connection.send({ type: 'focus', focused: false }))
  }

  private startInteraction(message: Extract<ServerMessage, { type: 'interactive' }>) {
    const window = this.windows.find((w) => w.id === message.window)
    if (window === undefined || this.buttons === 0) {
      return
    }
    // The client asks for the interaction in response to the press, a round trip later. Measure from the press so the
    // window catches up with pointer movement made in the meantime.
    if (message.mode === 'move') {
      this.interaction = {
        mode: 'move',
        window: window.id,
        startPointer: this.pressPointer,
        startPosition: this.windowPosition(window),
        lastSent: 0,
      }
      this.canvas.style.cursor = 'grabbing'
    } else {
      const startRect = this.shownGeometry(window)
      const previous = this.resizeOverrides.get(window.id)
      clearTimeout(previous?.settleTimer)
      this.resizeOverrides.set(window.id, { rect: startRect, edges: message.edges })
      this.interaction = {
        mode: 'resize',
        window: window.id,
        edges: message.edges,
        startPointer: this.pressPointer,
        startRect,
      }
    }
    this.continueInteraction()
  }

  /** The geometry rect a resize interaction shows for the current pointer position. The opposite edges stay put. */
  private resizeRect(interaction: Extract<Interaction, { mode: 'resize' }>): Rect {
    const dx = this.pointer.x - interaction.startPointer.x
    const dy = this.pointer.y - interaction.startPointer.y
    const { edges, startRect } = interaction
    let { x, y, width, height } = startRect
    if (edges & EDGE_RIGHT) {
      width = Math.max(1, Math.round(startRect.width + dx))
    } else if (edges & EDGE_LEFT) {
      width = Math.max(1, Math.round(startRect.width - dx))
      x = startRect.x + startRect.width - width
    }
    if (edges & EDGE_BOTTOM) {
      height = Math.max(1, Math.round(startRect.height + dy))
    } else if (edges & EDGE_TOP) {
      height = Math.max(1, Math.round(startRect.height - dy))
      y = startRect.y + startRect.height - height
    }
    return { x, y, width, height }
  }

  /** Did the client commit content for the size we asked for? */
  private clientCaughtUp(window: SceneWindow, size: Size): boolean {
    const configured = window.configuredSize
    if (configured) {
      return configured.width === size.width && configured.height === size.height
    }
    return window.geometry.width === size.width && window.geometry.height === size.height
  }

  /**
   * The client committed the final size (or took too long): position the window so the edges that didn't move during
   * the drag stay where they were, using the size the client actually chose, and show it unstretched again.
   */
  private settleResize(window: SceneWindow) {
    const override = this.resizeOverrides.get(window.id)
    if (override === undefined) {
      return
    }
    clearTimeout(override.settleTimer)
    this.resizeOverrides.delete(window.id)
    const { rect, edges } = override
    const { geometry } = window
    const x = edges & EDGE_LEFT ? rect.x + rect.width - geometry.width : rect.x
    const y = edges & EDGE_TOP ? rect.y + rect.height - geometry.height : rect.y
    const position = this.keepVisible(window, { x: x - geometry.x, y: y - geometry.y })
    this.localPositions.set(window.id, position)
    this.connection.send({ type: 'window.move', window: window.id, ...position })
    this.scheduleRender()
  }

  private continueInteraction() {
    const interaction = this.interaction!
    const dx = this.pointer.x - interaction.startPointer.x
    const dy = this.pointer.y - interaction.startPointer.y
    if (interaction.mode === 'move') {
      const window = this.windows.find((w) => w.id === interaction.window)
      const wanted = { x: interaction.startPosition.x + dx, y: interaction.startPosition.y + dy }
      const position = window ? this.keepVisible(window, wanted) : wanted
      this.localPositions.set(interaction.window, position)
      const now = performance.now()
      if (now - interaction.lastSent > MOVE_SEND_INTERVAL) {
        interaction.lastSent = now
        this.connection.send({ type: 'window.move', window: interaction.window, ...position })
      }
      this.scheduleRender()
    } else {
      const rect = this.resizeRect(interaction)
      const override = this.resizeOverrides.get(interaction.window)
      if (override) {
        override.rect = rect
      }
      this.scheduleRender()
      const first = this.pendingResize === undefined
      this.pendingResize = {
        window: interaction.window,
        width: rect.width,
        height: rect.height,
        edges: interaction.edges,
      }
      // at most one resize request per frame
      if (first) {
        requestAnimationFrame(() => {
          if (this.pendingResize && this.interaction) {
            this.connection.send({ type: 'window.resize', ...this.pendingResize, done: false })
          }
          this.pendingResize = undefined
        })
      }
    }
  }

  private endInteraction() {
    const interaction = this.interaction!
    this.interaction = undefined
    if (interaction.mode === 'move') {
      const position = this.localPositions.get(interaction.window)
      if (position) {
        this.connection.send({ type: 'window.move', window: interaction.window, ...position })
      }
      this.applyCursor()
    } else {
      const window = this.windows.find((w) => w.id === interaction.window)
      const override = this.resizeOverrides.get(interaction.window)
      const rect = this.resizeRect(interaction)
      this.pendingResize = undefined
      if (window === undefined || override === undefined) {
        this.resizeOverrides.delete(interaction.window)
        return
      }
      override.rect = rect
      override.finalSize = { width: rect.width, height: rect.height }
      this.connection.send({
        type: 'window.resize',
        window: window.id,
        width: rect.width,
        height: rect.height,
        edges: interaction.edges,
        done: true,
      })
      override.settleTimer = setTimeout(() => {
        const current = this.windows.find((w) => w.id === interaction.window)
        if (current) {
          this.settleResize(current)
        }
      }, RESIZE_SETTLE_TIMEOUT)
      if (this.clientCaughtUp(window, override.finalSize)) {
        this.settleResize(window)
      }
      this.scheduleRender()
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // pacing feedback

  private recordDecodeDuration(duration: number) {
    this.decodeDurations.push(duration)
    if (this.decodeDurations.length > 30) {
      this.decodeDurations.shift()
    }
  }

  private measureRefreshRate() {
    const tick = (timestamp: number) => {
      if (this.lastFrameTimestamp) {
        const interval = timestamp - this.lastFrameTimestamp
        // ignore hiccups and throttled background tabs
        if (interval > 4 && interval < 100) {
          this.refreshInterval = this.refreshInterval * 0.9 + interval * 0.1
        }
      }
      this.lastFrameTimestamp = timestamp
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  private sendFeedback() {
    const decodeDuration = this.decodeDurations.length
      ? this.decodeDurations.reduce((a, b) => a + b, 0) / this.decodeDurations.length
      : 0
    const message: ViewerMessage = {
      type: 'feedback',
      refreshInterval: Math.round(this.refreshInterval),
      decodeDuration: Math.round(decodeDuration),
    }
    this.connection.send(message)
  }
}
