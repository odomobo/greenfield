import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PatchFormat } from '@gfld/scene-protocol'
import { encodePatch, type EncodedPatch } from '../patch-encoder.js'

// --- reference decoders (independent of the native code: plain JS ports of the QOI spec and the LZ4 block format) ---

function qoiDecode(bytes: Uint8Array): { width: number; height: number; channels: number; rgba: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(view.getUint32(0), 0x716f6966, 'QOI magic')
  const width = view.getUint32(4)
  const height = view.getUint32(8)
  const channels = bytes[12]
  const rgba = new Uint8Array(width * height * 4)
  const index = new Uint8Array(64 * 4)
  let r = 0
  let g = 0
  let b = 0
  let a = 255
  let run = 0
  let p = 14
  const end = bytes.length - 8
  for (let i = 0; i < rgba.length; i += 4) {
    if (run > 0) {
      run--
    } else if (p < end) {
      const b1 = bytes[p++]
      if (b1 === 0xfe) {
        r = bytes[p++]
        g = bytes[p++]
        b = bytes[p++]
      } else if (b1 === 0xff) {
        r = bytes[p++]
        g = bytes[p++]
        b = bytes[p++]
        a = bytes[p++]
      } else if ((b1 & 0xc0) === 0x00) {
        const k = b1 * 4
        r = index[k]
        g = index[k + 1]
        b = index[k + 2]
        a = index[k + 3]
      } else if ((b1 & 0xc0) === 0x40) {
        r = (r + ((b1 >> 4) & 3) - 2) & 255
        g = (g + ((b1 >> 2) & 3) - 2) & 255
        b = (b + (b1 & 3) - 2) & 255
      } else if ((b1 & 0xc0) === 0x80) {
        const b2 = bytes[p++]
        const vg = (b1 & 0x3f) - 32
        r = (r + vg - 8 + ((b2 >> 4) & 15)) & 255
        g = (g + vg) & 255
        b = (b + vg - 8 + (b2 & 15)) & 255
      } else {
        run = b1 & 0x3f
      }
      const k = ((r * 3 + g * 5 + b * 7 + a * 11) & 63) * 4
      index[k] = r
      index[k + 1] = g
      index[k + 2] = b
      index[k + 3] = a
    }
    rgba[i] = r
    rgba[i + 1] = g
    rgba[i + 2] = b
    rgba[i + 3] = a
  }
  return { width, height, channels, rgba }
}

function lz4Block(source: Uint8Array, capacity: number): Uint8Array {
  const out = new Uint8Array(capacity)
  let s = 0
  let d = 0
  while (s < source.length) {
    const token = source[s++]
    let literals = token >> 4
    if (literals === 15) {
      let more
      do {
        more = source[s++]
        literals += more
      } while (more === 255)
    }
    out.set(source.subarray(s, s + literals), d)
    s += literals
    d += literals
    if (s >= source.length) {
      break
    }
    const offset = source[s] | (source[s + 1] << 8)
    s += 2
    let length = token & 15
    if (length === 15) {
      let more
      do {
        more = source[s++]
        length += more
      } while (more === 255)
    }
    length += 4
    for (let i = 0; i < length; i++, d++) {
      out[d] = out[d - offset]
    }
  }
  return out.subarray(0, d)
}

/** The RGBA pixels an encoded patch stands for (3 channel patches are opaque). */
function decode(encoded: EncodedPatch, width: number, height: number): Uint8Array {
  const { format, channels, data } = encoded
  if (format === PatchFormat.RAW) {
    assert.equal(data.length, width * height * channels)
    const rgba = new Uint8Array(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      rgba.set(data.subarray(i * channels, i * channels + 3), i * 4)
      rgba[i * 4 + 3] = channels === 4 ? data[i * 4 + 3] : 255
    }
    return rgba
  }
  const qoi = format === PatchFormat.QOI_LZ4 ? lz4Block(data, width * height * 5 + 64) : data
  const image = qoiDecode(qoi)
  assert.equal(image.width, width)
  assert.equal(image.height, height)
  assert.equal(image.channels, channels)
  return image.rgba
}

// --- test content ---

function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state >>> 24
  }
}

function noise(width: number, height: number, opaque: boolean): Uint8Array {
  const next = random(1)
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < rgba.length; i++) {
    rgba[i] = next()
  }
  if (opaque) {
    for (let i = 3; i < rgba.length; i += 4) {
      rgba[i] = 255
    }
  }
  return rgba
}

