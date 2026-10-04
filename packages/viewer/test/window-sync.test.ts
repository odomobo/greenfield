import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SceneWindow } from '../src/protocol.js'
import { WindowSync } from '../src/window-sync.js'

function window(id: string, state: Partial<SceneWindow> = {}): SceneWindow {
  return {
    id,
    title: id,
    appId: 'app',
    activated: false,
    maximized: false,
    fullscreen: false,
    minimized: false,
    placed: true,
    seq: 0,
    x: 0,
    y: 0,
    geometry: { x: 0, y: 0, width: 10, height: 10 },
    surfaces: [],
    ...state,
  }
}

const notHeld = () => false

describe('WindowSync', () => {
  it('numbers changes per window, continuing from what the server applied', () => {
    const sync = new WindowSync()
    assert.equal(sync.nextSeq('a'), 1)
    assert.equal(sync.nextSeq('a'), 2)
    assert.equal(sync.nextSeq('b'), 1)
    // a new viewer (reconnect, takeover): the server applied 7 changes from the previous one
    const fresh = new WindowSync()
    fresh.sceneReceived([window('a', { seq: 7 })], notHeld)
    assert.equal(fresh.pending('a'), false)
    assert.equal(fresh.nextSeq('a'), 8)
  })

  it('ignores a late scene that reflects an older move', () => {
    const sync = new WindowSync()
    sync.setPosition('a', { x: 100, y: 100 })
    assert.equal(sync.nextSeq('a'), 1)
    sync.setPosition('a', { x: 200, y: 200 })
    assert.equal(sync.nextSeq('a'), 2)
    // the server applied the first move only
    sync.sceneReceived([window('a', { seq: 1, x: 100, y: 100 })], notHeld)
    assert.equal(sync.pending('a'), true)
    assert.deepEqual(sync.position('a'), { x: 200, y: 200 })
    // and then the second
    sync.sceneReceived([window('a', { seq: 2, x: 200, y: 200 })], notHeld)
    assert.equal(sync.pending('a'), false)
    assert.equal(sync.position('a'), undefined)
  })

  it('shows the server’s correction once it caught up, even where the viewer asked for something else', () => {
    const sync = new WindowSync()
    sync.setPosition('a', { x: -500, y: 10 })
    sync.nextSeq('a')
    sync.setMinimized('a', true)
    sync.nextSeq('a')
    // the server clamped the position and refused to minimize
    sync.sceneReceived([window('a', { seq: 2, x: 0, y: 10, minimized: false })], notHeld)
    assert.equal(sync.position('a'), undefined)
    assert.equal(sync.minimized('a'), undefined)
  })

  it('keeps the position of a window being dragged, even when the server caught up', () => {
    const sync = new WindowSync()
    sync.setPosition('a', { x: 10, y: 10 })
    sync.nextSeq('a')
    // the pointer moved on, not sent yet
    sync.setPosition('a', { x: 30, y: 30 })
    sync.sceneReceived([window('a', { seq: 1, x: 10, y: 10 })], (id) => id === 'a')
    assert.deepEqual(sync.position('a'), { x: 30, y: 30 })
    // the drag ended with a last move, which the server applies
    sync.nextSeq('a')
    sync.sceneReceived([window('a', { seq: 2, x: 30, y: 30 })], notHeld)
    assert.equal(sync.position('a'), undefined)
  })

  it('lets server-initiated changes through when nothing is pending for the window', () => {
    const sync = new WindowSync()
    sync.setPosition('a', { x: 10, y: 10 })
    sync.nextSeq('a')
    // window b moves on its own (e.g. a dialog following its parent): the viewer has no state for it
    sync.sceneReceived([window('a', { seq: 0 }), window('b', { seq: 0, x: 50, y: 50 })], notHeld)
    assert.equal(sync.pending('b'), false)
    assert.equal(sync.position('b'), undefined)
    // a is still pending: its server state is ignored
    assert.deepEqual(sync.position('a'), { x: 10, y: 10 })
  })

  it('forgets windows that are gone', () => {
    const sync = new WindowSync()
    sync.setPosition('a', { x: 10, y: 10 })
    sync.nextSeq('a')
    sync.sceneReceived([], notHeld)
    assert.equal(sync.pending('a'), false)
    assert.equal(sync.position('a'), undefined)
    assert.equal(sync.nextSeq('a'), 1)
  })

})
