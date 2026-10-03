import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { encodePng } from '../png.js'

/** Just enough of a PNG decoder (8 bit RGBA, no interlace) to check what the encoder wrote. */
function decodePng(png: Buffer): { width: number; height: number; rgba: Uint8Array } {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let offset = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      assert.equal(data[8], 8)
      assert.equal(data[9], 6)
    } else if (type === 'IDAT') {
      idat.push(data)
    }
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const rgba = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? rgba[y * stride + i - 4] : 0
      const up = y > 0 ? rgba[(y - 1) * stride + i] : 0
      const upLeft = y > 0 && i >= 4 ? rgba[(y - 1) * stride + i - 4] : 0
      let predictor = 0
      if (filter === 1) {
        predictor = left
      } else if (filter === 2) {
        predictor = up
      } else if (filter === 3) {
        predictor = (left + up) >> 1
      } else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      rgba[y * stride + i] = (line[i] + predictor) & 0xff
    }
  }
  return { width, height, rgba }
}

test('encodePng round trips RGBA pixels', async () => {
  const width = 37
  const height = 23
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < rgba.length; i++) {
    // a mix of gradients, flat areas and noise, so every filter type gets picked somewhere
    const pixel = i >> 2
    const x = pixel % width
    const y = Math.floor(pixel / width)
    rgba[i] = y < 8 ? (x * 7 + (i & 3) * 50) & 0xff : y < 16 ? 200 : (pixel * 2654435761) >>> 24
  }
  const png = await encodePng(rgba, width, height)
  const decoded = decodePng(png)
  assert.equal(decoded.width, width)
  assert.equal(decoded.height, height)
  assert.deepEqual(decoded.rgba, rgba)
})

test('encodePng rejects a wrong pixel count', async () => {
  await assert.rejects(encodePng(new Uint8Array(10), 2, 2))
})
