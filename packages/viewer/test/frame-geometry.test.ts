import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FRAME_BORDER, FRAME_TITLE_HEIGHT, frameInsets } from '../src/protocol.js'
import { frameBox, keepOnScreen, outerRect } from '../src/frame-geometry.js'

const T = FRAME_TITLE_HEIGHT
const B = FRAME_BORDER

test('frame insets: a title bar and borders; the title bar alone when maximized; nothing when fullscreen or undecorated', () => {
  assert.deepEqual(frameInsets({ decorated: true }), { top: T, left: B, right: B, bottom: B })
  assert.deepEqual(frameInsets({ decorated: true, maximized: true }), { top: T, left: 0, right: 0, bottom: 0 })
  assert.deepEqual(frameInsets({ decorated: true, fullscreen: true }), { top: 0, left: 0, right: 0, bottom: 0 })
  assert.deepEqual(frameInsets({}), { top: 0, left: 0, right: 0, bottom: 0 })
})

test('the outer rectangle adds the frame around the geometry', () => {
  assert.deepEqual(outerRect({ x: 10, y: 50, width: 200, height: 100 }, frameInsets({ decorated: true })), {
    x: 10 - B,
    y: 50 - T,
    width: 200 + 2 * B,
    height: 100 + T + B,
  })
})

test('keeping a window on screen: the title bar never goes above the output, 80 px of the outer rectangle stay in', () => {
  const insets = frameInsets({ decorated: true })
  const geometry = { x: 0, y: 0, width: 300, height: 200 }
  const output = { width: 1000, height: 600 }
  // the geometry's top may be T below the output's top, not less: the frame's top edge is the limit
  assert.deepEqual(keepOnScreen(geometry, insets, { x: 50, y: 0 }, output, 80), { x: 50, y: T })
  assert.deepEqual(keepOnScreen(geometry, insets, { x: 50, y: T }, output, 80), { x: 50, y: T })
  // far down and right: 80 px of the outer rectangle stay inside
  assert.deepEqual(keepOnScreen(geometry, insets, { x: 5000, y: 5000 }, output, 80), {
    x: 1000 - 80 + B,
    y: 600 - 80 + T,
  })
  // an undecorated window keeps the old rule
  assert.deepEqual(keepOnScreen(geometry, frameInsets({}), { x: 50, y: -20 }, output, 80), { x: 50, y: 0 })
})

test('the frame keeps its real size while the content is stretched, and stretches with it when asked', () => {
  const insets = frameInsets({ decorated: true })
  const geometry = { x: 0, y: 0, width: 400, height: 300 }
  const plain = { left: -B, top: -T, width: 400 + 2 * B, height: 300 + T + B, transform: '' }
  assert.deepEqual(frameBox(geometry, insets, 1, 1, false), plain)
  const stretched = frameBox(geometry, insets, 1.5, 2, false)
  // real size: the shown geometry (600 x 600) plus the frame, undone from the window's scale
  assert.equal(stretched.width, 600 + 2 * B)
  assert.equal(stretched.height, 600 + T + B)
  assert.equal(stretched.transform, `scale(${1 / 1.5}, ${1 / 2}) translate(${-B}px, ${-T}px)`)
  // minimizing: the frame is part of the image that shrinks
  assert.deepEqual(frameBox(geometry, insets, 0.5, 0.5, true), plain)
})
