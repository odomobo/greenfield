import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { Streaming } from '../../streaming.js'
import { ControlMessage } from '@nebula/transport'
import { WlrCompositor, WlrNative } from '../WlrCompositor.js'

type Toplevel = {
  geometry: [number, number, number, number]
  configured: [number, number]
  limits: [number, number, number, number]
  maximized: boolean
  fullscreen: boolean
}

/** The native core, faked with only what X11 windows need; every other call does nothing. */
class FakeCore {
  onEvent: (type: string, ...args: any[]) => void = () => undefined
  readonly positions: [number, number, number][] = []
  readonly toplevels = new Map<number, Toplevel>()
  readonly surfaces = new Map<number, [number, number, number, boolean][]>()
  /** setBounds calls (sids): X11 windows are never told bounds */
  readonly bounded: number[] = []

  readonly native = new Proxy(
    {
      create: (onEvent: (type: string, ...args: any[]) => void) => {
        this.onEvent = onEvent
        return { socket: 'wayland-test', fd: 99, x11Display: ':5' }
      },
      configure: (sid: number, width: number, height: number, state: { maximized?: boolean }) => {
        const toplevel = this.toplevels.get(sid)
        if (toplevel && state.maximized !== undefined) {
          toplevel.maximized = state.maximized
        }
      },
      toplevelState: (sid: number) => this.toplevels.get(sid),
      setBounds: (sid: number) => {
        this.bounded.push(sid)
        return true
      },
      windowSurfaces: (sid: number) => this.surfaces.get(sid) ?? [[sid, 0, 0, false]],
      setPosition: (sid: number, x: number, y: number) => {
        this.positions.push([sid, x, y])
      },
    } as Record<string, unknown>,
    { get: (target, name: string) => target[name] ?? (() => undefined) },
  ) as unknown as WlrNative

  /** A mapped toplevel with a buffer; x11: an X11 window (XWayland). */
  newWindow(sid: number, x11: boolean, options: { width?: number; height?: number; parent?: number } = {}) {
    const width = options.width ?? 400
    const height = options.height ?? 300
    this.surface(sid, width, height)
    this.toplevels.set(sid, {
      geometry: [0, 0, width, height],
      configured: [0, 0],
      limits: [0, 0, 0, 0],
      maximized: false,
      fullscreen: false,
    })
    this.onEvent('toplevel-new', sid, x11)
    if (options.parent !== undefined) {
      this.onEvent('toplevel-parent', sid, options.parent)
    }
    this.onEvent('surface-map', sid)
  }

  /** A surface with a buffer, mapped by itself (an X11 override-redirect window's) or by its window. */
  surface(sid: number, width: number, height: number) {
    this.onEvent('surface-new', sid, `1/${sid}`)
    const all = new Int32Array([0, 0, width, height])
    this.onEvent('surface-commit', sid, true, true, width, height, all, width, height, all, false)
  }
}

let core: FakeCore
let compositor: WlrCompositor
let sent: ControlMessage[]

const flush = () => new Promise((resolve) => setImmediate(resolve))
const scenes = () => sent.filter((message) => message.type === 'scene')
const lastScene = () => scenes()[scenes().length - 1]
const windowsOf = (scene: ControlMessage) => scene.windows as any[]
const positionsOf = (sid: number) => core.positions.filter(([of]) => of === sid).map(([, x, y]) => [x, y])

let streaming: Streaming

beforeEach(() => {
  core = new FakeCore()
  streaming = new Streaming({ videoStreams: 1 })
  compositor = new WlrCompositor(
    { framePacing: streaming.framePacing, createSurface: streaming.createSurface },
    core.native,
    () => undefined,
  )
  sent = []
  compositor.attach((message) => sent.push(message))
})

afterEach(() => {
  compositor.detach()
  streaming.stop()
})

test('the X11 display is the one the core started', () => {
  assert.equal(compositor.x11Display, ':5')
})

test('an X11 window is told where the scene shows it, once per change (a Wayland window too, for its popups)', async () => {
  core.newWindow(1, true)
  core.newWindow(2, false)
  await flush()
  compositor.handleMessage({ type: 'window.move', window: '1/1', x: 120, y: 80 })
  compositor.handleMessage({ type: 'window.move', window: '1/2', x: 300, y: 200 })
  await flush()
  compositor.handleMessage({ type: 'window.activate', window: '1/2' })
  await flush()
  compositor.handleMessage({ type: 'window.move', window: '1/1', x: 10, y: 20 })
  await flush()
  assert.deepEqual(positionsOf(1), [
    [0, 0],
    [120, 80],
    [10, 20],
  ])
  assert.deepEqual(positionsOf(2), [
    [0, 0],
    [300, 200],
  ])
})

