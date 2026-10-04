import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { onViewerFeedback, setViewerAttached } from '../../FramePacing.js'
import { ControlMessage } from '../../viewer/ViewerTransport.js'
import { WlrCompositor, WlrNative } from '../WlrCompositor.js'

type Configure = { sid: number; width: number; height: number; state: Record<string, boolean | undefined> }
type Toplevel = {
  geometry: [number, number, number, number]
  configured: [number, number]
  maximized: boolean
  fullscreen: boolean
}

/** The native core, faked: records the calls and lets a test send wlroots events. */
class FakeCore {
  onEvent: (type: string, ...args: any[]) => void = () => undefined
  readonly configures: Configure[] = []
  readonly focus: number[] = []
  readonly keys: [number, boolean][] = []
  /** key, syncModifiers, releaseAllKeys and keyboardFocus calls, in order */
  readonly keyboard: string[] = []
  readonly buttons: [number, boolean][] = []
  readonly motions: [number, number, number][] = []
  readonly frameDone: number[] = []
  readonly closed: number[] = []
  readonly outputSizes: [number, number][] = []
  readonly clipboard: string[] = []
  readonly toplevels = new Map<number, Toplevel>()
  readonly children = new Map<number, [number, number, number][]>()

  readonly native: WlrNative = {
    create: (onEvent, _width, _height) => {
      this.onEvent = onEvent
      return { socket: 'wayland-test', fd: 99 }
    },
    dispatch: () => undefined,
    setOutputSize: (width, height) => {
      this.outputSizes.push([width, height])
    },
    pointerMotion: (sid, sx, sy) => {
      this.motions.push([sid, sx, sy])
    },
    pointerButton: (button, pressed) => {
      this.buttons.push([button, pressed])
    },
    pointerAxis: () => undefined,
    key: (code, pressed) => {
      this.keys.push([code, pressed])
      this.keyboard.push(`key ${code} ${pressed}`)
    },
    syncModifiers: (modifiers, eventCode) => {
      this.keyboard.push(`sync ${modifiers} ${eventCode}`)
    },
    releaseAllKeys: () => {
      this.keyboard.push('release all')
    },
    keyboardFocus: (sid) => {
      this.focus.push(sid)
      this.keyboard.push(`focus ${sid}`)
    },
    configure: (sid, width, height, state) => {
      this.configures.push({ sid, width, height, state })
      const toplevel = this.toplevels.get(sid)
      if (toplevel) {
        if (state.maximized !== undefined) {
          toplevel.maximized = state.maximized
        }
        if (width > 0 && height > 0) {
          toplevel.configured = [width, height]
        }
      }
    },
    close: (sid) => {
      this.closed.push(sid)
    },
    toplevelState: (sid) => this.toplevels.get(sid),
    windowSurfaces: (sid) => this.children.get(sid) ?? [[sid, 0, 0]],
    setPosition: () => undefined,
    sendFrameDone: (sid) => {
      this.frameDone.push(sid)
    },
    readPixels: () => undefined,
    setClipboardText: (text) => {
      this.clipboard.push(text)
    },
    createFrameEncoder: () => ({}),
    destroyFrameEncoder: () => undefined,
    requestKeyUnit: () => undefined,
    encodeFrame: () => undefined,
  }

  /** A mapped toplevel with a buffer: what an app's first window goes through. */
  newWindow(sid: number, options: { width?: number; height?: number; title?: string; parent?: number } = {}) {
    const width = options.width ?? 400
    const height = options.height ?? 300
    this.onEvent('surface-new', sid, `1/${sid}`)
    this.toplevels.set(sid, {
      geometry: [0, 0, width, height],
      configured: [0, 0],
      maximized: false,
      fullscreen: false,
    })
    this.onEvent('toplevel-new', sid)
    this.onEvent('toplevel-title', sid, options.title ?? `window ${sid}`)
    this.onEvent('toplevel-app-id', sid, 'test-app')
    if (options.parent !== undefined) {
      this.onEvent('toplevel-parent', sid, options.parent)
    }
    this.commit(sid, width, height)
    this.onEvent('surface-map', sid)
  }

