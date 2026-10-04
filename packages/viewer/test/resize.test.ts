import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clampSize, resizedRect } from '../src/resize.js'
import { EDGE_BOTTOM, EDGE_LEFT, EDGE_RIGHT, EDGE_TOP } from '../src/window-menu.js'

const start = { x: 100, y: 100, width: 300, height: 200 }

describe('clampSize', () => {
  it('treats 0 and undefined as unbounded', () => {
    assert.equal(clampSize(50), 50)
    assert.equal(clampSize(50, 0, 0), 50)
    assert.equal(clampSize(5000, 0, 0), 5000)
  })
  it('clamps to min and max, never below 1', () => {
    assert.equal(clampSize(10, 80, 0), 80)
    assert.equal(clampSize(900, 80, 500), 500)
    assert.equal(clampSize(-20), 1)
    assert.equal(clampSize(50, 80, 60), 80)
  })
})

describe('resizedRect', () => {
  it('moves the right and bottom edges, keeping the left and top', () => {
    assert.deepEqual(resizedRect(start, EDGE_RIGHT | EDGE_BOTTOM, 20, -30), { x: 100, y: 100, width: 320, height: 170 })
  })
  it('moves the left and top edges, keeping the right and bottom', () => {
    assert.deepEqual(resizedRect(start, EDGE_LEFT | EDGE_TOP, 50, 20), { x: 150, y: 120, width: 250, height: 180 })
    assert.deepEqual(resizedRect(start, EDGE_LEFT, -40, 999), { x: 60, y: 100, width: 340, height: 200 })
  })
  it('leaves the other axis alone', () => {
    assert.deepEqual(resizedRect(start, EDGE_RIGHT, 10, 99), { x: 100, y: 100, width: 310, height: 200 })
    assert.deepEqual(resizedRect(start, EDGE_TOP, 99, 10), { x: 100, y: 110, width: 300, height: 190 })
  })
  it('stops at the minimum size with the fixed edge in place', () => {
    const limits = { minWidth: 120, minHeight: 90 }
    assert.deepEqual(resizedRect(start, EDGE_LEFT | EDGE_TOP, 1000, 1000, limits), {
      x: 280,
      y: 210,
      width: 120,
      height: 90,
    })
    assert.deepEqual(resizedRect(start, EDGE_RIGHT | EDGE_BOTTOM, -1000, -1000, limits), {
      x: 100,
      y: 100,
      width: 120,
      height: 90,
    })
  })
  it('stops at the maximum size with the fixed edge in place', () => {
    const limits = { maxWidth: 350, maxHeight: 250 }
    assert.deepEqual(resizedRect(start, EDGE_LEFT | EDGE_TOP, -1000, -1000, limits), {
      x: 50,
      y: 50,
      width: 350,
      height: 250,
    })
    assert.deepEqual(resizedRect(start, EDGE_RIGHT, 1000, 0, limits), { x: 100, y: 100, width: 350, height: 200 })
  })
  it('never collapses below one pixel', () => {
    assert.deepEqual(resizedRect(start, EDGE_RIGHT | EDGE_BOTTOM, -1000, -1000), { x: 100, y: 100, width: 1, height: 1 })
  })
})
