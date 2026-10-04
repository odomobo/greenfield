import { Connection } from './connection'
import { KeyFrameNeeded, SurfaceDecoder } from './decoder'
import { Rect, Renderer } from './gl/renderer'
import { Animation, EASE_IN, EASE_OUT, lerpRect } from './animation'
import { parseEncodedFrame, Patch, SceneSurface, SceneWindow, ServerMessage, ViewerMessage } from './protocol'
import { modifiersOf } from './modifiers'
import { ClipboardSync, isPasteChord } from './clipboard'
import { dragHasFiles, dropAllowed, droppedFiles, uploadFiles } from './file-drop'
import { PointerLock } from './pointer-lock'
import { wheelClick } from './wheel'
import { acceptsInput, cursorRect, mapRect, rootWindow, stackChildrenAboveParents } from './windows'
import { WindowSync } from './window-sync'
import { resizedRect } from './resize'
import {
  arrowOf,
  edgesAfterArrow,
  NUDGE_STEP,
  nearestEdges,
  resizeCursor,
} from './window-menu'

type Point = { x: number; y: number }

/** A window change for the server, without its sequence number (added when it's sent). */
type WindowChange = DistributiveOmit<Extract<ViewerMessage, { seq: number }>, 'seq'>
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

type Pick = { window: SceneWindow; surface: string; sx: number; sy: number }

type Size = { width: number; height: number }

/**
 * A Move or Size from the window menu (not asked for by the app): it follows the pointer without a button held, keys
 * nudge it, a click finishes it, Escape cancels it.
 */
type MenuInteraction = {
  /** what the arrow keys added to the pointer's distance from startPointer */
  nudge: Point
  /** Size: the edges were picked by an arrow key, not by the pointer's position */
  keyChosen: boolean
  /** Size: the rect the window had (what a cancel goes back to) */
  original?: Rect
  cancelled: boolean
  /** removes the document listeners of the interaction */
  stop: () => void
}

type Interaction =
  | { mode: 'move'; window: string; startPointer: Point; startPosition: Point; menu?: MenuInteraction }
  /** startRect: the window geometry rect (output coordinates) when the resize started */
  | { mode: 'resize'; window: string; edges: number; startPointer: Point; startRect: Rect; menu?: MenuInteraction }

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
  | { kind: 'surface'; surface: string; hotspot: Point; size?: { width: number; height: number } }

// xdg_toplevel resize edges
const EDGE_TOP = 1
const EDGE_BOTTOM = 2
const EDGE_LEFT = 4
const EDGE_RIGHT = 8

/** How much of a window (geometry) must stay inside the output, so it can always be grabbed and moved back. */
const MIN_VISIBLE = 80
/** Give up waiting for a client to commit the final size of a resize after this long. */
const RESIZE_SETTLE_TIMEOUT = 2000
/** Durations of the window state animations, ms. Subtle and short. */
const STATE_ANIMATION_MS = 150

/** icon: the app's own icon (PNG data URL), for windows whose app has no desktop entry icon */
export type ShellWindow = SceneWindow & { shownMinimized: boolean; icon?: string }

/**
 * The viewer side of a session: shows the server's window scene and acts as its window manager. Everything that
 * doesn't need session state happens here (rendering, hit testing, implicit grabs, interactive move/resize, placement);
 * decisions are reported to the server, which stores them.
 */
export class Desktop {
  private windows: SceneWindow[] = []
  /**
   * The viewer's own window positions (during a move, until the server applied it) and minimized states, reconciled
   * with the server's by sequence numbers.
   */
  private readonly sync = new WindowSync()
  private readonly resizeOverrides = new Map<string, ResizeOverride>()
  /** the windows' own icons (window.icon) by window id */
  private readonly windowIcons = new Map<string, string>()
  /** touch points (pointer ids) that went down on a surface, with it: they stay on it until they end */
  private readonly touches = new Map<number, Pick>()
  private readonly pointerLock: PointerLock
  private output: Size = { width: 0, height: 0 }
  private readonly placementSent = new Set<string>()
  private readonly decoders = new Map<string, SurfaceDecoder>()
  private readonly keyFrameRequested = new Set<string>()
  private cursor: Cursor = { kind: 'default' }
  /** a drag and drop between remote apps is going on (the server says so), with its icon surface */
  private drag?: { icon?: { surface: string; x: number; y: number } }
  private readonly animations = new Map<string, WindowAnimation>()
  /** geometry of windows before they were maximized, to animate back to */
  private readonly restoreRects = new Map<string, Rect>()

  /** Called whenever the window list or a window's state changes. */
  onWindowsChanged: (windows: ShellWindow[]) => void = () => {
    /* noop */
  }
  /** Where a window goes when minimized (its taskbar button), in page coordinates. */
  minimizeTarget: (window: string) => DOMRect | undefined = () => undefined