  commit(sid: number, width: number, height: number, frameCallbacks = false) {
    this.onEvent(
      'surface-commit',
      sid,
      true,
      true,
      width,
      height,
      new Int32Array([0, 0, width, height]),
      width,
      height,
      new Int32Array([0, 0, width, height]),
      frameCallbacks,
    )
  }
}

let core: FakeCore
let compositor: WlrCompositor
let sent: ControlMessage[]

const flush = () => new Promise((resolve) => setImmediate(resolve))
const scenes = () => sent.filter((message) => message.type === 'scene')
const lastScene = () => scenes()[scenes().length - 1]
const windowsOf = (scene: ControlMessage) => scene.windows as any[]
const lastConfigure = (sid: number) => [...core.configures].reverse().find((configure) => configure.sid === sid)

beforeEach(() => {
  core = new FakeCore()
  compositor = new WlrCompositor({ h264Encoder: 'x264', videoStreams: 1 }, core.native, () => undefined)
  sent = []
  compositor.attach((message) => sent.push(message))
})

afterEach(() => {
  compositor.detach()
})

test('a mapped toplevel is a scene window, activated and focused', async () => {
  core.newWindow(1, { title: 'Terminal' })
  await flush()
  const [window] = windowsOf(lastScene())
  assert.equal(window.id, '1/1')
  assert.equal(window.title, 'Terminal')
  assert.equal(window.appId, 'test-app')
  assert.equal(window.activated, true)
  assert.equal(window.placed, false)
  assert.deepEqual(window.surfaces, [{ id: '1/1', x: 0, y: 0, width: 400, height: 300, input: undefined }])
  assert.equal(lastScene().focus, '1/1')
  assert.equal(core.focus[core.focus.length - 1], 1)
  assert.deepEqual(lastConfigure(1)?.state, { activated: true })
})

test('an unchanged scene is not sent again', async () => {
  core.newWindow(1)
  await flush()
  const count = scenes().length
  core.commit(1, 400, 300)
  await flush()
  assert.equal(scenes().length, count)
})

test('the viewer places windows; a dialog is centered on its parent and follows it', async () => {
  core.newWindow(1, { width: 400, height: 300 })
  compositor.handleMessage({ type: 'window.move', window: '1/1', x: 100, y: 50 })
  core.newWindow(2, { width: 100, height: 100, parent: 1 })
  await flush()
  let [parent, dialog] = windowsOf(lastScene())
  assert.deepEqual([parent.x, parent.y, parent.placed], [100, 50, true])
  assert.deepEqual([dialog.parent, dialog.x, dialog.y, dialog.placed], ['1/1', 250, 150, true])
  assert.equal(dialog.activated, true)

  compositor.handleMessage({ type: 'window.move', window: '1/1', x: 0, y: 0 })
  await flush()
  ;[parent, dialog] = windowsOf(lastScene())
  assert.deepEqual([dialog.x, dialog.y], [150, 100])
})

test('activating a window raises it; closing the active one activates the next', async () => {
  core.newWindow(1)
  core.newWindow(2)
  await flush()
  assert.deepEqual(
    windowsOf(lastScene()).map((window) => window.id),
    ['1/1', '1/2'],
  )
  compositor.handleMessage({ type: 'window.activate', window: '1/1' })
  await flush()
  assert.deepEqual(
    windowsOf(lastScene()).map((window) => [window.id, window.activated]),
    [
      ['1/2', false],
      ['1/1', true],
    ],
  )
  assert.deepEqual(lastConfigure(2)?.state, { activated: false })

  core.onEvent('surface-unmap', 1)
  core.onEvent('toplevel-destroy', 1)
  await flush()
  assert.deepEqual(
    windowsOf(lastScene()).map((window) => [window.id, window.activated]),
    [['1/2', true]],
  )
})

