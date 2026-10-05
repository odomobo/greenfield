import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { decodeEnvelope, encodePatch, PatchFormat } from '@gfld/scene-protocol'
import { PatchDecoder } from '../src/patch/patch-decoder.js'

// the real native encoder (built with the compositor proxy): the decoder is tested against what the server sends
const addon = createRequire(import.meta.url)('../../../compositor-proxy/dist/addons/nebula-patch-addon.node') as {
  encodePatch(
    rgba: Uint8Array,
    width: number,
    height: number,
    opaque: boolean,
  ): { format: PatchFormat; channels: 3 | 4; data: Uint8Array }
}

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
    rgba[i] = opaque && i % 4 === 3 ? 255 : next()
  }
  return rgba
}

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

function ui(width: number, height: number, opaque: boolean): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const glyph = (Math.floor(x / 8) * 31 + Math.floor(y / 8) * 17) % 4
      const ink = ((x % 8) * 3 + (y % 8) * 5 + glyph * 7) % 11 < 4
      rgba.set(ink ? [20, 20, 30, opaque ? 255 : 230] : [250, 250, 250, 255], (y * width + x) * 4)
    }
  }
  return rgba
}

const decoder = await PatchDecoder.create()

describe('the wasm patch decoder', () => {
  const contents: [string, PatchFormat, (w: number, h: number, opaque: boolean) => Uint8Array][] = [
    ['noise', PatchFormat.RAW, noise],
    ['small steps', PatchFormat.QOI, walk],
    ['UI content', PatchFormat.QOI_LZ4, ui],
  ]
  for (const [name, format, make] of contents) {
    for (const opaque of [false, true]) {
      it(`${name}, ${opaque ? 'opaque (3 channels)' : 'with alpha (4 channels)'}: ${PatchFormat[format]} round trip is exact`, () => {
        const [width, height] = [100, 60]
        const rgba = make(width, height, opaque)
        const encoded = addon.encodePatch(rgba, width, height, opaque)
        assert.equal(encoded.format, format)
        assert.equal(encoded.channels, opaque ? 3 : 4)
        const decoded = decoder.decode(encoded.format, encoded.channels, width, height, encoded.data)
        assert.deepEqual(new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength), rgba)
      })
    }
  }

  it('decodes patches one after the other (the memory is reused) and tiny or thin patches', () => {
    for (const [width, height] of [
      [1, 1],
      [256, 256],
      [7, 3],
      [256, 1],
    ]) {
      for (const make of [noise, walk, ui]) {
        const rgba = make(width, height, false)
        const encoded = addon.encodePatch(rgba, width, height, false)
        const decoded = decoder.decode(encoded.format, encoded.channels, width, height, encoded.data)
        assert.deepEqual(new Uint8Array(decoded), rgba)
      }
    }
  })

  it('works from a patch that went through the protocol', () => {
    const rgba = ui(64, 64, true)
    const encoded = addon.encodePatch(rgba, 64, 64, true)
    const envelope = encodePatch('s', {
      contentSerial: 1,
      surfaceSize: { width: 64, height: 64 },
      rect: { x: 0, y: 0, width: 64, height: 64 },
      ...encoded,
    })
    const decodedEnvelope = decodeEnvelope(envelope)
    assert.equal(decodedEnvelope.kind, 'patch')
    if (decodedEnvelope.kind === 'patch') {
      const { patch } = decodedEnvelope
      const decoded = decoder.decode(patch.format, patch.channels, patch.rect.width, patch.rect.height, patch.data)
      assert.deepEqual(new Uint8Array(decoded), rgba)
    }
  })

  it('rejects garbage without crashing, and keeps working', () => {
    assert.throws(() => decoder.decode(PatchFormat.QOI, 4, 10, 10, new Uint8Array(50)), /invalid QOI/)
    assert.throws(() => decoder.decode(PatchFormat.QOI_LZ4, 4, 10, 10, new Uint8Array([0xff, 0xff, 0xff, 1, 2])), /invalid/)
    assert.throws(() => decoder.decode(PatchFormat.RAW, 4, 10, 10, new Uint8Array(399)), /wrong size/)
    assert.throws(() => decoder.decode(99 as PatchFormat, 4, 1, 1, new Uint8Array(4)), /Unknown/)
    assert.throws(() => decoder.decode(PatchFormat.RAW, 4, 0, 5, new Uint8Array(0)), /Bad patch size/)
    assert.throws(() => decoder.decode(PatchFormat.RAW, 4, 4096, 4096, new Uint8Array(0)), /Bad patch size/)
    // a valid QOI of other dimensions than the rectangle
    const small = addon.encodePatch(ui(8, 8, false), 8, 8, false)
    assert.throws(() => decoder.decode(small.format, 4, 16, 16, small.data), /invalid|wrong|dimensions/)
    const rgba = ui(32, 32, false)
    const ok = addon.encodePatch(rgba, 32, 32, false)
    assert.deepEqual(new Uint8Array(decoder.decode(ok.format, 4, 32, 32, ok.data)), rgba)
  })
})