/** a random walk with small steps: QOI codes every pixel in one byte of (random) differences, LZ4 can't shrink that */
function walk(width: number, height: number, opaque: boolean): Uint8Array {
  const next = random(2)
  const rgba = new Uint8Array(width * height * 4)
  let [r, g, b] = [128, 128, 128]
  for (let i = 0; i < rgba.length; i += 4) {
    r = (r + (next() % 4) - 2) & 255
    g = (g + (next() % 4) - 2) & 255
    b = (b + (next() % 4) - 2) & 255
    rgba.set([r, g, b, opaque ? 255 : 200], i)
  }
  return rgba
}

/** text-like: a few repeating glyph blocks on a flat background, with translucent shadows if not opaque */
function ui(width: number, height: number, opaque: boolean): Uint8Array {
  const next = random(3)
  const rgba = new Uint8Array(width * height * 4)
  const glyphs = [0, 1, 2, 3].map((n) => (x: number, y: number) => ((x * 3 + y * 5 + n * 7) % 11 < 4 ? 1 : 0))
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const glyph = glyphs[(Math.floor(x / 8) * 31 + Math.floor(y / 8) * 17 + (next() & 0)) % 4]
      const ink = glyph(x % 8, y % 8)
      rgba.set(ink ? [20, 20, 30, opaque ? 255 : 230] : [250, 250, 250, 255], (y * width + x) * 4)
    }
  }
  return rgba
}

/** Mostly differences of the luma kind (2 bytes) with some random pixels (4 bytes): QOI lands at about 92% of the RGB size. */
function almostNoise(width: number, height: number): Uint8Array {
  const next = random(4)
  const rgba = new Uint8Array(width * height * 4)
  let [r, g, b] = [100, 100, 100]
  for (let i = 0; i < rgba.length; i += 4) {
    if (next() < 97) {
      r = next()
      g = next()
      b = next()
    } else {
      const dg = (next() % 32) - 16
      g = (g + dg) & 255
      r = (r + dg + (next() % 16) - 8) & 255
      b = (b + dg + (next() % 16) - 8) & 255
    }
    rgba.set([r, g, b, 255], i)
  }
  return rgba
}

function expected(rgba: Uint8Array, opaque: boolean): Uint8Array {
  if (!opaque) {
    return rgba
  }
  const copy = new Uint8Array(rgba)
  for (let i = 3; i < copy.length; i += 4) {
    copy[i] = 255
  }
  return copy
}

function check(rgba: Uint8Array, width: number, height: number, opaque: boolean): EncodedPatch {
  const encoded = encodePatch(rgba, width, height, opaque)
  assert.equal(encoded.channels, opaque ? 3 : 4)
  assert.deepEqual(decode(encoded, width, height), expected(rgba, opaque), 'the pixels round trip exactly')
  return encoded
}

test('noise is sent raw: RGBA, or RGB if opaque', () => {
  for (const opaque of [false, true]) {
    const rgba = noise(64, 64, opaque)
    const encoded = check(rgba, 64, 64, opaque)
    assert.equal(encoded.format, PatchFormat.RAW)
    assert.equal(encoded.data.length, 64 * 64 * (opaque ? 3 : 4))
  }
})

test('a patch that QOI shrinks to 90% of the raw size or more is sent as the plain QOI, LZ4 is not tried', () => {
  const rgba = almostNoise(128, 64)
  const encoded = check(rgba, 128, 64, true)
  assert.equal(encoded.format, PatchFormat.QOI)
  const raw = 128 * 64 * 3
  assert.ok(encoded.data.length >= raw * 0.9 && encoded.data.length <= raw, `${encoded.data.length} of ${raw}`)
})

test('plain QOI when LZ4 does not make it smaller', () => {
  for (const opaque of [false, true]) {
    const encoded = check(walk(128, 64, opaque), 128, 64, opaque)
    assert.equal(encoded.format, PatchFormat.QOI)
    assert.ok(encoded.data.length < 128 * 64 * encoded.channels * 0.9)
  }
})

test('UI-like content is QOI + LZ4, much smaller than the raw pixels', () => {
  for (const opaque of [false, true]) {
    const encoded = check(ui(128, 64, opaque), 128, 64, opaque)
    assert.equal(encoded.format, PatchFormat.QOI_LZ4)
    assert.ok(encoded.data.length < 128 * 64 * encoded.channels * 0.3, `${encoded.data.length}`)
  }
})