test('closing a dialog gives the focus back to its parent, not the topmost window', async () => {
  core.newWindow(1)
  core.newWindow(2)
  core.newWindow(3, { parent: 1 })
  core.onEvent('surface-unmap', 3)
  core.onEvent('toplevel-destroy', 3)
  await flush()
  assert.equal(lastScene().focus, '1/1')
  assert.equal(core.focus[core.focus.length - 1], 1)
})

test('closing the last window leaves nothing focused; minimized windows are not activated', async () => {
  core.newWindow(1)
  core.newWindow(2)
  compositor.handleMessage({ type: 'window.minimize', window: '1/1', minimized: true })
  core.onEvent('surface-unmap', 2)
  core.onEvent('toplevel-destroy', 2)
  await flush()
  assert.equal(lastScene().focus, null)
  assert.equal(core.focus[core.focus.length - 1], 0)
})

test('minimizing takes the focus away, with the window’s dialogs; activating restores it', async () => {
  core.newWindow(1)
  core.newWindow(2, { parent: 1 })
  compositor.handleMessage({ type: 'window.minimize', window: '1/1', minimized: true })
  await flush()
  assert.deepEqual(
    windowsOf(lastScene()).map((window) => window.minimized),
    [true, true],
  )
  assert.equal(lastScene().focus, null)
  assert.equal(core.focus[core.focus.length - 1], 0)

  compositor.handleMessage({ type: 'window.activate', window: '1/1' })
  await flush()
  assert.deepEqual(
    windowsOf(lastScene()).map((window) => window.minimized),
    [false, false],
  )
  assert.equal(lastScene().focus, '1/1')
})

test('maximizing configures the output size, and again when the output changes', async () => {
  compositor.handleMessage({ type: 'output', width: 1000, height: 700 })
  core.newWindow(1)
  core.onEvent('toplevel-request-maximize', 1, true)
  assert.deepEqual(lastConfigure(1), { sid: 1, width: 1000, height: 700, state: { maximized: true } })
  assert.ok(sent.some((message) => message.type === 'maximize-requested' && message.maximized === true))

  compositor.handleMessage({ type: 'output', width: 800, height: 600, scale: 2 })
  assert.deepEqual(core.outputSizes[core.outputSizes.length - 1], [800, 600])
  assert.deepEqual(lastConfigure(1), { sid: 1, width: 800, height: 600, state: { maximized: true } })
  assert.equal(compositor.viewerScale, 2)

  compositor.handleMessage({ type: 'window.maximize', window: '1/1', maximized: false })
  assert.deepEqual(lastConfigure(1), { sid: 1, width: 0, height: 0, state: { maximized: false } })
})

test('viewer resizes and closes go to the toplevel', () => {
  core.newWindow(1)
  compositor.handleMessage({ type: 'window.resize', window: '1/1', width: 500.4, height: 0 })
  assert.deepEqual(lastConfigure(1), { sid: 1, width: 500, height: 1, state: { resizing: true } })
  compositor.handleMessage({ type: 'window.resize', window: '1/1', width: 500, height: 200, done: true })
  assert.deepEqual(lastConfigure(1), { sid: 1, width: 500, height: 200, state: { resizing: false } })
  compositor.handleMessage({ type: 'window.close', window: '1/1' })
  assert.deepEqual(core.closed, [1])
})

test('move and resize requests from the app start an interaction in the viewer', () => {
  core.newWindow(1)
  core.onEvent('toplevel-request-move', 1)
  core.onEvent('toplevel-request-resize', 1, 6)
  assert.deepEqual(
    sent.filter((message) => message.type === 'interactive'),
    [
      { type: 'interactive', mode: 'move', window: '1/1' },
      { type: 'interactive', mode: 'resize', window: '1/1', edges: 6 },
    ],
  )
})

