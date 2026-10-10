import { after, afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { FramePacing, MAX_FRAME_HOLD_MS } from '@nebula/scheduler'
import { ControlMessage } from '@nebula/transport'
import type { EncodingSink } from '../../encoding/SurfaceEncoder.js'
import { FRAME_BORDER, FRAME_TITLE_HEIGHT } from '@gfld/scene-protocol'
import { WlrCompositor, WlrNative } from '../WlrCompositor.js'

type Configure = { sid: number; width: number; height: number; state: Record<string, boolean | undefined> }
type Toplevel = {
  geometry: [number, number, number, number]
  configured: [number, number]
  limits: [number, number, number, number]
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
  readonly axes: [boolean, number, number, boolean | undefined][] = []
  readonly relative: [number, number][] = []
  readonly touches: [number, number, number, number, number][] = []
  releases = 0
  encodersCreated = 0
  readonly frameDone: number[] = []
  readonly closed: number[] = []
  readonly outputSizes: [number, number][] = []
  readonly positions: [number, number, number][] = []
  readonly keyboardConfigs: unknown[] = []
  readonly clipboard: string[] = []
  /** startFileDrag, fileDragAccepted, dropFileDrag, cancelFileDrag and provideFiles calls */
  readonly fileDrag: string[] = []
  readonly outputScales: number[] = []
  readonly toplevels = new Map<number, Toplevel>()
  readonly children = new Map<number, [number, number, number, boolean][]>()
  /** surfaces that committed (a toplevel can be configured, bounds included, from its first commit on) */
  readonly committed = new Set<number>()
  readonly bounds: [number, number, number][] = []

  readonly native: WlrNative = {
    create: (onEvent, _width, _height, keyboard) => {
      this.onEvent = onEvent
      this.keyboardConfigs.push(keyboard)
      return { socket: 'wayland-test', fd: 99 }
    },
    dispatch: () => undefined,
    setOutputSize: (width, height) => {
      this.outputSizes.push([width, height])
    },
    setOutputScale: (scale) => {
      this.outputScales.push(scale)
    },
    pointerMotion: (sid, sx, sy) => {
      this.motions.push([sid, sx, sy])
    },
    pointerButton: (button, pressed) => {
      this.buttons.push([button, pressed])
    },
    pointerAxis: (horizontal, value, discrete, _time, finger) => {
      this.axes.push([horizontal, value, discrete, finger])
    },
    pointerRelative: (dx, dy) => {
      this.relative.push([dx, dy])
    },
    pointerConstraintRelease: () => {
      this.releases++
      // the core ends the constraint and says so
      this.onEvent('pointer-constraint', 1, false, false)
    },
    touch: (phase, sid, id, sx, sy) => {
      this.touches.push([phase, sid, id, sx, sy])
    },
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
        if (state.fullscreen !== undefined) {
          toplevel.fullscreen = state.fullscreen
        }
        if (width > 0 && height > 0) {
          toplevel.configured = [width, height]
        }
      }
    },
    close: (sid) => {
      this.closed.push(sid)
    },
    setBounds: (sid, width, height) => {
      if (!this.toplevels.has(sid) || !this.committed.has(sid)) {
        return false
      }
      this.bounds.push([sid, width, height])
      return true
    },
    toplevelState: (sid) => this.toplevels.get(sid),
    windowSurfaces: (sid) => this.children.get(sid) ?? [[sid, 0, 0, false]],
    setPosition: (sid, x, y) => {
      this.positions.push([sid, x, y])
    },
    sendFrameDone: (sid) => {
      this.frameDone.push(sid)
    },
    takeFrame: () => undefined,
    setClipboardText: (text) => {
      this.clipboard.push(text)
    },
    startFileDrag: (sid) => {
      this.fileDrag.push(`start ${sid}`)
      return true
    },
    fileDragAccepted: () => true,
    dropFileDrag: () => {
      this.fileDrag.push('drop')
    },
    cancelFileDrag: () => {
      this.fileDrag.push('cancel')
    },
    provideFiles: (list) => {
      this.fileDrag.push(`provide ${JSON.stringify(list)}`)
    },
  }

  /** A mapped toplevel with a buffer: what an app's first window goes through. */
  newWindow(
    sid: number,
    options: { width?: number; height?: number; title?: string; parent?: number; decorated?: boolean } = {},
  ) {
    const width = options.width ?? 400
    const height = options.height ?? 300
    this.onEvent('surface-new', sid, `1/${sid}`)
    this.toplevels.set(sid, {
      geometry: [0, 0, width, height],
      configured: [0, 0],
      limits: [0, 0, 0, 0],
      maximized: false,
      fullscreen: false,
    })
    this.onEvent('toplevel-new', sid)
    if (options.decorated) {
      this.onEvent('toplevel-decorated', sid, true)
    }
    this.onEvent('toplevel-title', sid, options.title ?? `window ${sid}`)
    this.onEvent('toplevel-app-id', sid, 'test-app')
    if (options.parent !== undefined) {
      this.onEvent('toplevel-parent', sid, options.parent)
    }
    this.commit(sid, width, height)
    this.onEvent('surface-map', sid)
  }

  commit(sid: number, width: number, height: number, frameCallbacks = false) {
    this.committed.add(sid)
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
const waitFor = async (condition: () => boolean) => {
  // real time: some things (PNG encoding of icons) finish on other threads
  const start = Date.now()
  while (!condition() && Date.now() - start < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.ok(condition(), 'timed out')
}
const scenes = () => sent.filter((message) => message.type === 'scene')
const lastScene = () => scenes()[scenes().length - 1]
const windowsOf = (scene: ControlMessage) => scene.windows as any[]
const lastConfigure = (sid: number) => [...core.configures].reverse().find((configure) => configure.sid === sid)

const framePacing = new FramePacing()
after(() => framePacing.stop())

beforeEach(() => {
  core = new FakeCore()
  const fakeCore = core
  compositor = new WlrCompositor(
    {
      videoStreams: 1,
      framePacing,
      createVideoEncoder: () => {
        fakeCore.encodersCreated++
        return {
          encode: (frame) => {
            frame.release()
            return Promise.resolve(new Uint8Array())
          },
          requestKeyUnit: () => undefined,
          setQuality: () => undefined,
          destroy: () => undefined,
        }
      },
    },
    core.native,
    () => undefined,
  )
  sent = []
  compositor.attach((message) => sent.push(message))
})

afterEach(() => {
  compositor.detach()
})

test('a window is told its bounds from its first commit: the output minus our frame, again when its frame changes (not the output)', async () => {
  compositor.handleMessage({ type: 'output', width: 1000, height: 700 })
  // decorated before its first commit (foot asks for server side decorations first): applied at the commit
  core.newWindow(1, { decorated: true })
  core.newWindow(2)
  assert.deepEqual(core.bounds, [
    [1, 1000 - 2 * FRAME_BORDER, 700 - FRAME_TITLE_HEIGHT - FRAME_BORDER],
    [2, 1000, 700],
  ])
  // once per change, not per commit
  core.commit(1, 400, 300)
  assert.equal(core.bounds.length, 2)
  // a narrower output isn't told to open windows (GTK would shrink to fit), a new frame is
  compositor.handleMessage({ type: 'output', width: 800, height: 600 })
  assert.equal(core.bounds.length, 2)
  core.onEvent('toplevel-decorated', 2, true)
  assert.deepEqual(core.bounds.slice(2), [[2, 800 - 2 * FRAME_BORDER, 600 - FRAME_TITLE_HEIGHT - FRAME_BORDER]])
})

test("an app's title bar right-clicked (show_window_menu) asks the viewer for its window menu there", async () => {
  core.newWindow(1)
  core.onEvent('toplevel-request-window-menu', 1, 40, 12)
  core.onEvent('toplevel-request-window-menu', 9, 1, 1)
  assert.deepEqual(
    sent.filter((message) => message.type === 'window-menu-requested'),
    [{ type: 'window-menu-requested', window: '1/1', x: 40, y: 12 }],
  )
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

test('activating a dialog raises it with its parent, above the parent’s other dialogs', async () => {
  core.newWindow(1)
  core.newWindow(2, { parent: 1 })
  core.newWindow(3, { parent: 1 })
  core.newWindow(4)
  await flush()
  assert.deepEqual(
    windowsOf(lastScene()).map((window) => window.id),
    ['1/1', '1/2', '1/3', '1/4'],
  )
  compositor.handleMessage({ type: 'window.activate', window: '1/2' })
  await flush()
  assert.deepEqual(
    windowsOf(lastScene()).map((window) => [window.id, window.activated]),
    [
      ['1/4', false],
      ['1/1', false],
      ['1/3', false],
      ['1/2', true],
    ],
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
  assert.equal(core.outputScales[core.outputScales.length - 1], 2)

  compositor.handleMessage({ type: 'window.maximize', window: '1/1', maximized: false })
  assert.deepEqual(lastConfigure(1), { sid: 1, width: 0, height: 0, state: { maximized: false } })
})

test('fullscreen covers the output, shows in the scene and goes back; a new output size is followed', async () => {
  compositor.handleMessage({ type: 'output', width: 1000, height: 700 })
  core.newWindow(1)
  core.onEvent('toplevel-request-fullscreen', 1, true)
  assert.deepEqual(lastConfigure(1), { sid: 1, width: 1000, height: 700, state: { fullscreen: true } })
  await flush()
  assert.equal(windowsOf(lastScene())[0].fullscreen, true)

  compositor.handleMessage({ type: 'output', width: 800, height: 600 })
  assert.deepEqual(lastConfigure(1), { sid: 1, width: 800, height: 600, state: { fullscreen: true } })

  core.onEvent('toplevel-request-fullscreen', 1, false)
  assert.deepEqual(lastConfigure(1), { sid: 1, width: 0, height: 0, state: { fullscreen: false } })
  core.commit(1, 400, 300)
  await flush()
  assert.equal(windowsOf(lastScene())[0].fullscreen, false)
})

test('an activation request raises, restores and focuses the window', async () => {
  core.newWindow(1)
  core.newWindow(2)
  compositor.handleMessage({ type: 'window.minimize', window: '1/1', minimized: true })
  await flush()
  assert.equal(lastScene().focus, '1/2')
  core.onEvent('toplevel-request-activate', 1)
  await flush()
  const windows = windowsOf(lastScene())
  assert.equal(lastScene().focus, '1/1')
  assert.equal(windows.find((window) => window.id === '1/1').minimized, false)
  assert.equal(windows[windows.length - 1].id, '1/1')
  core.onEvent('toplevel-request-activate', 99)
})

test('the core is told where windows are shown, so it keeps popups inside the output', async () => {
  core.newWindow(1)
  compositor.handleMessage({ type: 'window.move', window: '1/1', x: 100, y: 50 })
  await flush()
  assert.deepEqual(core.positions[core.positions.length - 1], [1, 100, 50])
  const count = core.positions.length
  compositor.handleMessage({ type: 'window.move', window: '1/1', x: 100, y: 50 })
  await flush()
  assert.equal(core.positions.length, count)
})

test('the keyboard configuration is passed to the core', () => {
  assert.equal(core.keyboardConfigs.length, 1)
  assert.equal(typeof core.keyboardConfigs[0], 'object')
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
  framePacing.setViewerAttached(true)
  framePacing.onViewerFeedback(16)
  core.newWindow(1)
  core.commit(1, 400, 300, true)
  core.commit(1, 400, 300, true)
  const start = Date.now()
  while (core.frameDone.length === 0 && Date.now() - start < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  // one frame callback for both commits: they're all sent at once
  assert.deepEqual(core.frameDone, [1])
  framePacing.setViewerAttached(false)
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

test('HiDPI: the scene stays logical when an app commits a buffer at the viewer’s scale', async () => {
  compositor.handleMessage({ type: 'output', width: 1000, height: 700, scale: 2 })
  assert.equal(core.outputScales[core.outputScales.length - 1], 2)
  core.newWindow(1, { width: 100, height: 80 })
  // a 200x160 buffer at buffer scale 2: logical size 100x80
  core.onEvent(
    'surface-commit',
    1,
    true,
    true,
    200,
    160,
    new Int32Array([0, 0, 200, 160]),
    100,
    80,
    new Int32Array([0, 0, 100, 80]),
    false,
  )
  await flush()
  const surface = windowsOf(lastScene())[0].surfaces[0]
  assert.deepEqual([surface.width, surface.height], [100, 80])
  assert.equal(surface.input, undefined)
})

test('HiDPI: a cursor surface is sent with its logical size, again when it changes', () => {
  core.newWindow(1)
  core.onEvent('surface-new', 5, '1/5')
  core.onEvent('cursor-surface', 5, 3, 4)
  const cursors = () => sent.filter((message) => message.type === 'cursor')
  // no commit yet: the size is unknown, the viewer falls back to the image's
  assert.equal(cursors()[cursors().length - 1].size, undefined)
  // a 48x48 image at scale 2
  core.onEvent('surface-commit', 5, true, true, 48, 48, new Int32Array([0, 0, 48, 48]), 24, 24, new Int32Array(), false)
  assert.deepEqual(cursors()[cursors().length - 1], {
    type: 'cursor',
    kind: 'surface',
    surface: '1/5',
    hotspot: { x: 3, y: 4 },
    size: { width: 24, height: 24 },
  })
  // the same size again: nothing new
  const count = cursors().length
  core.onEvent('surface-commit', 5, true, true, 48, 48, new Int32Array([0, 0, 48, 48]), 24, 24, new Int32Array(), false)
  assert.equal(cursors().length, count)
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

test('the scene that no longer shows a destroyed surface tells the viewer to forget it; a new viewer has nothing to forget', async () => {
  core.newWindow(1)
  core.newWindow(2)
  await flush()
  core.onEvent('surface-unmap', 2)
  core.onEvent('toplevel-destroy', 2)
  core.onEvent('surface-destroy', 2)
  await flush()
  assert.deepEqual(
    windowsOf(lastScene()).map((window) => window.id),
    ['1/1'],
  )
  assert.deepEqual(lastScene().destroyed, ['1/2'])
  // a surface that never was in a scene (e.g. a drag icon) is forgotten too, with an otherwise unchanged scene
  core.onEvent('surface-new', 3, '1/3')
  core.onEvent('surface-destroy', 3)
  await flush()
  assert.deepEqual(lastScene().destroyed, ['1/3'])
  const count = scenes().length
  core.commit(1, 400, 300)
  await flush()
  assert.equal(scenes().length, count, 'nothing to forget: no scene')

  compositor.detach()
  core.onEvent('surface-destroy', 1)
  const again: ControlMessage[] = []
  compositor.attach((message) => again.push(message))
  await flush()
  assert.ok(again.every((message) => message.destroyed === undefined))
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

test('the size limits an app declared reach the scene; 0 (unbounded) is left out', async () => {
  core.newWindow(1)
  core.newWindow(2)
  core.toplevels.get(1)!.limits = [320, 200, 0, 0]
  core.toplevels.get(2)!.limits = [0, 0, 800, 600]
  core.commit(1, 400, 300)
  await flush()
  const [first, second] = windowsOf(lastScene())
  assert.deepEqual([first.minWidth, first.minHeight, first.maxWidth, first.maxHeight], [320, 200, undefined, undefined])
  assert.deepEqual(
    [second.minWidth, second.minHeight, second.maxWidth, second.maxHeight],
    [undefined, undefined, 800, 600],
  )
  core.newWindow(3)
  await flush()
  const third = windowsOf(lastScene()).find((window) => window.id === '1/3')!
  assert.equal('minWidth' in third || 'maxWidth' in third, false)
})

test('an app clipboard text goes to the viewer; viewer text becomes the selection', () => {
  core.onEvent('clipboard-text', 'from the app')
  assert.deepEqual(
    sent.filter((message) => message.type === 'clipboard'),
    [{ type: 'clipboard', text: 'from the app' }],
  )
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
  assert.deepEqual(
    late.filter((message) => message.type === 'drag'),
    [drags()[1]],
  )
  core.onEvent('drag-icon', 0, 0, 0)
  core.onEvent('drag-end')
  const lateDrags = () => late.filter((message) => message.type === 'drag')
  assert.equal(lateDrags()[lateDrags().length - 1].active, false)
  assert.equal(lateDrags()[lateDrags().length - 1].icon, undefined)
  // a drag without an icon
  core.onEvent('drag-start', 0)
  assert.deepEqual(lateDrags().slice(-1), [{ type: 'drag', active: true, icon: undefined }])
})

test('files dragged in start a drag on the surface under the pointer, move it, and cancel it when they leave', () => {
  core.newWindow(1)
  const target = (x: number) => ({ surface: '1/1', sx: x, sy: 5, x, y: 5, time: 1 })
  compositor.handleMessage({ type: 'file-drag', over: true, ...target(10) })
  compositor.handleMessage({ type: 'file-drag', over: true, ...target(20) })
  assert.deepEqual(core.fileDrag, ['start 1'])
  assert.deepEqual(core.motions.slice(-2), [
    [1, 10, 5],
    [1, 20, 5],
  ])
  compositor.handleMessage({ type: 'file-drag', over: false })
  assert.deepEqual(core.fileDrag, ['start 1', 'cancel'])
  // over the desktop there's nothing to drop on
  compositor.handleMessage({ type: 'file-drag', over: true, surface: null, x: 5, y: 5, time: 1 })
  assert.deepEqual(core.fileDrag, ['start 1', 'cancel'])
})

test('axis: wheel clicks are v120 values, a touchpad scrolls smoothly', () => {
  core.newWindow(1)
  const axis = (extra: Record<string, unknown>) =>
    compositor.handleMessage({ type: 'axis', surface: '1/1', sx: 1, sy: 1, deltaMode: 0, ...extra })
  // Firefox: 3 lines per click
  axis({ deltaMode: 1, deltaY: 3 })
  axis({ deltaMode: 1, deltaY: -6 })
  // Chromium: 100 px per click, marked as a click by the viewer
  axis({ deltaY: 100, wheelY: 120 })
  axis({ deltaX: -100, wheelX: -120 })
  // touchpad
  axis({ deltaY: 12 })
  assert.deepEqual(core.axes, [
    [false, 15, 120, false],
    [false, -30, -240, false],
    [false, 15, 120, false],
    [true, -15, -120, false],
    [false, 4, 0, true],
  ])
})

test('pointer lock: the app locks the focused surface, the viewer sends relative motion and ends it', () => {
  core.newWindow(1)
  compositor.handleMessage({ type: 'focus', focused: true })
  compositor.attach((message) => sent.push(message))
  // relative motion without a lock is dropped
  compositor.handleMessage({ type: 'pointer.relative', dx: 1, dy: 2, time: 5 })
  assert.deepEqual(core.relative, [])
  core.onEvent('pointer-constraint', 1, true, false)
  assert.deepEqual(
    sent.filter((m) => m.type === 'pointer.lock'),
    [{ type: 'pointer.lock', surface: '1/1', locked: true, confined: false }],
  )
  compositor.handleMessage({ type: 'pointer.relative', dx: 3, dy: -4, time: 5 })
  assert.deepEqual(core.relative, [[3, -4]])
  // a viewer that attaches later hears about it
  const late: ControlMessage[] = []
  compositor.attach((message) => late.push(message))
  assert.ok(late.some((m) => m.type === 'pointer.lock' && m.locked === true))
  // the browser ended it (Escape)
  compositor.handleMessage({ type: 'pointer.unlock' })
  assert.equal(core.releases, 1)
  assert.deepEqual(late.filter((m) => m.type === 'pointer.lock').at(-1), {
    type: 'pointer.lock',
    surface: '1/1',
    locked: false,
    confined: false,
  })
  compositor.handleMessage({ type: 'pointer.relative', dx: 1, dy: 1, time: 6 })
  assert.equal(core.relative.length, 1)
})

test('pointer lock ends when the page loses focus, and confinement takes no relative motion', () => {
  core.newWindow(1)
  compositor.handleMessage({ type: 'focus', focused: true })
  core.onEvent('pointer-constraint', 1, true, false)
  compositor.handleMessage({ type: 'focus', focused: false })
  assert.equal(core.releases, 1)
  core.onEvent('pointer-constraint', 1, true, true)
  compositor.handleMessage({ type: 'pointer.relative', dx: 1, dy: 1, time: 6 })
  assert.deepEqual(core.relative, [])
})

test('touch points go to the core by phase, with the surface they started on', () => {
  core.newWindow(1)
  const touch = (phase: string, id: number, sx: number) =>
    compositor.handleMessage({ type: 'touch', phase, id, surface: '1/1', sx, sy: 7 })
  touch('down', 3, 10)
  touch('move', 3, 11)
  touch('up', 3, 11)
  touch('bogus', 3, 11)
  assert.deepEqual(core.touches, [
    [0, 1, 3, 10, 7],
    [1, 1, 3, 11, 7],
    [2, 1, 3, 11, 7],
  ])
})

test('X11 windows tell the app tracker their process, and their icon reaches the viewer', async () => {
  const tracked: string[] = []
  compositor.clientListener = {
    clientConnected: () => undefined,
    clientDisconnected: () => undefined,
    x11WindowMapped: (sid, pid) => tracked.push(`mapped ${sid} ${pid}`),
    x11WindowGone: (sid) => tracked.push(`gone ${sid}`),
  }
  compositor.attach((message) => sent.push(message))
  core.onEvent('surface-new', 1, '1/1')
  core.onEvent('toplevel-new', 1, true, 4321)
  core.onEvent('toplevel-icon', 1, 2, 2, Buffer.alloc(16, 255))
  await waitFor(() => sent.some((m) => m.type === 'window.icon'))
  const icon = sent.find((m) => m.type === 'window.icon')!
  assert.equal(icon.window, '1/1')
  assert.match(String(icon.icon), /^data:image\/png;base64,/)
  // sent again to a viewer that attaches later
  const late: ControlMessage[] = []
  compositor.attach((message) => late.push(message))
  assert.ok(late.some((m) => m.type === 'window.icon'))
  core.onEvent('toplevel-destroy', 1)
  assert.deepEqual(tracked, ['mapped 1 4321', 'gone 1'])
})

/**
 * A sink that takes patches and frames and never sends them until `release` (the network takes the oldest). Each item
 * counts as a chunk, so a surface's stream is ready while at most one of its items is held.
 */
function holdingSink() {
  const held: { surface: string; done: (sent: boolean) => void }[] = []
  const sink: EncodingSink = {
    active: true,
    bandwidthLimited: false,
    linkBandwidth: undefined,
    queuedBytes: () => 0,
    streamReady: (surface) => held.filter((item) => item.surface === surface).length <= 1,
    sendFrame: (surface, _frame, _class, done) => held.push({ surface, done }),
    sendPatch: (surface, _patch, _class, done) => held.push({ surface, done }),
  }
  const release = () => {
    const item = held.shift()
    if (item) {
      item.done(true)
      sink.onStreamReady?.(item.surface)
    }
  }
  return { sink, held, release }
}

function readablePixels() {
  ;(core.native as any).takeFrame = (_sid: number, contentSerial: number) => ({
    width: 0,
    height: 0,
    contentSerial,
    readPixels: (rect: { width: number; height: number }) => ({
      pixels: new Uint8Array(rect.width * rect.height * 4),
      opaque: false,
    }),
    release: () => undefined,
  })
}

test('without a hardware encoder no video encoder is ever created, whatever the surfaces do', async () => {
  const { sink, held } = holdingSink()
  compositor.setFrameSink(sink)
  readablePixels()
  core.newWindow(1, { width: 800, height: 600 })
  for (let i = 0; i < 20; i++) {
    core.commit(1, 800, 600)
  }
  await waitFor(() => held.length > 0)
  assert.equal(core.encodersCreated, 0)
  // a buffer that can't be read can't be shown without an encoder, but still no encoder is created
  ;(core.native as any).takeFrame = () => undefined
  core.newWindow(2, { width: 800, height: 600 })
  await flush()
  assert.equal(core.encodersCreated, 0)
})

test('frame callbacks are held while the surface’s stream is not ready, and released once it is', async () => {
  framePacing.setViewerAttached(true)
  framePacing.onViewerFeedback(16)
  const { sink, held, release } = holdingSink()
  compositor.setFrameSink(sink)
  readablePixels()
  try {
    core.newWindow(1, { width: 400, height: 256 })
    await waitFor(() => held.length === 2)
    core.commit(1, 400, 256, true)
    // a frame clock tick or two pass while its stream isn't ready: the callback is held (for up to MAX_FRAME_HOLD_MS)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(core.frameDone, [])
    // the network takes the surface's items one by one; its queued patches follow until they are all out
    const start = Date.now()
    while (core.frameDone.length === 0 && Date.now() - start < 2000) {
      release()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.deepEqual(core.frameDone, [1])
  } finally {
    framePacing.setViewerAttached(false)
  }
})

test('a surface whose stream stays not ready still gets its frame callback after MAX_FRAME_HOLD_MS (10 a second)', async () => {
  framePacing.setViewerAttached(true)
  framePacing.onViewerFeedback(16)
  const { sink, held } = holdingSink()
  compositor.setFrameSink(sink)
  readablePixels()
  try {
    core.newWindow(1, { width: 400, height: 256 })
    await waitFor(() => held.length === 2)
    const start = performance.now()
    core.commit(1, 400, 256, true)
    await waitFor(() => core.frameDone.length > 0)
    const waited = performance.now() - start
    assert.deepEqual(core.frameDone, [1])
    assert.ok(waited >= MAX_FRAME_HOLD_MS - 40 && waited < MAX_FRAME_HOLD_MS + 150, `after ${Math.round(waited)} ms`)
    assert.equal(held.length, 2, 'nothing was sent meanwhile')
  } finally {
    framePacing.setViewerAttached(false)
  }
})

test('decorated windows say so in the scene; undecorated ones leave the flag out; the decoration can go again', async () => {
  core.newWindow(1, { decorated: true })
  core.newWindow(2)
  await flush()
  let [framed, plain] = windowsOf(lastScene())
  assert.equal(framed.decorated, true)
  assert.ok(!('decorated' in plain))
  // the app destroyed its decoration object: it draws its own frame now
  core.onEvent('toplevel-decorated', 1, false)
  await flush()
  ;[framed, plain] = windowsOf(lastScene())
  assert.ok(!('decorated' in framed))
})

test('a decorated window is maximized to the output minus its title bar, below it; undecorated ones to the output', async () => {
  compositor.handleMessage({ type: 'output', width: 1000, height: 700 })
  core.newWindow(1, { decorated: true })
  core.newWindow(2)
  core.onEvent('toplevel-request-maximize', 1, true)
  core.onEvent('toplevel-request-maximize', 2, true)
  assert.deepEqual(lastConfigure(1), {
    sid: 1,
    width: 1000,
    height: 700 - FRAME_TITLE_HEIGHT,
    state: { maximized: true },
  })
  assert.deepEqual(lastConfigure(2), { sid: 2, width: 1000, height: 700, state: { maximized: true } })
  await flush()
  const [framed, plain] = windowsOf(lastScene())
  assert.deepEqual([framed.x, framed.y], [0, FRAME_TITLE_HEIGHT])
  assert.deepEqual([plain.x, plain.y], [0, 0])
  // the output changes: the title bar is subtracted again
  compositor.handleMessage({ type: 'output', width: 800, height: 600 })
  assert.deepEqual(lastConfigure(1), {
    sid: 1,
    width: 800,
    height: 600 - FRAME_TITLE_HEIGHT,
    state: { maximized: true },
  })
})

test('a window that becomes decorated while maximized is reconfigured below its title bar', async () => {
  compositor.handleMessage({ type: 'output', width: 1000, height: 700 })
  core.newWindow(1)
  core.onEvent('toplevel-request-maximize', 1, true)
  core.onEvent('toplevel-decorated', 1, true)
  assert.equal(lastConfigure(1)?.height, 700 - FRAME_TITLE_HEIGHT)
})

test('a shown window whose decorations change is told its size (Chrome redoes its window geometry then)', async () => {
  core.newWindow(1)
  // Chrome with its own title bar: the window geometry is inset by its shadow
  core.toplevels.get(1)!.geometry = [16, 10, 368, 280]
  const configures = core.configures.length
  core.onEvent('toplevel-decorated', 1, true)
  assert.deepEqual(lastConfigure(1), { sid: 1, width: 368, height: 280, state: {} })
  // a window not shown yet (foot asks before its first commit) isn't
  core.onEvent('surface-new', 2, '1/2')
  core.toplevels.set(2, { ...core.toplevels.get(1)!, geometry: [0, 0, 400, 300] })
  core.onEvent('toplevel-new', 2)
  core.onEvent('toplevel-decorated', 2, true)
  assert.equal(core.configures.length, configures + 1)
})

test('a dialog is centered on its parent counting both frames', async () => {
  core.newWindow(1, { width: 400, height: 300, decorated: true })
  compositor.handleMessage({ type: 'window.move', window: '1/1', x: 100, y: 50 })
  core.newWindow(2, { width: 100, height: 100, parent: 1, decorated: true })
  await flush()
  const [, dialog] = windowsOf(lastScene())
  // equal frames around both: the outer rectangles share their centers, as the contents do (the parent is at 100, 50)
  assert.deepEqual([dialog.x, dialog.y], [250, 150])
  // an undecorated dialog on a decorated parent: the parent's outer rectangle is the taller one (title bar, borders)
  core.newWindow(3, { width: 100, height: 100, parent: 1 })
  await flush()
  const third = windowsOf(lastScene()).find((window) => window.id === '1/3')
  // (parent outer rectangle: y from -title bar to height + bottom border; the dialog's: 0 to 100)
  const parentCenterY = (-FRAME_TITLE_HEIGHT + 300 + FRAME_BORDER) / 2
  assert.equal(third.x, 250)
  assert.equal(third.y, 50 + Math.round(parentCenterY - 50))
})