test('X11 windows are never told configure bounds (an xdg_toplevel thing), Wayland windows are', async () => {
  compositor.handleMessage({ type: 'output', width: 900, height: 600 })
  core.newWindow(1, true)
  core.newWindow(2, false)
  // (bounds go out with a toplevel's commit)
  for (const sid of [1, 2]) {
    core.onEvent('surface-commit', sid, true, false, 400, 300, new Int32Array(), 400, 300, new Int32Array(), false)
  }
  await flush()
  assert.ok(core.bounded.length > 0)
  assert.ok(core.bounded.every((sid) => sid === 2))
})

test('a maximized X11 window is at the output origin, and back where it was when restored', async () => {
  core.newWindow(1, true)
  compositor.handleMessage({ type: 'window.move', window: '1/1', x: 50, y: 60 })
  await flush()
  compositor.handleMessage({ type: 'window.maximize', window: '1/1', maximized: true })
  core.onEvent('surface-commit', 1, true, false, 400, 300, new Int32Array(), 400, 300, new Int32Array(), false)
  await flush()
  compositor.handleMessage({ type: 'window.maximize', window: '1/1', maximized: false })
  core.onEvent('surface-commit', 1, true, false, 400, 300, new Int32Array(), 400, 300, new Int32Array(), false)
  await flush()
  assert.deepEqual(positionsOf(1).slice(-3), [
    [50, 60],
    [0, 0],
    [50, 60],
  ])
})

test('an X11 window moving itself (XMoveWindow) is where the scene shows it; a dialog stays relative to its parent', async () => {
  core.newWindow(1, true, { width: 400, height: 300 })
  compositor.handleMessage({ type: 'window.move', window: '1/1', x: 100, y: 50 })
  core.newWindow(2, true, { width: 100, height: 100, parent: 1 })
  await flush()
  core.onEvent('toplevel-request-position', 1, 140, 70)
  await flush()
  let [main, dialog] = windowsOf(lastScene())
  assert.deepEqual([main.x, main.y, main.placed], [140, 70, true])
  // (the dialog follows its parent, as when the viewer moves it)
  assert.deepEqual([dialog.x, dialog.y], [290, 170])
  core.onEvent('toplevel-request-position', 2, 10, 20)
  await flush()
  ;[main, dialog] = windowsOf(lastScene())
  assert.deepEqual([dialog.x, dialog.y], [10, 20])
  assert.deepEqual(positionsOf(2).slice(-1), [[10, 20]])
})

test('an X11 dialog is told its position on the output, not relative to its parent', async () => {
  core.newWindow(1, true, { width: 400, height: 300 })
  compositor.handleMessage({ type: 'window.move', window: '1/1', x: 100, y: 50 })
  core.newWindow(2, true, { width: 100, height: 100, parent: 1 })
  await flush()
  assert.deepEqual(positionsOf(2), [[250, 150]])
})

test("an X11 menu moving by itself updates the scene of the window it's shown with", async () => {
  core.newWindow(1, true)
  core.surface(3, 80, 120)
  core.onEvent('surface-map', 3)
  core.surfaces.set(1, [
    [1, 0, 0, false],
    [3, 30, 40, true],
  ])
  await flush()
  // (the menu is one of the window's popups)
  assert.deepEqual(
    windowsOf(lastScene())[0].surfaces.map((surface: any) => [surface.id, surface.x, surface.y, surface.popup]),
    [
      ['1/1', 0, 0, undefined],
      ['1/3', 30, 40, true],
    ],
  )
  // a menu (override-redirect) isn't a window of its own
  assert.equal(windowsOf(lastScene()).length, 1)

  core.surfaces.set(1, [
    [1, 0, 0, false],
    [3, 60, 40, true],
  ])
  core.onEvent('x11-geometry', 3)
  await flush()
  assert.deepEqual(windowsOf(lastScene())[0].surfaces[1].x, 60)
})

test('a closed X11 window is forgotten', async () => {
  core.newWindow(1, true)
  await flush()
  core.onEvent('surface-unmap', 1)
  core.onEvent('toplevel-destroy', 1)
  core.onEvent('surface-destroy', 1)
  await flush()
  assert.deepEqual(windowsOf(lastScene()), [])
  const count = core.positions.length
  compositor.handleMessage({ type: 'window.move', window: '1/1', x: 5, y: 5 })
  await flush()
  assert.equal(core.positions.length, count)
})