test('input: pointer over a surface, buttons and keys as Linux codes, page focus', () => {
  core.newWindow(1)
  compositor.handleMessage({ type: 'button', surface: '1/1', sx: 10, sy: 20, button: 0, pressed: true })
  compositor.handleMessage({ type: 'button', surface: '1/1', sx: 10, sy: 20, button: 3, pressed: false })
  assert.deepEqual(core.motions[core.motions.length - 1], [1, 10, 20])
  assert.deepEqual(core.buttons, [
    [0x110, true],
    [0x113, false],
  ])

  compositor.handleMessage({ type: 'key', code: 'KeyA', pressed: true })
  compositor.handleMessage({ type: 'key', code: 'NotAKey', pressed: true })
  assert.deepEqual(core.keys, [[30, true]])

  compositor.handleMessage({ type: 'focus', focused: false })
  assert.equal(core.focus[core.focus.length - 1], 0)
  compositor.handleMessage({ type: 'focus', focused: true })
  assert.equal(core.focus[core.focus.length - 1], 1)

  compositor.handleMessage({ type: 'pointer', surface: 'nothing', sx: 1, sy: 2 })
  assert.deepEqual(core.motions[core.motions.length - 1], [0, 1, 2])
  assert.deepEqual(sent[sent.length - 1], { type: 'cursor', kind: 'default' })
})

const NO_MODIFIERS = {
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
  altGr: false,
  capsLock: false,
  numLock: false,
}

test('modifiers: the browser state is synced before every input event, as bits', () => {
  core.newWindow(1)
  core.keyboard.length = 0
  const ctrl = { ...NO_MODIFIERS, ctrl: true }
  compositor.handleMessage({ type: 'key', code: 'ControlLeft', pressed: true, modifiers: ctrl })
  compositor.handleMessage({ type: 'key', code: 'KeyC', pressed: true, modifiers: ctrl })
  compositor.handleMessage({ type: 'key', code: 'KeyC', pressed: false, modifiers: ctrl })
  compositor.handleMessage({ type: 'key', code: 'ControlLeft', pressed: false, modifiers: NO_MODIFIERS })
  assert.deepEqual(core.keyboard, [
    'sync 1 29',
    'key 29 true',
    'sync 1 46',
    'key 46 true',
    'sync 1 46',
    'key 46 false',
    'sync 0 29',
    'key 29 false',
  ])

  core.keyboard.length = 0
  const all = { ctrl: true, shift: true, alt: true, meta: true, altGr: true, capsLock: true, numLock: true }
  compositor.handleMessage({ type: 'pointer', surface: '1/1', sx: 1, sy: 1, modifiers: all })
  compositor.handleMessage({ type: 'button', surface: '1/1', sx: 1, sy: 1, button: 0, pressed: true, modifiers: ctrl })
  compositor.handleMessage({ type: 'axis', surface: '1/1', sx: 1, sy: 1, deltaY: 3, deltaMode: 0, modifiers: ctrl })
  // an unknown key still syncs the modifiers; one without modifiers (an older viewer) syncs nothing
  compositor.handleMessage({ type: 'key', code: 'NotAKey', pressed: true, modifiers: ctrl })
  compositor.handleMessage({ type: 'key', code: '30', pressed: true, modifiers: ctrl })
  compositor.handleMessage({ type: 'key', code: 'toString', pressed: true, modifiers: ctrl })
  compositor.handleMessage({ type: 'key', code: 'KeyA', pressed: true })
  compositor.handleMessage({ type: 'pointer', surface: '1/1', sx: 1, sy: 1, modifiers: 'ctrl' })
  assert.deepEqual(core.keyboard, [
    'sync 127 0',
    'sync 1 0',
    'sync 1 0',
    'sync 1 0',
    'sync 1 0',
    'sync 1 0',
    'key 30 true',
  ])
})

test('modifiers: losing page focus, or the viewer, releases every key before the app loses keyboard focus', () => {
  core.newWindow(1)
  compositor.handleMessage({ type: 'focus', focused: true })
  core.keyboard.length = 0
  compositor.handleMessage({ type: 'focus', focused: false })
  assert.deepEqual(core.keyboard, ['release all', 'focus 0'])

  core.keyboard.length = 0
  compositor.handleMessage({ type: 'focus', focused: true })
  assert.deepEqual(core.keyboard, ['focus 1'])

  core.keyboard.length = 0
  compositor.detach()
  assert.deepEqual(core.keyboard, ['release all', 'focus 0'])
})

