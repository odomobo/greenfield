import { test } from 'node:test'
import assert from 'node:assert/strict'
import { area, disjoint, Rect, splitRect, subtract, subtractRect } from '../region.js'

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

test('subtractRect leaves the uncovered parts', () => {
  assert.deepEqual(subtractRect(r(0, 0, 10, 10), r(20, 20, 5, 5)), [r(0, 0, 10, 10)])
  assert.deepEqual(subtractRect(r(0, 0, 10, 10), r(-5, -5, 30, 30)), [])
  const pieces = subtractRect(r(0, 0, 10, 10), r(2, 3, 4, 5))
  assert.equal(area(pieces), 100 - 20)
  assert.equal(area(subtract(pieces, [r(2, 3, 4, 5)])), 80, 'pieces are outside the cut')
})

test('disjoint and area count overlaps once', () => {
  const region = [r(0, 0, 10, 10), r(5, 5, 10, 10), r(0, 0, 10, 10)]
  assert.equal(area(region), 100 + 100 - 25)
  const pieces = disjoint(region)
  assert.equal(
    pieces.reduce((sum, rect) => sum + rect.width * rect.height, 0),
    175,
  )
})

test('splitRect makes pieces of at most maxPixels covering the rectangle', () => {
  const rect = r(3, 7, 1920, 1080)
  const pieces = splitRect(rect, 65536)
  assert.ok(pieces.every((piece) => piece.width * piece.height <= 65536))
  assert.equal(area(pieces), 1920 * 1080)
  assert.equal(
    pieces.reduce((sum, piece) => sum + piece.width * piece.height, 0),
    1920 * 1080,
    'no overlaps',
  )
  assert.deepEqual(splitRect(r(0, 0, 100, 100), 65536), [r(0, 0, 100, 100)])
  assert.deepEqual(splitRect(r(0, 0, 0, 100), 65536), [])
  // wider than maxPixels: columns too
  const wide = splitRect(r(0, 0, 100, 3), 40)
  assert.ok(wide.every((piece) => piece.width * piece.height <= 40))
  assert.equal(area(wide), 300)
})
