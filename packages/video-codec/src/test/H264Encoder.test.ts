/**
 * The GStreamer encoder with the software encoder (x264, what --dev-software-encoder uses: no GPU needed), over frames
 * of plain memory made by the frame library's test addon (built into its own addon here, so the codec reads frames that
 * another copy of the library created, as it does capture's).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Frame } from '@nebula/session-contracts'
import { H264Encoder } from '../index.js'

type Source = { readonly __source: unique symbol }
type TestFrames = {
  createSource(heldLimitMs: number): Source
  createFrame(
    source: Source,
    options: {
      width: number
      height: number
      format: number
      contentSerial: number
      pixels: Uint8Array
      stride: number
    },
  ): Frame
  liveFrames(source: Source): number
  records(): { destroyed: { serial: number; onCreatingThread: boolean }[] }
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const frames = require('../addons/nebula-video-codec-test-frames.node') as TestFrames
const source = frames.createSource(10_000)

function fourcc(code: string): number {
  return code.charCodeAt(0) | (code.charCodeAt(1) << 8) | (code.charCodeAt(2) << 16) | (code.charCodeAt(3) << 24)
}
const ARGB8888 = fourcc('AR24')

/** A frame of a gradient with a semi-transparent left half (little endian ARGB8888: B, G, R, A in memory). */
function frameOf(width: number, height: number, contentSerial: number): Frame {
  const stride = width * 4 + 16
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.set([(x * 4) & 255, (y * 4) & 255, contentSerial & 255, x < width / 2 ? 128 : 255], y * stride + x * 4)
    }
  }
  return frames.createFrame(source, { width, height, format: ARGB8888, contentSerial, pixels, stride })
}

/** The encoded frame's layout (parseEncodedFrame of @gfld/scene-protocol). */
function parse(blob: Uint8Array) {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  const opaqueLength = view.getUint32(32, true)
  const opaque = blob.subarray(36, 36 + opaqueLength)
  const alphaLength = view.getUint32(36 + opaqueLength, true)
  const alpha = blob.subarray(40 + opaqueLength, 40 + opaqueLength + alphaLength)
  return {
    contentSerial: view.getUint32(8, true),
    width: view.getUint32(16, true),
    height: view.getUint32(20, true),
    codedWidth: view.getUint32(24, true),
    codedHeight: view.getUint32(28, true),
    opaque,
    alpha,
  }
}

/** The NAL unit types of an H.264 byte stream (Annex B). */
function nalTypes(stream: Uint8Array): number[] {
  const types: number[] = []
  for (let i = 0; i + 3 < stream.length; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1) {
      types.push(stream[i + 3] & 0x1f)
      i += 2
    }
  }
  return types
}

/** Keeps Node running until the promise settles: the encoder's callbacks don't (in the session, its sockets do). */
async function alive<T>(promise: Promise<T>): Promise<T> {
  const timer = setInterval(() => undefined, 1000)
  try {
    return await promise
  } finally {
    clearInterval(timer)
  }
}

async function waitUntil(condition: () => boolean, what: string) {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting until ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function released(serial: number) {
  return frames.records().destroyed.find((record) => record.serial === serial)
}

test('encodes frames to H.264 access units, and releases each frame on its creating thread when done', async () => {
  const encoder = new H264Encoder('x264')
  try {
    const first = parse(await alive(encoder.encode(frameOf(100, 60, 101))))
    assert.equal(first.contentSerial, 101)
    assert.deepEqual([first.width, first.height], [100, 60])
    // padded to multiples of 16
    assert.deepEqual([first.codedWidth, first.codedHeight], [112, 64])
    // a key frame (SPS, PPS, IDR) in both the color and the alpha stream
    for (const stream of [first.opaque, first.alpha]) {
      assert.ok(stream.length > 0)
      const types = nalTypes(stream)
      assert.ok(types.includes(7) && types.includes(8) && types.includes(5), `key frame NAL types: ${types}`)
    }
    await waitUntil(() => released(101) !== undefined, 'the frame is released')
    assert.equal(released(101)!.onCreatingThread, true)

    // the next one is a delta frame
    const second = parse(await alive(encoder.encode(frameOf(100, 60, 102))))
    assert.equal(second.contentSerial, 102)
    assert.ok(!nalTypes(second.opaque).includes(5), 'a delta frame')
    await waitUntil(() => frames.liveFrames(source) === 0, 'every frame is released')
  } finally {
    encoder.destroy()
  }
})

test('encode takes the handle over: it is released, also when it is refused', async () => {
  const encoder = new H264Encoder('x264')
  try {
    const frame = frameOf(32, 32, 201)
    const encoded = encoder.encode(frame)
    // the handle no longer has its frame (only the encoder holds it)
    assert.equal(frame.readPixels({ x: 0, y: 0, width: 1, height: 1 }), undefined)
    await alive(encoded)
    // a released handle, and anything else that isn't a frame, is refused
    await assert.rejects(encoder.encode(frame), TypeError)
    await assert.rejects(encoder.encode({ release() {} } as unknown as Frame), TypeError)
    await waitUntil(() => frames.liveFrames(source) === 0, 'every frame is released')
  } finally {
    encoder.destroy()
  }
})