test('the input region is sent unless it is the whole surface, and as a box when it has many rectangles', async () => {
  core.newWindow(1, { width: 100, height: 100 })
  const commitWithInput = (input: number[]) =>
    core.onEvent('surface-commit', 1, true, false, 100, 100, new Int32Array(), 100, 100, new Int32Array(input), false)

  commitWithInput([10, 10, 80, 80])
  await flush()
  assert.deepEqual(windowsOf(lastScene())[0].surfaces[0].input, [{ x: 10, y: 10, width: 80, height: 80 }])

  const many: number[] = []
  for (let i = 0; i < 65; i++) {
    many.push(i, i, 1, 1)
  }
  commitWithInput(many)
  await flush()
  assert.deepEqual(windowsOf(lastScene())[0].surfaces[0].input, [{ x: 0, y: 0, width: 65, height: 65 }])
})

test('frame callbacks are sent, paced by the viewer', async () => {
  setViewerAttached(true)
  onViewerFeedback(16, 1)
  core.newWindow(1)
  core.commit(1, 400, 300, true)
  core.commit(1, 400, 300, true)
  const start = Date.now()
  while (core.frameDone.length === 0 && Date.now() - start < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  // one frame callback for both commits: they're all sent at once
  assert.deepEqual(core.frameDone, [1])
  setViewerAttached(false)
})

test('cursors: the app’s surface, a named shape, or hidden', () => {
  core.newWindow(1)
  core.onEvent('surface-new', 5, '1/5')
  core.onEvent('cursor-surface', 5, 3, 4)
  core.onEvent('cursor-shape', 'text')
  core.onEvent('cursor-surface', 0, 0, 0)
  assert.deepEqual(sent.filter((message) => message.type === 'cursor').slice(-3), [
    { type: 'cursor', kind: 'surface', surface: '1/5', hotspot: { x: 3, y: 4 } },
    { type: 'cursor', kind: 'named', name: 'text' },
    { type: 'cursor', kind: 'hidden' },
  ])
})

test('Wayland clients are reported with their process', () => {
  const events: string[] = []
  compositor.clientListener = {
    clientConnected: (id, pid) => events.push(`+${id}:${pid}`),
    clientDisconnected: (id) => events.push(`-${id}`),
  }
  core.onEvent('client-new', 1, 1234)
  core.onEvent('client-destroy', 1)
  assert.deepEqual(events, ['+1:1234', '-1'])
})

test('a reattached viewer gets the whole scene again', async () => {
  core.newWindow(1)
  await flush()
  compositor.detach()
  const again: ControlMessage[] = []
  compositor.attach((message) => again.push(message))
  assert.equal(again.filter((message) => message.type === 'scene').length, 1)
  assert.equal(windowsOf(again[0]).length, 1)
})

test('scene windows echo the last window change the viewer sent, even one that changed nothing', async () => {
  core.newWindow(1)
  core.newWindow(2)
  await flush()
  assert.deepEqual(
    windowsOf(lastScene()).map((window) => window.seq),
    [0, 0],
  )

  compositor.handleMessage({ type: 'window.move', window: '1/1', seq: 1, x: 10, y: 20 })
  await flush()
  const first = () => windowsOf(lastScene()).find((window) => window.id === '1/1')
  assert.deepEqual([first().seq, first().x, first().y], [1, 10, 20])

  // a move to where the window already is: a scene is still sent, so the viewer knows it's applied
  const count = scenes().length
  compositor.handleMessage({ type: 'window.move', window: '1/1', seq: 2, x: 10, y: 20 })
  await flush()
  assert.equal(scenes().length, count + 1)
  assert.equal(first().seq, 2)

  // every kind of window change is numbered, per window
  compositor.handleMessage({ type: 'window.resize', window: '1/1', seq: 3, width: 300, height: 200, done: true })
  compositor.handleMessage({ type: 'window.maximize', window: '1/1', seq: 4, maximized: false })
  compositor.handleMessage({ type: 'window.minimize', window: '1/2', seq: 1, minimized: true })
  compositor.handleMessage({ type: 'window.activate', window: '1/2', seq: 2 })
  await flush()
  const seqs = Object.fromEntries(windowsOf(lastScene()).map((window) => [window.id, window.seq]))
  assert.deepEqual(seqs, { '1/1': 4, '1/2': 2 })
  assert.deepEqual([first().x, first().y], [10, 20])
})

test('window changes without a valid, newer sequence number are applied but don’t lower the echo', async () => {
  core.newWindow(1)
  compositor.handleMessage({ type: 'window.move', window: '1/1', seq: 5, x: 10, y: 20 })
  compositor.handleMessage({ type: 'window.move', window: '1/1', seq: 3, x: 30, y: 40 })
  compositor.handleMessage({ type: 'window.move', window: '1/1', seq: 'x', x: 50, y: 60 })
  compositor.handleMessage({ type: 'window.move', window: '1/1', x: 70, y: 80 })
  await flush()
  const [window] = windowsOf(lastScene())
  assert.deepEqual([window.seq, window.x, window.y], [5, 70, 80])
})

test('a server-initiated change is reported without touching the sequence number', async () => {
  core.newWindow(1)
  compositor.handleMessage({ type: 'window.move', window: '1/1', seq: 1, x: 10, y: 20 })
  core.onEvent('toplevel-request-maximize', 1, true)
  core.toplevels.get(1)!.geometry = [10, 5, 1280, 720]
  core.commit(1, 1280, 720)
  await flush()
  const [window] = windowsOf(lastScene())
  assert.deepEqual([window.seq, window.maximized, window.x, window.y], [1, true, -10, -5])
})

test('an app clipboard text goes to the viewer; viewer text becomes the selection', () => {
  core.onEvent('clipboard-text', 'from the app')
  assert.deepEqual(sent.filter((message) => message.type === 'clipboard'), [
    { type: 'clipboard', text: 'from the app' },
  ])
  compositor.handleMessage({ type: 'clipboard', text: 'from the browser' })
  assert.deepEqual(core.clipboard, ['from the browser'])
  // the same text again, or the text the app just set, changes nothing
  compositor.handleMessage({ type: 'clipboard', text: 'from the browser' })
  core.onEvent('clipboard-text', 'again')
  compositor.handleMessage({ type: 'clipboard', text: 'again' })
  assert.deepEqual(core.clipboard, ['from the browser'])
  // not text, or too much of it
  compositor.handleMessage({ type: 'clipboard', text: 5 })
  compositor.handleMessage({ type: 'clipboard', text: 'x'.repeat(5 * 1024 * 1024) })
  assert.deepEqual(core.clipboard, ['from the browser'])
})

test('a drag of a remote app tells the viewer, with its icon and where the icon sits', async () => {
  core.newWindow(1)
  core.newWindow(2)
  const drags = () => sent.filter((message) => message.type === 'drag')
  core.onEvent('drag-start', 2)
  assert.deepEqual(drags(), [{ type: 'drag', active: true, icon: { surface: '1/2', x: 0, y: 0 } }])
  // the icon's surface offset changed
  core.onEvent('drag-icon', 2, -4, -6)
  assert.deepEqual(drags()[1], { type: 'drag', active: true, icon: { surface: '1/2', x: -4, y: -6 } })
  // a viewer that attaches in the middle of the drag hears about it
  const late: ControlMessage[] = []
  compositor.attach((message) => late.push(message))
  assert.deepEqual(late.filter((message) => message.type === 'drag'), [drags()[1]])
  core.onEvent('drag-icon', 0, 0, 0)
  core.onEvent('drag-end')
  const lateDrags = () => late.filter((message) => message.type === 'drag')
  assert.equal(lateDrags()[lateDrags().length - 1].active, false)
  assert.equal(lateDrags()[lateDrags().length - 1].icon, undefined)
  // a drag without an icon
  core.onEvent('drag-start', 0)
  assert.deepEqual(lateDrags().slice(-1), [
    { type: 'drag', active: true, icon: undefined },
  ])
})
