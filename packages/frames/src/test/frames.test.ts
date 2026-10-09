/**
 * The frame library's lifetime rules and its handle, over frames of plain memory made by a test addon
 * (native/test/frames_test_addon.c), so no compositor is needed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Frame } from '../index.js'

type Source = { readonly __source: unique symbol }
type NativeReference = { readonly __reference: unique symbol }
type FrameOptions = {
  width: number
  height: number
  format: number
  contentSerial: number
  pixels: Uint8Array
  stride: number
  opaqueRects?: Int32Array
  access?: boolean
}
type TestAddon = {
  createSource(heldLimitMs: number): Source
  createFrame(source: Source, options: FrameOptions): Frame
  retainFrame(value: unknown): NativeReference | undefined
  releaseNative(reference: NativeReference, onOtherThread: boolean): void
  liveFrames(source: Source): number
  records(): {
    destroyed: { serial: number; onCreatingThread: boolean }[]
    warnings: string[]
    accessBegun: number
    accessEnded: number
  }
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const addon = require('../addons/nebula-frames-test-addon.node') as TestAddon

function fourcc(code: string): number {
  return code.charCodeAt(0) | (code.charCodeAt(1) << 8) | (code.charCodeAt(2) << 16) | (code.charCodeAt(3) << 24)
}
const ARGB8888 = fourcc('AR24')
const XRGB8888 = fourcc('XR24')
const ABGR8888 = fourcc('AB24')

let nextSerial = 1
const source = addon.createSource(10_000)

/** A width x height frame whose pixel at (x, y) is B=x, G=y, R=serial & 255, A=alpha (little endian ARGB8888). */
function frameOf(
  width: number,
  height: number,
  options: Partial<FrameOptions> & { alpha?: number; source?: Source } = {},
) {
  const contentSerial = nextSerial++
  const stride = width * 4 + 8
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.set([x, y, contentSerial & 255, options.alpha ?? 255], y * stride + x * 4)
    }
  }
  const frame = addon.createFrame(options.source ?? source, {
    width,
    height,
    format: ARGB8888,
    contentSerial,
    pixels,
    stride,
    ...options,
  })
  return { frame, contentSerial }
}

function destroyedRecord(serial: number) {
  return addon.records().destroyed.find((record) => record.serial === serial)
}

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 2000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting until ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('a handle describes its frame and reads RGBA pixels', () => {
  const { frame, contentSerial } = frameOf(4, 3, { alpha: 128 })
  assert.equal(frame.width, 4)
  assert.equal(frame.height, 3)
  assert.equal(frame.contentSerial, contentSerial)
  const read = frame.readPixels({ x: 1, y: 1, width: 2, height: 2 })!
  assert.deepEqual(
    [...read.pixels],
    [contentSerial, 1, 1, 128, contentSerial, 1, 2, 128, contentSerial, 2, 1, 128, contentSerial, 2, 2, 128],
  )
  assert.equal(read.opaque, false)
  assert.equal(read.pixels.byteOffset, 0)
  assert.equal(read.pixels.buffer.byteLength, 16, 'a plain ArrayBuffer of its own, transferable')
  frame.release()
})

test('opaque: a format without alpha, an all-255 alpha, or the opaque region', () => {
  const rect = { x: 0, y: 0, width: 2, height: 2 }
  const scanned = frameOf(2, 2, { alpha: 255 })
  assert.equal(scanned.frame.readPixels(rect)!.opaque, true)
  scanned.frame.release()

  const noAlpha = frameOf(2, 2, { alpha: 7, format: XRGB8888 })
  const read = noAlpha.frame.readPixels(rect)!
  assert.equal(read.opaque, true)
  assert.equal(read.pixels[3], 255, 'the alpha is set to 255')
  noAlpha.frame.release()

  // the region as two disjoint rectangles covering the left 3 columns
  const region = frameOf(4, 4, { alpha: 0, opaqueRects: new Int32Array([0, 0, 3, 2, 0, 2, 3, 2]) })
  assert.equal(region.frame.readPixels({ x: 0, y: 1, width: 3, height: 2 })!.opaque, true)
  assert.equal(region.frame.readPixels({ x: 1, y: 0, width: 3, height: 1 })!.opaque, false)
  region.frame.release()

  const abgr = frameOf(1, 1, { format: ABGR8888 })
  assert.deepEqual(
    [...abgr.frame.readPixels({ x: 0, y: 0, width: 1, height: 1 })!.pixels],
    [0, 0, abgr.contentSerial, 255],
  )
  abgr.frame.release()
})

