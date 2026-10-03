import { deflate } from 'node:zlib'

/**
 * Minimal RGBA PNG encoder for patches. Row filtering runs here (cheap, a patch is at most 64k pixels), compression
 * runs on libuv's thread pool.
 */

// fast enough for interactive updates, still compresses UI content well
const DEFLATE_LEVEL = 4

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array, crc = 0xffffffff): number {
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return crc
}

function chunk(type: string, data: Uint8Array): Buffer {
  const chunkBuffer = Buffer.alloc(12 + data.length)
  chunkBuffer.writeUInt32BE(data.length, 0)
  chunkBuffer.write(type, 4, 'latin1')
  chunkBuffer.set(data, 8)
  const crc = crc32(chunkBuffer.subarray(4, 8 + data.length)) ^ 0xffffffff
  chunkBuffer.writeUInt32BE(crc >>> 0, 8 + data.length)
  return chunkBuffer
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) {
    return a
  }
  return pb <= pc ? b : c
}

/**
 * Filter every row with whichever of None/Sub/Up/Paeth gives the smallest sum of absolute (signed) values, the usual
 * PNG heuristic.
 */
export function filterRows(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4
  const out = new Uint8Array((stride + 1) * height)
  const candidates = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)]
  const types = [0, 1, 2, 4]
  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride)
    const previous = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : undefined
    const [none, sub, upFiltered, paethFiltered] = candidates
    const scores = [0, 0, 0, 0]
    const score = (value: number) => (value < 128 ? value : 256 - value)
    for (let i = 0; i < stride; i++) {
      const value = row[i]
      const left = i >= 4 ? row[i - 4] : 0
      const up = previous ? previous[i] : 0
      const upLeft = previous && i >= 4 ? previous[i - 4] : 0
      none[i] = value
      sub[i] = (value - left) & 0xff
      upFiltered[i] = (value - up) & 0xff
      paethFiltered[i] = (value - paeth(left, up, upLeft)) & 0xff
      scores[0] += score(none[i])
      scores[1] += score(sub[i])
      scores[2] += score(upFiltered[i])
      scores[3] += score(paethFiltered[i])
    }
    let best = 0
    for (let f = 1; f < 4; f++) {
      if (scores[f] < scores[best]) {
        best = f
      }
    }
    const offset = y * (stride + 1)
    out[offset] = types[best]
    out.set(candidates[best], offset + 1)
  }
  return out
}

/** Encode tightly packed RGBA pixels (8 bit, rows top to bottom) as a PNG. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Promise<Buffer> {
  if (rgba.length !== width * height * 4) {
    return Promise.reject(new Error(`Expected ${width * height * 4} bytes of RGBA, got ${rgba.length}.`))
  }
  const filtered = filterRows(rgba, width, height)
  return new Promise((resolve, reject) => {
    deflate(filtered, { level: DEFLATE_LEVEL }, (error, compressed) => {
      if (error) {
        reject(error)
        return
      }
      const header = Buffer.alloc(13)
      header.writeUInt32BE(width, 0)
      header.writeUInt32BE(height, 4)
      header[8] = 8 // bit depth
      header[9] = 6 // color type RGBA
      header[10] = 0 // deflate
      header[11] = 0 // adaptive filtering
      header[12] = 0 // no interlace
      resolve(
        Buffer.concat([
          PNG_SIGNATURE,
          chunk('IHDR', header),
          chunk('IDAT', compressed),
          chunk('IEND', new Uint8Array(0)),
        ]),
      )
    })
  })
}