test('a flat patch, and patches of one pixel or one row, round trip', () => {
  for (const opaque of [false, true]) {
    for (const [width, height] of [
      [1, 1],
      [1, 40],
      [200, 1],
      [256, 256],
    ]) {
      const rgba = new Uint8Array(width * height * 4).fill(77)
      check(rgba, width, height, opaque)
      check(noise(width, height, opaque), width, height, opaque)
    }
  }
})

test('transparent pixels keep their alpha when the patch is not opaque', () => {
  const rgba = new Uint8Array(32 * 32 * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba.set([i & 255, 10, 200, (i >> 2) & 255], i)
  }
  check(rgba, 32, 32, false)
})

test('wrong sizes throw', () => {
  assert.throws(() => encodePatch(new Uint8Array(15), 2, 2, false), /don't match/)
  assert.throws(() => encodePatch(new Uint8Array(0), 0, 0, false), /don't match/)
})

// --- lossy patches: JPEG when it is smaller ---

/** The frame header of a baseline JPEG: its size and its components' sampling factors (h << 4 | v). */
function jpegFrame(bytes: Uint8Array): { width: number; height: number; sampling: number[] } {
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8], 'starts with SOI')
  assert.deepEqual([bytes[bytes.length - 2], bytes[bytes.length - 1]], [0xff, 0xd9], 'ends with EOI')
  let p = 2
  while (p + 4 <= bytes.length) {
    assert.equal(bytes[p], 0xff, 'a marker')
    const marker = bytes[p + 1]
    const length = (bytes[p + 2] << 8) | bytes[p + 3]
    if (marker === 0xc0) {
      const height = (bytes[p + 5] << 8) | bytes[p + 6]
      const width = (bytes[p + 7] << 8) | bytes[p + 8]
      const components = bytes[p + 9]
      const sampling = []
      for (let c = 0; c < components; c++) {
        sampling.push(bytes[p + 10 + c * 3 + 1])
      }
      return { width, height, sampling }
    }
    p += 2 + length
  }
  assert.fail('no baseline frame header (SOF0)')
}

test('lossy: noise goes out as a 4:4:4 JPEG, much smaller than lossless', () => {
  const rgba = noise(64, 48, true)
  const lossless = encodePatch(rgba, 64, 48, true)
  const encoded = encodePatch(rgba, 64, 48, true, true)
  assert.equal(encoded.format, PatchFormat.JPEG)
  assert.equal(encoded.channels, 3)
  assert.ok(encoded.data.length < lossless.data.length / 2, `${encoded.data.length} of ${lossless.data.length}`)
  assert.deepEqual(jpegFrame(encoded.data), { width: 64, height: 48, sampling: [0x11, 0x11, 0x11] })
})

test('lossy with alpha: the color JPEG and a grayscale JPEG of the alpha, after the color JPEG\'s length', () => {
  const rgba = noise(40, 30, false)
  const encoded = encodePatch(rgba, 40, 30, false, true)
  assert.equal(encoded.format, PatchFormat.JPEG_ALPHA)
  assert.equal(encoded.channels, 4)
  const data = encoded.data
  const colorLength = new DataView(data.buffer, data.byteOffset).getUint32(0, true)
  const color = data.subarray(4, 4 + colorLength)
  const alpha = data.subarray(4 + colorLength)
  assert.deepEqual(jpegFrame(color), { width: 40, height: 30, sampling: [0x11, 0x11, 0x11] })
  assert.deepEqual(jpegFrame(alpha), { width: 40, height: 30, sampling: [0x11] })
})

test('lossy: UI-like content stays lossless when that is smaller, and round trips exactly', () => {
  for (const opaque of [false, true]) {
    const rgba = ui(128, 64, opaque)
    const encoded = encodePatch(rgba, 128, 64, opaque, true)
    assert.equal(encoded.format, PatchFormat.QOI_LZ4)
    assert.deepEqual(decode(encoded, 128, 64), expected(rgba, opaque))
  }
})

test('lossy: patches of one pixel or one row are encoded too', () => {
  for (const opaque of [false, true]) {
    for (const [width, height] of [
      [1, 1],
      [1, 40],
      [200, 1],
    ]) {
      const encoded = encodePatch(noise(width, height, opaque), width, height, opaque, true)
      assert.ok(encoded.data.length > 0)
    }
  }
})