test('readPixels is undefined outside the frame, for an unsupported format, and after release', () => {
  const { frame } = frameOf(4, 4)
  assert.equal(frame.readPixels({ x: 2, y: 2, width: 3, height: 1 }), undefined)
  assert.equal(frame.readPixels({ x: -1, y: 0, width: 1, height: 1 }), undefined)
  assert.equal(frame.readPixels({ x: 0, y: 0, width: 0, height: 1 }), undefined)
  frame.release()
  assert.equal(frame.readPixels({ x: 0, y: 0, width: 1, height: 1 }), undefined)
  frame.release() // a second release does nothing

  const other = frameOf(1, 1, { format: fourcc('NV12') })
  assert.equal(other.frame.readPixels({ x: 0, y: 0, width: 1, height: 1 }), undefined)
  other.frame.release()
})

test("a read goes through the creator's begin and end access", () => {
  const before = addon.records()
  const { frame } = frameOf(2, 2, { access: true })
  frame.readPixels({ x: 0, y: 0, width: 2, height: 2 })
  frame.readPixels({ x: 2, y: 0, width: 1, height: 1 }) // outside: no access
  const after = addon.records()
  assert.equal(after.accessBegun - before.accessBegun, 1)
  assert.equal(after.accessEnded - before.accessEnded, 1)
  frame.release()
})

test('the frame lives until its last reference is released, and is destroyed once', () => {
  const live = addon.liveFrames(source)
  const { frame, contentSerial } = frameOf(2, 2)
  assert.equal(addon.liveFrames(source), live + 1)
  const first = addon.retainFrame(frame)!
  const second = addon.retainFrame(frame)!
  frame.release()
  assert.equal(destroyedRecord(contentSerial), undefined)
  addon.releaseNative(first, false)
  assert.equal(destroyedRecord(contentSerial), undefined)
  addon.releaseNative(second, false)
  assert.deepEqual(destroyedRecord(contentSerial), { serial: contentSerial, onCreatingThread: true })
  assert.equal(addon.records().destroyed.filter((record) => record.serial === contentSerial).length, 1)
  assert.equal(addon.liveFrames(source), live)
})

test('a release on another thread destroys the frame on the creating thread', async () => {
  const { frame, contentSerial } = frameOf(2, 2)
  const reference = addon.retainFrame(frame)!
  frame.release()
  addon.releaseNative(reference, true)
  assert.equal(destroyedRecord(contentSerial), undefined, 'queued to the creating thread, not destroyed on the other')
  await waitUntil(() => destroyedRecord(contentSerial) !== undefined, 'the frame is destroyed')
  assert.deepEqual(destroyedRecord(contentSerial), { serial: contentSerial, onCreatingThread: true })
})

test('native consumers accept only frame handles', () => {
  const { frame } = frameOf(1, 1)
  for (const value of [undefined, null, 1, 'frame', {}, { width: 1, height: 1, contentSerial: 1 }]) {
    assert.equal(addon.retainFrame(value), undefined)
  }
  const reference = addon.retainFrame(frame)
  assert.notEqual(reference, undefined)
  addon.releaseNative(reference!, false)
  frame.release()
  assert.equal(addon.retainFrame(frame), undefined, 'a released handle has no frame')
})

test('a frame held too long is reported once, and is not freed by force', async () => {
  const limitMs = 30
  const shortSource = addon.createSource(limitMs)
  const { frame, contentSerial } = frameOf(3, 2, { source: shortSource })
  const warningsOf = () => addon.records().warnings.filter((warning) => warning.includes(`serial ${contentSerial} `))
  await waitUntil(() => warningsOf().length > 0, 'the warning')
  assert.match(warningsOf()[0], /held for over 30 ms/)
  assert.match(warningsOf()[0], /3x2/)
  // only once, however long it stays held
  await new Promise((resolve) => setTimeout(resolve, limitMs * 3))
  assert.equal(warningsOf().length, 1)
  assert.equal(addon.liveFrames(shortSource), 1)
  assert.notEqual(frame.readPixels({ x: 0, y: 0, width: 1, height: 1 }), undefined, 'still readable')

  frame.release()
  assert.equal(addon.liveFrames(shortSource), 0)
  assert.equal(warningsOf().length, 2)
  assert.match(warningsOf()[1], /released after \d+ ms/)

  // a frame released in time isn't reported
  const quick = frameOf(1, 1, { source: shortSource })
  quick.frame.release()
  await new Promise((resolve) => setTimeout(resolve, limitMs * 3))
  assert.equal(
    addon.records().warnings.filter((warning) => warning.includes(`serial ${quick.contentSerial} `)).length,
    0,
  )
})