  /** the clipboard text shared with the session's apps */
  private readonly clipboard = new ClipboardSync(globalThis.navigator?.clipboard, (text) =>
    this.connection.send({ type: 'clipboard', text }),
  )
  /** while a paste waits for the browser's clipboard: the key events that follow it wait too, to keep their order */
  private keyChain?: Promise<void>
  /** where files being dragged over the desktop were last reported, and the next id of an uploaded file */
  private fileDragAt?: Point
  private nextFileId = 1

  private pointer: Point = { x: 0, y: 0 }
  /** where the current button press started; interactions the client starts on a press are measured from here */
  private pressPointer: Point = { x: 0, y: 0 }
  private buttons = 0
  /** implicit grab: while a button is held, pointer events go to the surface the press started on */
  private grab?: Pick
  private interaction?: Interaction
  /** the pointer in page coordinates, wherever it is (a menu's Move and Size start from it) */
  private clientPointer: Point = { x: 0, y: 0 }
  /** the click that finished a menu interaction: its release isn't the app's */
  private swallowRelease = false

  private renderScheduled = false
  private lastFrameTimestamp = 0
  private refreshInterval = 16

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: Renderer,
    private readonly connection: Connection,
  ) {
    this.pointerLock = new PointerLock(
      {
        request: () => canvas.requestPointerLock() as Promise<void> | void,
        exit: () => document.exitPointerLock(),
        locked: () => document.pointerLockElement === canvas,
      },
      (message) => connection.send(message),
    )
    document.addEventListener('pointerlockchange', () => this.pointerLock.changed())
    document.addEventListener('pointerlockerror', () => this.pointerLock.failed())
    this.installInputHandlers()
    // Observing the size in device pixels also catches pixel ratio changes (zoom, another monitor) where supported.
    const resizeObserver = new ResizeObserver(() => this.outputChanged())
    try {
      resizeObserver.observe(canvas, { box: 'device-pixel-content-box' })
    } catch {
      resizeObserver.observe(canvas)
    }
    this.watchPixelRatio()
    // zooming and moving between monitors also fire resize (the media query alone isn't reliable everywhere)
    window.addEventListener('resize', () => {
      if (window.devicePixelRatio !== this.reportedScale) {
        this.outputChanged()
      }
    })
    setInterval(() => this.sendFeedback(), 500)
    this.measureRefreshRate()
  }

  /** The scale last sent to the server. */
  private reportedScale = 1

  /** The canvas was resized or the device pixel ratio changed (browser zoom, another monitor). */
  private outputChanged() {
    const { width, height, scale } = this.renderer.resize()
    this.output = { width, height }
    this.reportedScale = scale
    this.connection.send({ type: 'output', width, height, scale })
    this.keepWindowsVisible()
    this.scheduleRender()
  }

  /** A pixel ratio change doesn't always resize the canvas (e.g. moving the browser to another monitor). */
  private watchPixelRatio() {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      'change',
      () => {
        this.outputChanged()
        this.watchPixelRatio()
      },
      { once: true },
    )
  }

  /**
   * A new connection: everything we had is stale, the server sends a full snapshot and key frames.
   */
  reset(): void {
    this.clear()
    const { width, height, scale } = this.renderer.resize()
    this.output = { width, height }
    this.reportedScale = scale
    this.connection.send({ type: 'hello', output: { width, height, scale } })
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
    this.sync.clear()
    for (const override of this.resizeOverrides.values()) {
      clearTimeout(override.settleTimer)
    }
    this.resizeOverrides.clear()
    this.placementSent.clear()
    this.animations.clear()
    this.restoreRects.clear()
    this.windowIcons.clear()
    this.touches.clear()
    this.grab = undefined
    this.interaction?.menu?.stop()
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

  /** The drag and drop going on between remote apps (and whether its icon has content). For tests. */
  debugDrag(): { icon?: { surface: string; x: number; y: number; width: number; height: number } } | null {
    const icon = this.drag?.icon
    const size = icon && this.frameSizes.get(icon.surface)
    return this.drag ? { icon: icon && size && { ...icon, ...size } } : null
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

  /** How many window.resize messages were sent. For tests. */
  debugResizesSent(): number {
    return this.resizesSent
  }

  private resizesSent = 0

  /** How many window.move messages were sent. For tests. */
  debugMovesSent(): number {
    return this.movesSent
  }

  private movesSent = 0

  /** For tests: hold every scene back this long (ms), in order, as if the server were slow. */
  debugSceneDelay = 0

  private videoFramesDecoded = 0
  private videoFramesFailed = 0
  private patchesApplied = 0

  /** How many lossless patches were drawn, in all. For tests. */
  debugPatches(): number {
    return this.patchesApplied
  }

  /** How many video frames decoded and how many failed to, in all. For tests. */
  debugVideoFrames(): { decoded: number; failed: number } {
    return { decoded: this.videoFramesDecoded, failed: this.videoFramesFailed }
  }

  /** Running state animations by window. For tests. */
  debugAnimations(): Record<string, string> {
    return Object.fromEntries([...this.animations].map(([id, { kind }]) => [id, kind]))
  }

  // -------------------------------------------------------------------------------------------------------------------
  // window management for the shell (taskbar)

  /** The top level window a (child) window belongs to. */
  private rootOf(window: SceneWindow): SceneWindow {
    return rootWindow(this.windows, window)
  }

  private parentOf(window: SceneWindow): SceneWindow | undefined {
    return window.parent === undefined ? undefined : this.windows.find((w) => w.id === window.parent)
  }

  /** Child windows are minimized and restored with their top level window. */
  private isMinimized(window: SceneWindow): boolean {
    const root = this.rootOf(window)
    return this.sync.minimized(root.id) ?? root.minimized
  }

  /** Minimized and not animating anymore: not shown, not pickable. */
  private isHidden(window: SceneWindow): boolean {
    const animation = this.animations.get(this.rootOf(window).id)
    return this.isMinimized(window) && animation?.kind !== 'minimize'
  }

  /** Give the keyboard to the session. */
  focus(): void {
    this.canvas.focus()
  }

  /**
   * Top level windows; child windows (dialogs) are reached through their parent, which counts as active while one of
   * its children is.
   */
  shellWindows(): ShellWindow[] {
    return this.windows
      .filter((window) => this.rootOf(window) === window)
      .map((window) => ({
        ...window,
        activated: this.windows.some((w) => w.activated && this.rootOf(w) === window),
        shownMinimized: this.isMinimized(window),
        icon: this.windowIcons.get(window.id),
      }))
  }

  private notifyWindowsChanged() {
    this.onWindowsChanged(this.shellWindows())
  }

  /** Whether the window can be moved and sized by the user (not minimized, maximized or fullscreen). */
  canMoveOrSize(id: string): boolean {
    const window = this.windows.find((w) => w.id === id)
    return window !== undefined && !window.maximized && !window.fullscreen && !this.isMinimized(window)
  }

  /** The window menu's Move: the window follows the pointer, a click drops it, Escape puts it back. */
  startMenuMove(id: string): void {
    const window = this.windows.find((w) => w.id === id)
    if (window === undefined || !this.canMoveOrSize(id)) {
      return
    }
    this.finishMenuInteraction(false)
    this.activateWindow(id)
    this.pointer = this.canvasPoint(this.clientPointer)
    this.interaction = {
      mode: 'move',
      window: id,
      startPointer: this.pointer,
      startPosition: this.windowPosition(window),
      menu: this.menuInteraction(),
    }
    this.canvas.style.cursor = 'move'
  }

  /** The window menu's Size: the edge or corner nearest the pointer (or the first arrow key's) follows it. */
  startMenuSize(id: string): void {
    const window = this.windows.find((w) => w.id === id)
    if (window === undefined || !this.canMoveOrSize(id)) {
      return
    }
    this.finishMenuInteraction(false)
    this.activateWindow(id)
    this.pointer = this.canvasPoint(this.clientPointer)
    const startRect = this.shownGeometry(window)
    const edges = nearestEdges(startRect, this.pointer)
    const previous = this.resizeOverrides.get(window.id)
    clearTimeout(previous?.settleTimer)
    this.resizeOverrides.set(window.id, { rect: startRect, edges })
    this.interaction = {
      mode: 'resize',
      window: id,
      edges,
      startPointer: this.pointer,
      startRect,
      menu: { ...this.menuInteraction(), original: startRect },
    }
    this.canvas.style.cursor = resizeCursor(edges)
  }

  private canvasPoint(client: Point): Point {
    const rect = this.canvas.getBoundingClientRect()
    return { x: client.x - rect.left, y: client.y - rect.top }
  }

  /** The state of a new menu interaction, with its document listeners: the pointer anywhere, a click anywhere. */
  private menuInteraction(): MenuInteraction {
    const move = (event: PointerEvent) => {
      this.clientPointer = { x: event.clientX, y: event.clientY }
      this.pointer = this.canvasPoint(this.clientPointer)
      if (this.interaction?.menu) {
        this.continueInteraction()
      }
    }
    const down = (event: PointerEvent) => {
      // the click that drops the window isn't the app's, nor the shell's
      event.stopPropagation()
      event.preventDefault()
      this.swallowRelease = true
      this.finishMenuInteraction(false)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerdown', down, { capture: true })
    return {
      nudge: { x: 0, y: 0 },
      keyChosen: false,
      cancelled: false,
      stop: () => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerdown', down, { capture: true })
      },
    }
  }

  /** Ends the running menu interaction, if any: keeps where the window is, or (cancel) puts it back. */
  private finishMenuInteraction(cancel: boolean) {
    const interaction = this.interaction
    if (interaction?.menu === undefined) {
      return
    }
    interaction.menu.stop()
    interaction.menu.cancelled = cancel
    if (cancel && interaction.mode === 'move') {
      this.sync.setPosition(interaction.window, interaction.startPosition)
    }
    this.endInteraction()
  }

  /** A key while a menu interaction runs: arrows nudge, Enter finishes, Escape cancels. */
  private menuKey(event: KeyboardEvent, interaction: Interaction & { menu: MenuInteraction }) {
    event.preventDefault()
    if (event.type !== 'keydown') {
      return
    }
    if (event.key === 'Escape') {
      this.finishMenuInteraction(true)
    } else if (event.key === 'Enter' || event.key === ' ') {
      this.finishMenuInteraction(false)
    } else {
      const arrow = arrowOf(event.key)
      if (arrow === undefined) {
        return
      }
      const step = event.shiftKey ? 1 : NUDGE_STEP
      if (interaction.mode === 'resize') {
        const edges = edgesAfterArrow(interaction.edges, interaction.menu.keyChosen, arrow)
        if (edges !== interaction.edges || !interaction.menu.keyChosen) {
          // continue from the rect shown now, with the new edges
          const override = this.resizeOverrides.get(interaction.window)
          if (override) {
            interaction.startRect = override.rect
            override.edges = edges
          }
          interaction.startPointer = this.pointer
          interaction.menu.nudge = { x: 0, y: 0 }
          interaction.edges = edges
          interaction.menu.keyChosen = true
          this.canvas.style.cursor = resizeCursor(edges)
        }
      }
      interaction.menu.nudge = {
        x: interaction.menu.nudge.x + arrow.x * step,
        y: interaction.menu.nudge.y + arrow.y * step,
      }
      this.continueInteraction()
      // continue sizing from the rect shown now: presses past a minimum or maximum size are dropped, so the opposite
      // arrow takes effect right away
      const override = this.resizeOverrides.get(interaction.window)
      if (interaction.mode === 'resize' && override) {
        interaction.startRect = override.rect
        interaction.startPointer = this.pointer
        interaction.menu.nudge = { x: 0, y: 0 }
      }
    }
  }

  /** Bring a window to the front and give it the keyboard, restoring it if it's minimized. */
  activateWindow(id: string): void {
    const window = this.windows.find((w) => w.id === id)
    if (window === undefined) {
      return
    }
    if (this.isMinimized(window)) {
      const root = this.rootOf(window)
      this.startRestoreAnimation(root)
      this.sync.setMinimized(root.id, false)
    }
    this.sendWindowChange({ type: 'window.activate', window: id })
    this.canvas.focus()
    this.notifyWindowsChanged()
    this.scheduleRender()
  }

  minimizeWindow(id: string): void {
    const found = this.windows.find((w) => w.id === id)
    if (found === undefined || this.isMinimized(found)) {
      return
    }
    const window = this.rootOf(found)
    this.startMinimizeAnimation(window)
    this.sync.setMinimized(window.id, true)
    // the server moves the keyboard focus to the next window
    this.sendWindowChange({ type: 'window.minimize', window: window.id, minimized: true })
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
    this.sendWindowChange({ type: 'window.maximize', window: id, maximized })
    this.startMaximizeAnimation(window, maximized)
  }

  /** Send a window change, numbered so its echo in the scene can be told apart from older state (see WindowSync). */
  private sendWindowChange(change: WindowChange) {
    if (change.type === 'window.resize') {
      this.resizesSent++
    } else if (change.type === 'window.move') {
      this.movesSent++
    }
    this.connection.send({ ...change, seq: this.sync.nextSeq(change.window) } as ViewerMessage)
  }

  /** Show a window at a position of the viewer's choosing, and tell the server. */
  private moveWindow(id: string, position: Point) {
    this.sync.setPosition(id, position)
    this.sendWindowChange({ type: 'window.move', window: id, ...position })
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
    // with its child windows (dialogs), cropped to the window
    const draws = this.windows
      .filter((w) => this.rootOf(w) === window)
      .flatMap((w) =>
        w.surfaces.map((surface) => ({
          surface: surface.id,
          rect: {
            x: (w.x - window.x + surface.x - geometry.x) * scale,
            y: (w.y - window.y + surface.y - geometry.y) * scale,
            width: surface.width * scale,
            height: surface.height * scale,
          },
        })),
      )
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
      this.interaction.menu?.stop()
      this.interaction = undefined
      this.applyCursor()
    }
    const override = this.resizeOverrides.get(id)
    if (override) {
      clearTimeout(override.settleTimer)
      this.resizeOverrides.delete(id)
    }
  }

  /**
   * The animated rect and opacity of a window right now, if it's animating. Child windows follow their top level
   * window's animation.
   */
  private animatedState(window: SceneWindow): { rect: Rect; opacity: number } | undefined {
    const state = this.animations.get(window.id)
    if (state === undefined) {
      const root = this.rootOf(window)
      const rootState = root !== window ? this.animatedState(root) : undefined
      if (rootState === undefined) {
        return undefined
      }
      return {
        rect: mapRect(this.restingRect(window), this.restingRect(root), rootState.rect),
        opacity: rootState.opacity,
      }
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
        if (this.debugSceneDelay > 0) {
          setTimeout(() => this.updateScene(message.windows), this.debugSceneDelay)
        } else {
          this.updateScene(message.windows)
        }
        break
      case 'clipboard':
        this.clipboard.remoteText(message.text)
        break
      case 'drag':
        this.drag = message.active ? { icon: message.icon } : undefined
        this.scheduleRender()
        break
      case 'cursor':
        this.cursor = message
        this.applyCursor()
        break
      case 'interactive':
        this.startInteraction(message)
        break
      case 'pointer.lock':
        this.pointerLock.serverLock(message.locked, message.confined)
        break
      case 'window.icon':
        if (message.icon) {
          this.windowIcons.set(message.window, message.icon)
        } else {
          this.windowIcons.delete(message.window)
        }
        this.notifyWindowsChanged()
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

  /**
   * A whole-surface video frame. `applied` is called once it's decoded and uploaded, or failed (see the
   * connection's acks).
   */
  handleFrame(surface: string, data: Uint8Array, applied: () => void = noop): void {
    let frame: ReturnType<typeof parseEncodedFrame>
    try {
      frame = parseEncodedFrame(data)
    } catch (e) {
      applied()
      throw e
    }
    this.frameSizes.set(surface, frame.size)
    this.decoderFor(surface)
      .decode(frame)
      .then(
        (decoded) => {
          this.videoFramesDecoded++
          this.keyFrameRequested.delete(surface)
          this.renderer.upload(surface, decoded)
          this.scheduleRender()
        },
        (error) => {
          this.videoFramesFailed++
          this.decodeFailed(surface, error)
        },
      )
      .finally(applied)
  }

  /**
   * A lossless update of part of a surface, drawn over what it shows now (applied right away, in order). `applied` is
   * called once it's drawn, or failed (see the connection's acks).
   */
  handlePatch(surface: string, patch: Patch, applied: () => void = noop): void {
    this.frameSizes.set(surface, patch.surfaceSize)
    this.decoderFor(surface)
      .decodePatch(patch)
      .then(
        (decoded) => {
          this.keyFrameRequested.delete(surface)
          this.patchesApplied++
          this.renderer.patch(surface, decoded)
          this.scheduleRender()
        },
        (error) => this.decodeFailed(surface, error),
      )
      .finally(applied)
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

  private updateScene(sceneWindows: SceneWindow[]) {
    const previous = new Map(this.windows.map((window) => [window.id, window]))
    const previousRects = new Map(this.windows.map((window) => [window.id, this.shownGeometry(window)]))
    const windows = stackChildrenAboveParents(sceneWindows)
    this.windows = windows
    // until the server applied the viewer's changes to a window, the viewer's state of it is shown, not the scene's
    const shownMinimized = (window: SceneWindow) => this.sync.minimized(window.id) ?? previous.get(window.id)?.minimized
    const minimizedBefore = new Map(windows.map((window) => [window.id, shownMinimized(window)]))
    this.sync.sceneReceived(sceneWindows, (id) => this.interaction?.window === id)
    for (const window of windows) {
      if (this.sync.minimized(window.id) !== undefined) {
        continue
      }
      // minimized or restored by the client or another viewer, or the server corrected what the viewer showed
      const before = minimizedBefore.get(window.id)
      if (before !== undefined && before !== window.minimized && !this.animations.has(window.id)) {
        if (window.minimized) {
          this.startMinimizeAnimation(window, previousRects.get(window.id))
        } else {
          this.startRestoreAnimation(window)
        }
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
      if (window.placed) {
        placedCount++
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
    // the viewer decides where new windows go; the server centers child windows on their parent
    for (const window of windows) {
      if (
        window.placed ||
        window.parent !== undefined ||
        window.maximized ||
        window.fullscreen ||
        this.placementSent.has(window.id)
      ) {
        continue
      }
      this.placementSent.add(window.id)
      const cascade = 40 + (placedCount++ % 10) * 32
      this.moveWindow(
        window.id,
        this.keepVisible(window, { x: cascade - window.geometry.x, y: cascade - window.geometry.y }),
      )
    }
    // also covers positions chosen by the server or client (e.g. dialogs) and windows coming back after a reattach
    this.keepWindowsVisible()
    // Content of surfaces that are gone. The cursor surface isn't part of any window.
    const cursorSurface = this.cursor.kind === 'surface' ? this.cursor.surface : this.drag?.icon?.surface
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

  /**
   * Where a window's main surface origin is shown. A child window moves with its parent: while the parent is shown
   * somewhere the server doesn't know about yet (a move in progress), the child is shown moved by as much.
   */
  private windowPosition(window: SceneWindow, seen = new Set<string>()): Point {
    const local = this.sync.position(window.id)
    if (local) {
      return local
    }
    const parent = this.parentOf(window)
    seen.add(window.id)
    if (parent && !seen.has(parent.id)) {
      const shownParent = this.windowPosition(parent, seen)
      return { x: window.x + shownParent.x - parent.x, y: window.y + shownParent.y - parent.y }
    }
    return { x: window.x, y: window.y }
  }

  /** Whether a window's parent (or theirs) is being moved, resized or animated, or waits for the server to agree. */
  private ancestorBusy(window: SceneWindow): boolean {
    const seen = new Set<string>([window.id])
    for (let current = this.parentOf(window); current && !seen.has(current.id); current = this.parentOf(current)) {
      seen.add(current.id)
      if (
        this.interaction?.window === current.id ||
        this.sync.position(current.id) !== undefined ||
        this.resizeOverrides.has(current.id) ||
        this.animations.has(current.id)
      ) {
        return true
      }
    }
    return false
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
        (!window.placed && window.parent === undefined) ||
        this.resizeOverrides.has(window.id) ||
        this.animations.has(window.id) ||
        this.interaction?.window === window.id ||
        this.ancestorBusy(window)
      ) {
        continue
      }
      const position = this.windowPosition(window)
      const visible = this.keepVisible(window, position)
      if (visible.x !== position.x || visible.y !== position.y) {
        this.moveWindow(window.id, visible)
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
      const rect = cursorRect(this.pointer, hotspot, this.cursor.size, this.cursorSize(surface))
      if (rect) {
        this.renderer.drawSurface(surface, rect)
      }
    }
    const icon = this.drag?.icon
    const iconSize = icon && this.cursorSize(icon.surface)
    if (icon && iconSize) {
      this.renderer.drawSurface(icon.surface, {
        x: this.pointer.x + icon.x,
        y: this.pointer.y + icon.y,
        width: iconSize.width,
        height: iconSize.height,
      })
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
      const kind = this.animations.get(this.rootOf(window).id)?.kind
      if (this.isHidden(window) || kind === 'minimize' || kind === 'restore') {
        continue
      }
      const rects = this.surfaceRects(window)
      for (let s = rects.length - 1; s >= 0; s--) {
        const { surface, rect, scaleX, scaleY } = rects[s]
        const sx = (point.x - rect.x) / scaleX
        const sy = (point.y - rect.y) / scaleY
        // outside the input region (e.g. a client side shadow) input goes to whatever is underneath
        if (acceptsInput(surface, sx, sy)) {
          return { window, surface: surface.id, sx, sy }
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
    // (a drag and drop goes to whatever is under the pointer, not to the surface the press started on)
    const pick = this.grab && !this.drag ? this.grabTarget(point) : this.pick(point)
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
    // (the release of a click that dropped a window may come outside the canvas)
    document.addEventListener('pointerup', () => {
      this.swallowRelease = false
    })
    document.addEventListener(
      'pointermove',
      (event) => {
        this.clientPointer = { x: event.clientX, y: event.clientY }
      },
      { capture: true },
    )

    canvas.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'touch') {
        this.touchEvent(event, 'move')
        return
      }
      // the pointer is locked: relative motion only
      if (this.pointerLock.movement(event.movementX, event.movementY, event.timeStamp)) {
        return
      }
      this.pointer = point(event)
      if (this.cursor.kind === 'surface' || this.drag?.icon) {
        this.scheduleRender()
      }
      if (this.interaction) {
        this.continueInteraction()
        return
      }
      this.connection.send({
        type: 'pointer',
        buttons: event.buttons,
        modifiers: modifiersOf(event),
        ...this.target(this.pointer, event.timeStamp),
      })
    })

    canvas.addEventListener('pointerdown', (event) => {
      void this.clipboard.retryPending()
      canvas.focus()
      canvas.setPointerCapture(event.pointerId)
      this.pointerLock.gesture()
      if (event.pointerType === 'touch') {
        this.touchEvent(event, 'down')
        return
      }
      this.pointer = point(event)
      if (this.buttons === 0) {
        this.pressPointer = this.pointer
        this.grab = this.pick(this.pointer)
        if (this.grab && !this.grab.window.activated) {
          this.sendWindowChange({ type: 'window.activate', window: this.grab.window.id })
        }
      }
      this.buttons = event.buttons
      this.connection.send({
        type: 'button',
        button: event.button,
        pressed: true,
        buttons: event.buttons,
        modifiers: modifiersOf(event),
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
      if (event.pointerType === 'touch') {
        this.touchEvent(event, 'up')
        return
      }
      if (event.button === 3 || event.button === 4) {
        event.preventDefault()
      }
      this.pointer = point(event)
      if (this.swallowRelease) {
        this.swallowRelease = false
        return
      }
      if (this.interaction) {
        this.endInteraction()
      }
      this.connection.send({
        type: 'button',
        button: event.button,
        pressed: false,
        buttons: event.buttons,
        modifiers: modifiersOf(event),
        ...this.target(this.pointer, event.timeStamp),
      })
      this.buttons = event.buttons
      if (this.buttons === 0) {
        this.grab = undefined
      }
    })

    canvas.addEventListener('pointercancel', (event) => {
      if (event.pointerType === 'touch') {
        this.touchEvent(event, 'cancel')
        return
      }
      this.interaction?.menu?.stop()
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
          wheelX: wheelClick(event.deltaMode, event.deltaX) || undefined,
          wheelY: wheelClick(event.deltaMode, event.deltaY) || undefined,
          modifiers: modifiersOf(event),
          ...this.target(this.pointer, event.timeStamp),
        })
      },
      { passive: false },
    )

    // Files dragged in from the user's computer: the browser sends drag events, not pointer events, until the drop.
    // The server runs a drag of its own meanwhile, so apps under the pointer show their drop targets.
    const fileDragOver = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) {
        return
      }
      event.preventDefault()
      event.dataTransfer!.dropEffect = 'copy'
      const at = point(event)
      if (this.fileDragAt?.x !== at.x || this.fileDragAt?.y !== at.y) {
        this.fileDragAt = at
        this.connection.send({
          type: 'file-drag',
          over: true,
          ...this.target(at, event.timeStamp),
        })
      }
    }
    canvas.addEventListener('dragenter', fileDragOver)
    canvas.addEventListener('dragover', fileDragOver)
    canvas.addEventListener('dragleave', (event) => {
      if (this.fileDragAt && dragHasFiles(event.dataTransfer)) {
        this.fileDragAt = undefined
        this.connection.send({ type: 'file-drag', over: false, ...this.target(point(event), event.timeStamp) })
      }
    })
    canvas.addEventListener('drop', (event) => {
      if (!dragHasFiles(event.dataTransfer)) {
        return
      }
      event.preventDefault()
      this.fileDragAt = undefined
      const files = droppedFiles(event.dataTransfer!)
      const target = this.target(point(event), event.timeStamp)
      if (!dropAllowed(files)) {
        console.warn('These files are too many or too big to upload to the session.')
        this.connection.send({ type: 'file-drag', over: false, ...target })
        return
      }
      const uploads = files.map((file) => ({ id: this.nextFileId++, file }))
      this.connection.send({
        type: 'file-drop',
        files: uploads.map(({ id, file }) => ({ id, name: file.name, size: file.size })),
        ...target,
      })
      void uploadFiles(uploads, {
        chunk: (id, bytes) => this.connection.sendFileChunk(id, bytes),
        buffered: () => this.connection.buffered,
      })
    })

    const key = (event: KeyboardEvent, pressed: boolean) => {
      if (this.interaction?.menu) {
        this.menuKey(event, this.interaction as Interaction & { menu: MenuInteraction })
        return
      }
      // the client repeats keys itself (wl_keyboard.repeat_info)
      if (event.repeat) {
        event.preventDefault()
        return
      }
      const message: ViewerMessage = {
        type: 'key',
        code: event.code,
        pressed,
        modifiers: modifiersOf(event),
        time: Math.round(event.timeStamp),
      }
      if (pressed && isPasteChord(event)) {
        // the browser's clipboard goes to the session before the key: the app handles the paste against the new
        // selection. (Without readText the key's default action, a paste event, brings the text instead.)
        if (this.clipboard.canRead) {
          event.preventDefault()
        }
        this.afterPaste(this.clipboard.beforePaste(), () => this.connection.send(message))
        return
      }
      event.preventDefault()
      if (pressed) {
        void this.clipboard.retryPending()
      }
      this.afterPaste(undefined, () => this.connection.send(message))
    }
    document.addEventListener('paste', (event) => {
      this.clipboard.onPasteEvent(event.clipboardData?.getData('text/plain'))
    })
    window.addEventListener('focus', () => void this.clipboard.retryPending())
    canvas.addEventListener('keydown', (event) => key(event, true))
    canvas.addEventListener('keyup', (event) => key(event, false))
    canvas.addEventListener('focus', () => this.connection.send({ type: 'focus', focused: true }))
    canvas.addEventListener('blur', () => this.connection.send({ type: 'focus', focused: false }))
    // A hidden page (another tab, a minimized browser) gets no key events either, even if the canvas keeps focus: the
    // server releases the held keys when told the focus is gone.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.connection.send({ type: 'focus', focused: false })
      } else if (document.activeElement === canvas) {
        this.connection.send({ type: 'focus', focused: true })
      }
    })
  }

  /** Sends in order: after a paste's clipboard transfer, and after the key events queued behind it. */
  private afterPaste(wait: Promise<void> | undefined, send: () => void) {
    if (wait === undefined && this.keyChain === undefined) {
      send()
      return
    }
    const next = (wait ? (this.keyChain ?? Promise.resolve()).then(() => wait) : this.keyChain!).then(send)
    this.keyChain = next
    void next.then(() => {
      if (this.keyChain === next) {
        this.keyChain = undefined
      }
    })
  }

  /**
   * A finger (pointerType 'touch') is a wl_touch point, not a mouse: it goes down on the surface under it and stays
   * on that surface until it lifts. A window drag the app starts with it (a client-side title bar) works like the
   * mouse's: the finger counts as a pressed button for it.
   */
  private touchEvent(event: PointerEvent, phase: 'down' | 'move' | 'up' | 'cancel') {
    const point = { x: event.offsetX, y: event.offsetY }
    this.pointer = point
    if (phase === 'down') {
      const pick = this.pick(point)
      if (pick === undefined) {
        return
      }
      this.touches.set(event.pointerId, pick)
      if (this.buttons === 0) {
        this.pressPointer = point
        this.buttons = 1
      }
      if (!pick.window.activated) {
        this.sendWindowChange({ type: 'window.activate', window: pick.window.id })
      }
      event.preventDefault()
    }
    if (phase === 'move' && this.interaction) {
      this.continueInteraction()
      return
    }
    const grab = this.touches.get(event.pointerId)
    if (grab === undefined) {
      return
    }
    if ((phase === 'up' || phase === 'cancel') && this.interaction) {
      this.endInteraction()
    }
    const placed = this.windows.find((w) => w.id === grab.window.id) &&
      this.surfaceRects(this.windows.find((w) => w.id === grab.window.id)!).find(({ surface }) => surface.id === grab.surface)
    const rect = placed?.rect
    const sx = rect ? (point.x - rect.x) / placed.scaleX : grab.sx
    const sy = rect ? (point.y - rect.y) / placed.scaleY : grab.sy
    this.connection.send({
      type: 'touch',
      phase,
      id: event.pointerId,
      surface: grab.surface,
      sx,
      sy,
      x: point.x,
      y: point.y,
      time: Math.round(event.timeStamp),
      modifiers: modifiersOf(event),
    })
    if (phase === 'up' || phase === 'cancel') {
      this.touches.delete(event.pointerId)
      if (this.touches.size === 0) {
        this.buttons = 0
      }
    }
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
    if (interaction.menu?.cancelled) {
      return interaction.menu.original ?? interaction.startRect
    }
    const dx = this.pointer.x - interaction.startPointer.x + (interaction.menu?.nudge.x ?? 0)
    const dy = this.pointer.y - interaction.startPointer.y + (interaction.menu?.nudge.y ?? 0)
    const window = this.windows.find((w) => w.id === interaction.window)
    return resizedRect(interaction.startRect, interaction.edges, dx, dy, window)
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
    this.moveWindow(window.id, this.keepVisible(window, { x: x - geometry.x, y: y - geometry.y }))
    this.scheduleRender()
  }

  private continueInteraction() {
    const interaction = this.interaction!
    const dx = this.pointer.x - interaction.startPointer.x + (interaction.menu?.nudge.x ?? 0)
    const dy = this.pointer.y - interaction.startPointer.y + (interaction.menu?.nudge.y ?? 0)
    if (interaction.mode === 'move') {
      const window = this.windows.find((w) => w.id === interaction.window)
      const wanted = { x: interaction.startPosition.x + dx, y: interaction.startPosition.y + dy }
      const position = window ? this.keepVisible(window, wanted) : wanted
      // shown where the pointer is right away (held against scenes while dragging); the server is told the final
      // position when the drag ends
      this.sync.setPosition(interaction.window, position)
      this.scheduleRender()
    } else {
      const rect = this.resizeRect(interaction)
      const override = this.resizeOverrides.get(interaction.window)
      if (override) {
        override.rect = rect
      }
      this.scheduleRender()
      // nothing is sent while dragging: the app is told the final size when the drag ends
    }
  }

  private endInteraction() {
    const interaction = this.interaction!
    this.interaction = undefined
    if (interaction.mode === 'move') {
      const position = this.sync.position(interaction.window)
      if (position && !interaction.menu?.cancelled) {
        // the final position (Escape in Move: nothing is sent, the window never left where the server has it); the viewer shows it until the server's scene says it applied it
        this.moveWindow(interaction.window, position)
      }
      this.applyCursor()
    } else {
      const window = this.windows.find((w) => w.id === interaction.window)
      const override = this.resizeOverrides.get(interaction.window)
      const rect = this.resizeRect(interaction)
      if (window === undefined || override === undefined) {
        this.resizeOverrides.delete(interaction.window)
        return
      }
      if (interaction.menu?.cancelled) {
        // Escape in Size: the window was never resized, nothing was sent
        clearTimeout(override.settleTimer)
        this.resizeOverrides.delete(interaction.window)
        this.scheduleRender()
        return
      }
      override.rect = rect
      override.finalSize = { width: rect.width, height: rect.height }
      this.sendWindowChange({
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
    const message: ViewerMessage = { type: 'feedback', refreshInterval: Math.round(this.refreshInterval) }
    this.connection.send(message)
  }
}

function noop() {
  /* nothing to report */
}
