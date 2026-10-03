import { Connection } from './connection'
import { KeyFrameNeeded, SurfaceDecoder } from './decoder'
import { Rect, Renderer } from './gl/renderer'
import { parseEncodedFrame, SceneWindow, ServerMessage, ViewerMessage } from './protocol'

type Point = { x: number; y: number }

type Pick = { window: SceneWindow; surface: string; sx: number; sy: number }

type Interaction =
  | { mode: 'move'; window: string; startPointer: Point; startPosition: Point; lastSent: number }
  | { mode: 'resize'; window: string; edges: number; startPointer: Point; startSize: { width: number; height: number } }

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

/**
 * The viewer side of a session: shows the server's window scene and acts as its window manager. Everything that
 * doesn't need session state happens here (rendering, hit testing, implicit grabs, interactive move/resize, placement);
 * decisions are reported to the server, which stores them.
 */
export class Desktop {
  private windows: SceneWindow[] = []
  /** window positions overridden locally during an interactive move, until the server confirms them */
  private readonly localPositions = new Map<string, Point>()
  private readonly placementSent = new Set<string>()
  private readonly decoders = new Map<string, SurfaceDecoder>()
  private readonly keyFrameRequested = new Set<string>()
  private cursor: Cursor = { kind: 'default' }

  private pointer: Point = { x: 0, y: 0 }
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
      this.connection.send({ type: 'output', width: output.width, height: output.height })
      this.scheduleRender()
    }).observe(canvas)
    setInterval(() => this.sendFeedback(), 500)
    this.measureRefreshRate()
  }

  /**
   * A new connection: everything we had is stale, the server sends a full snapshot and key frames.
   */
  reset(): void {
    for (const decoder of this.decoders.values()) {
      decoder.close()
    }
    this.decoders.clear()
    this.frameSizes.clear()
    this.keyFrameRequested.clear()
    this.renderer.clearAll()
    this.windows = []
    this.localPositions.clear()
    this.placementSent.clear()
    this.grab = undefined
    this.interaction = undefined
    this.buttons = 0
    const output = this.renderer.resize()
    this.connection.send({ type: 'hello', output })
    if (document.hasFocus() && document.activeElement === this.canvas) {
      this.connection.send({ type: 'focus', focused: true })
    }
    this.scheduleRender()
  }

  /**
   * Current windows as shown (with local position overrides). For tests.
   */
  debugWindows(): (SceneWindow & { shownX: number; shownY: number; hasContent: boolean })[] {
    return this.windows.map((window) => {
      const position = this.windowPosition(window)
      return {
        ...window,
        shownX: position.x,
        shownY: position.y,
        hasContent: window.surfaces.every((surface) => this.renderer.hasContent(surface.id)),
      }
    })
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
      case 'welcome':
        break
    }
  }

  handleFrame(surface: string, data: Uint8Array): void {
    let decoder = this.decoders.get(surface)
    if (decoder === undefined) {
      decoder = new SurfaceDecoder()
      this.decoders.set(surface, decoder)
    }
    const frame = parseEncodedFrame(data)
    this.frameSizes.set(surface, frame.size)
    const start = performance.now()
    decoder.decode(frame).then(
      (decoded) => {
        this.recordDecodeDuration(performance.now() - start)
        this.keyFrameRequested.delete(surface)
        this.renderer.upload(surface, decoded)
        this.scheduleRender()
      },
      (error) => {
        if (!(error instanceof KeyFrameNeeded)) {
          console.warn(`Failed to decode frame of surface ${surface}:`, error)
        }
        if (!this.keyFrameRequested.has(surface)) {
          this.keyFrameRequested.add(surface)
          this.connection.send({ type: 'keyframe', surface })
        }
      },
    )
  }

  private updateScene(windows: SceneWindow[]) {
    this.windows = windows
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
    // the viewer decides where new windows go
    for (const window of windows) {
      if (window.placed || window.maximized || window.fullscreen || this.placementSent.has(window.id)) {
        continue
      }
      this.placementSent.add(window.id)
      const cascade = 40 + (placedCount++ % 10) * 32
      const x = cascade - window.geometry.x
      const y = cascade - window.geometry.y
      this.localPositions.set(window.id, { x, y })
      this.connection.send({ type: 'window.move', window: window.id, x, y })
    }
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
    this.renderer.beginFrame()
    for (const window of this.windows) {
      const position = this.windowPosition(window)
      for (const surface of window.surfaces) {
        this.renderer.drawSurface(surface.id, {
          x: position.x + surface.x,
          y: position.y + surface.y,
          width: surface.width,
          height: surface.height,
        })
      }
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
      const position = this.windowPosition(window)
      for (let s = window.surfaces.length - 1; s >= 0; s--) {
        const surface = window.surfaces[s]
        const rect: Rect = {
          x: position.x + surface.x,
          y: position.y + surface.y,
          width: surface.width,
          height: surface.height,
        }
        // TODO respect the surface input region (e.g. client side shadows)
        if (
          point.x >= rect.x &&
          point.y >= rect.y &&
          point.x < rect.x + rect.width &&
          point.y < rect.y + rect.height
        ) {
          return { window, surface: surface.id, sx: point.x - rect.x, sy: point.y - rect.y }
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
    const surface = window?.surfaces.find((s) => s.id === this.grab!.surface)
    if (window === undefined || surface === undefined) {
      return undefined
    }
    const position = this.windowPosition(window)
    return {
      window,
      surface: surface.id,
      sx: point.x - position.x - surface.x,
      sy: point.y - position.y - surface.y,
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

    canvas.addEventListener('pointerup', (event) => {
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
    if (message.mode === 'move') {
      this.interaction = {
        mode: 'move',
        window: window.id,
        startPointer: this.pointer,
        startPosition: this.windowPosition(window),
        lastSent: 0,
      }
      this.canvas.style.cursor = 'grabbing'
    } else {
      this.interaction = {
        mode: 'resize',
        window: window.id,
        edges: message.edges,
        startPointer: this.pointer,
        startSize: { width: window.geometry.width, height: window.geometry.height },
      }
    }
  }

  private continueInteraction() {
    const interaction = this.interaction!
    const dx = this.pointer.x - interaction.startPointer.x
    const dy = this.pointer.y - interaction.startPointer.y
    if (interaction.mode === 'move') {
      const position = { x: interaction.startPosition.x + dx, y: interaction.startPosition.y + dy }
      this.localPositions.set(interaction.window, position)
      const now = performance.now()
      if (now - interaction.lastSent > MOVE_SEND_INTERVAL) {
        interaction.lastSent = now
        this.connection.send({ type: 'window.move', window: interaction.window, ...position })
      }
      this.scheduleRender()
    } else {
      const { edges, startSize } = interaction
      const width = startSize.width + (edges & EDGE_RIGHT ? dx : edges & EDGE_LEFT ? -dx : 0)
      const height = startSize.height + (edges & EDGE_BOTTOM ? dy : edges & EDGE_TOP ? -dy : 0)
      const first = this.pendingResize === undefined
      this.pendingResize = {
        window: interaction.window,
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
        edges,
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
      const dx = this.pointer.x - interaction.startPointer.x
      const dy = this.pointer.y - interaction.startPointer.y
      const { edges, startSize } = interaction
      if (window) {
        this.connection.send({
          type: 'window.resize',
          window: window.id,
          width: Math.max(1, Math.round(startSize.width + (edges & EDGE_RIGHT ? dx : edges & EDGE_LEFT ? -dx : 0))),
          height: Math.max(1, Math.round(startSize.height + (edges & EDGE_BOTTOM ? dy : edges & EDGE_TOP ? -dy : 0))),
          edges,
          done: true,
        })
      }
      this.pendingResize = undefined
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
