import { test } from 'node:test'
import assert from 'node:assert/strict'
import { area, disjoint, Rect, splitRect, splitTiles, subtract, subtractRect } from '../region.js'

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

test('splitTiles makes squarish tiles of at most maxPixels, edges on multiples of 16, covering the rectangle', () => {
  const covers = (rect: Rect, pieces: Rect[], maxPixels: number) => {
    assert.ok(
      pieces.every((piece) => piece.width > 0 && piece.height > 0 && piece.width * piece.height <= maxPixels),
      JSON.stringify(pieces),
    )
    assert.equal(area(pieces), rect.width * rect.height)
    assert.equal(
      pieces.reduce((sum, piece) => sum + piece.width * piece.height, 0),
      rect.width * rect.height,
      'no overlaps',
    )
  }
  // a 1200 x 660 window: 5 x 3 tiles of about 240 x 220
  const window = splitTiles(r(0, 0, 1200, 660), 65536)
  covers(r(0, 0, 1200, 660), window, 65536)
  assert.equal(window.length, 15)
  assert.ok(window.every((tile) => tile.width >= 224 && tile.width <= 256 && tile.height >= 208 && tile.height <= 240))
  // inner edges on the grid, also for a rectangle that isn't
  const odd = r(3, 7, 1917, 1081)
  const tiles = splitTiles(odd, 65536)
  covers(odd, tiles, 65536)
  for (const tile of tiles) {
    assert.ok(tile.x === odd.x || tile.x % 16 === 0)
    assert.ok(tile.y === odd.y || tile.y % 16 === 0)
    assert.ok(tile.width / tile.height < 2 && tile.height / tile.width < 2, 'squarish')
  }
  // thin: as tall as the rectangle, as wide as fits
  const thin = splitTiles(r(0, 0, 2000, 40), 65536)
  covers(r(0, 0, 2000, 40), thin, 65536)
  assert.equal(thin.length, 2)
  const narrow = splitTiles(r(0, 0, 30, 2500), 65536)
  covers(r(0, 0, 30, 2500), narrow, 65536)
  assert.equal(narrow.length, 2)
  // small enough: one piece; tiny maxPixels: no grid
  assert.deepEqual(splitTiles(r(0, 0, 100, 100), 65536), [r(0, 0, 100, 100)])
  covers(r(0, 0, 100, 3), splitTiles(r(0, 0, 100, 3), 40), 40)
  covers(r(5, 5, 37, 91), splitTiles(r(5, 5, 37, 91), 50), 50)
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
