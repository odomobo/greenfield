import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SceneSurface, SceneWindow } from '../src/protocol.js'
import { acceptsInput, cursorRect, mapRect, rootWindow, stackChildrenAboveParents } from '../src/windows.js'

function surface(input?: SceneSurface['input']): SceneSurface {
  return { id: 'c/1', x: 0, y: 0, width: 100, height: 80, input }
}

function window(id: string, parent?: string): SceneWindow {
  return {
    id,
    parent,
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
  }
}

describe('acceptsInput', () => {
  it('takes the whole surface without an input region', () => {
    assert.equal(acceptsInput(surface(), 0, 0), true)
    assert.equal(acceptsInput(surface(), 99.5, 79.5), true)
    assert.equal(acceptsInput(surface(), 100, 10), false)
    assert.equal(acceptsInput(surface(), -1, 10), false)
  })

  it('takes nothing with an empty input region', () => {
    assert.equal(acceptsInput(surface([]), 50, 40), false)
  })

  it('skips a shadow margin outside the input region', () => {
    // a 10 pixel shadow around the window
    const shadowed = surface([{ x: 10, y: 10, width: 80, height: 60 }])
    assert.equal(acceptsInput(shadowed, 5, 40), false)
    assert.equal(acceptsInput(shadowed, 10, 10), true)
    assert.equal(acceptsInput(shadowed, 89.9, 69.9), true)
    assert.equal(acceptsInput(shadowed, 90, 40), false)
  })

  it('takes any of several rectangles', () => {
    const region = surface([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 50, y: 50, width: 10, height: 10 },
    ])
    assert.equal(acceptsInput(region, 5, 5), true)
    assert.equal(acceptsInput(region, 55, 55), true)
    assert.equal(acceptsInput(region, 30, 30), false)
  })

  it('never takes input outside the surface, even if the region is larger', () => {
    assert.equal(acceptsInput(surface([{ x: -50, y: -50, width: 500, height: 500 }]), 120, 20), false)
  })
})

describe('stackChildrenAboveParents', () => {
  const ids = (windows: SceneWindow[]) => windows.map((w) => w.id)

  it('keeps the order of unrelated windows', () => {
    assert.deepEqual(ids(stackChildrenAboveParents([window('a'), window('b'), window('c')])), ['a', 'b', 'c'])
  })

  it('puts children directly above their parent, even if the server lists them below it', () => {
    const stacked = stackChildrenAboveParents([window('dialog', 'a'), window('a'), window('b')])
    assert.deepEqual(ids(stacked), ['a', 'dialog', 'b'])
  })

  it('raising the parent raises its children', () => {
    const stacked = stackChildrenAboveParents([window('b'), window('dialog', 'a'), window('a')])
    assert.deepEqual(ids(stacked), ['b', 'a', 'dialog'])
  })

  it('handles nested dialogs and keeps sibling order', () => {
    const stacked = stackChildrenAboveParents([
      window('a'),
      window('second', 'a'),
      window('nested', 'first'),
      window('first', 'a'),
    ])
    assert.deepEqual(ids(stacked), ['a', 'second', 'first', 'nested'])
  })

  it('treats a child of an unknown parent as top level, and survives cycles', () => {
    assert.deepEqual(ids(stackChildrenAboveParents([window('orphan', 'gone'), window('a')])), ['orphan', 'a'])
    assert.deepEqual(ids(stackChildrenAboveParents([window('x', 'y'), window('y', 'x')])).sort(), ['x', 'y'])
  })
})

describe('rootWindow', () => {
  it('walks up to the top level window', () => {
    const windows = [window('a'), window('first', 'a'), window('nested', 'first')]
    assert.equal(rootWindow(windows, windows[2]).id, 'a')
    assert.equal(rootWindow(windows, windows[0]).id, 'a')
  })

  it('stops at a missing parent or a cycle', () => {
    const windows = [window('x', 'y'), window('y', 'x'), window('orphan', 'gone')]
    assert.ok(['x', 'y'].includes(rootWindow(windows, windows[0]).id))
    assert.equal(rootWindow(windows, windows[2]).id, 'orphan')
  })
})

describe('mapRect', () => {
  it('moves and scales a child along with its parent', () => {
    const parent = { x: 100, y: 100, width: 400, height: 300 }
    const dialog = { x: 200, y: 150, width: 200, height: 100 }
    // the parent shrinks to half its size at the top left
    assert.deepEqual(mapRect(dialog, parent, { x: 0, y: 0, width: 200, height: 150 }), {
      x: 50,
      y: 25,
      width: 100,
      height: 50,
    })
    // a pure move
    assert.deepEqual(mapRect(dialog, parent, { x: 110, y: 90, width: 400, height: 300 }), {
      x: 210,
      y: 140,
      width: 200,
      height: 100,
    })
  })
})

describe('cursorRect', () => {
  it('draws the image at its size, or at the logical size when it is larger (HiDPI)', () => {
    const pointer = { x: 100, y: 50 }
    const hotspot = { x: 4, y: 6 }
    const image = { width: 24, height: 24 }
    assert.deepEqual(cursorRect(pointer, hotspot, undefined, image), { x: 96, y: 44, width: 24, height: 24 })
    const larger = { width: 48, height: 48 }
    assert.deepEqual(cursorRect(pointer, hotspot, image, larger), { x: 96, y: 44, width: 24, height: 24 })
    assert.equal(cursorRect(pointer, hotspot, undefined, undefined), undefined)
  })
})
