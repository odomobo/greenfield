import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  arrowOf,
  edgesAfterArrow,
  EDGE_BOTTOM,
  EDGE_LEFT,
  EDGE_RIGHT,
  EDGE_TOP,
  nearestEdges,
  resizeCursor,
} from '../src/window-menu.js'

const rect = { x: 100, y: 100, width: 300, height: 300 }

describe('nearestEdges', () => {
  it('picks a corner in a corner third', () => {
    assert.equal(nearestEdges(rect, { x: 110, y: 110 }), EDGE_LEFT | EDGE_TOP)
    assert.equal(nearestEdges(rect, { x: 390, y: 390 }), EDGE_RIGHT | EDGE_BOTTOM)
    assert.equal(nearestEdges(rect, { x: 390, y: 110 }), EDGE_RIGHT | EDGE_TOP)
  })

  it('picks a side in a side third, also from outside the window', () => {
    assert.equal(nearestEdges(rect, { x: 250, y: 395 }), EDGE_BOTTOM)
    assert.equal(nearestEdges(rect, { x: 250, y: 20 }), EDGE_TOP)
    assert.equal(nearestEdges(rect, { x: 50, y: 250 }), EDGE_LEFT)
  })

  it('picks the nearest edge from the middle', () => {
    assert.equal(nearestEdges(rect, { x: 250, y: 250 }), EDGE_LEFT)
    assert.equal(nearestEdges({ ...rect, width: 290 }, { x: 250, y: 250 }), EDGE_RIGHT)
  })
})

describe('arrow keys in Size', () => {
  it('knows the arrows', () => {
    assert.deepEqual(arrowOf('ArrowLeft'), { x: -1, y: 0 })
    assert.deepEqual(arrowOf('ArrowDown'), { x: 0, y: 1 })
    assert.equal(arrowOf('a'), undefined)
  })

  it('the first arrow picks its side, a perpendicular one adds a side, the same axis keeps it', () => {
    const left = arrowOf('ArrowLeft')!
    const down = arrowOf('ArrowDown')!
    const right = arrowOf('ArrowRight')!
    // the pointer had chosen the right edge
    let edges = edgesAfterArrow(EDGE_RIGHT, false, left)
    assert.equal(edges, EDGE_LEFT)
    edges = edgesAfterArrow(edges, true, down)
    assert.equal(edges, EDGE_LEFT | EDGE_BOTTOM)
    assert.equal(edgesAfterArrow(edges, true, right), EDGE_LEFT | EDGE_BOTTOM)
  })
})

describe('resizeCursor', () => {
  it('is the resize cursor of the edges', () => {
    assert.equal(resizeCursor(EDGE_LEFT), 'w-resize')
    assert.equal(resizeCursor(EDGE_BOTTOM), 's-resize')
    assert.equal(resizeCursor(EDGE_TOP | EDGE_RIGHT), 'ne-resize')
    assert.equal(resizeCursor(EDGE_BOTTOM | EDGE_LEFT), 'sw-resize')
  })
})
