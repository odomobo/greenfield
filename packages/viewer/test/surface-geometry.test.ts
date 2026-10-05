import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isWholePixelScale, snapToDevicePixel, videoSourceRect } from '../src/surface-geometry.js'

describe('videoSourceRect', () => {
  it('is the whole frame when nothing was padded', () => {
    assert.deepEqual(videoSourceRect({ width: 64, height: 32 }, { width: 64, height: 32 }), {
      x: 0,
      y: 0,
      width: 64,
      height: 32,
    })
  })
  it('is the bottom right corner of the encoded area when the encoder padded it', () => {
    assert.deepEqual(videoSourceRect({ width: 40, height: 30 }, { width: 48, height: 32 }), {
      x: 8,
      y: 2,
      width: 40,
      height: 30,
    })
  })
})

describe('isWholePixelScale', () => {
  const image = { width: 100, height: 50 }
  it('is true for an unstretched image on whole device pixels, at any ratio', () => {
    assert.equal(isWholePixelScale({ x: 10, y: 20, width: 100, height: 50 }, image, 1), true)
    assert.equal(isWholePixelScale({ x: 10, y: 20, width: 50, height: 25 }, image, 2), true)
  })
  it('is true when each image pixel covers a whole number of device pixels', () => {
    assert.equal(isWholePixelScale({ x: 0, y: 0, width: 100, height: 50 }, image, 2), true)
  })
  it('is false when stretched by a fraction or shrunk', () => {
    assert.equal(isWholePixelScale({ x: 0, y: 0, width: 150, height: 50 }, image, 1), false)
    assert.equal(isWholePixelScale({ x: 0, y: 0, width: 50, height: 25 }, image, 1), false)
  })
  it('is false when it starts between device pixels', () => {
    assert.equal(isWholePixelScale({ x: 0.5, y: 0, width: 100, height: 50 }, image, 1), false)
    assert.equal(isWholePixelScale({ x: 1, y: 0, width: 100, height: 50 }, image, 1.5), false)
  })
  it('is false without an image', () => {
    assert.equal(isWholePixelScale({ x: 0, y: 0, width: 100, height: 50 }, { width: 0, height: 0 }, 1), false)
  })
})

describe('snapToDevicePixel', () => {
  it('rounds to whole device pixels', () => {
    assert.equal(snapToDevicePixel(42, 1.5), 42)
    assert.ok(Math.abs(snapToDevicePixel(41.3, 1.5) - 124 / 3) < 1e-9)
    assert.equal(snapToDevicePixel(10.4, 1), 10)
    assert.equal(snapToDevicePixel(10.3, 2), 10.5)
  })
})
