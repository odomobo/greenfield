import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  decodeEnvelope,
  encodePatch,
  isLossyPatchFormat,
  PatchFormat,
  PROTOCOL_VERSION,
  splitJpegAlpha,
} from '@gfld/scene-protocol'

describe('the PATCH envelope', () => {
  for (const format of [PatchFormat.RAW, PatchFormat.QOI, PatchFormat.QOI_LZ4, PatchFormat.JPEG, PatchFormat.JPEG_ALPHA]) {
    for (const channels of [3, 4] as const) {
      it(`round trips format ${PatchFormat[format]} with ${channels} channels`, () => {
        const data = new Uint8Array([1, 2, 3, 4, 5, 250])
        const envelope = encodePatch('1/7', {
          contentSerial: 99,
          surfaceSize: { width: 800, height: 600 },
          rect: { x: 10, y: 20, width: 2, height: 1 },
          format,
          channels,
          data,
        })
        assert.equal(envelope[0], PROTOCOL_VERSION)
        const decoded = decodeEnvelope(envelope)
        assert.equal(decoded.kind, 'patch')
        if (decoded.kind === 'patch') {
          assert.equal(decoded.surface, '1/7')
          assert.deepEqual(decoded.patch.surfaceSize, { width: 800, height: 600 })
          assert.deepEqual(decoded.patch.rect, { x: 10, y: 20, width: 2, height: 1 })
          assert.equal(decoded.patch.contentSerial, 99)
          assert.equal(decoded.patch.format, format)
          assert.equal(decoded.patch.channels, channels)
          assert.deepEqual(decoded.patch.data, data)
        }
      })
    }
  }

  it('has the documented layout: header, then u8 format, u8 channels, then the data', () => {
    const envelope = encodePatch('k', {
      contentSerial: 1,
      surfaceSize: { width: 2, height: 3 },
      rect: { x: 4, y: 5, width: 6, height: 7 },
      format: PatchFormat.QOI_LZ4,
      channels: 3,
      data: new Uint8Array([9, 8]),
    })
    // version, kind, key length (u16), key, 7 u32, format, channels, data
    assert.equal(envelope.length, 2 + 2 + 1 + 28 + 2 + 2)
    assert.equal(envelope[5 + 28], PatchFormat.QOI_LZ4)
    assert.equal(envelope[5 + 29], 3)
    assert.deepEqual([...envelope.subarray(5 + 30)], [9, 8])
  })

  it('format tags are stable (JPEG and JPEG with alpha are reserved after them)', () => {
    assert.deepEqual([PatchFormat.RAW, PatchFormat.QOI, PatchFormat.QOI_LZ4], [0, 1, 2])
  })
})

describe('lossy patch formats', () => {
  it('are JPEG and JPEG with alpha only', () => {
    assert.deepEqual(
      [PatchFormat.RAW, PatchFormat.QOI, PatchFormat.QOI_LZ4, PatchFormat.JPEG, PatchFormat.JPEG_ALPHA].map(
        isLossyPatchFormat,
      ),
      [false, false, false, true, true],
    )
  })

  it("a JPEG with alpha splits into the color JPEG (after its u32le length) and the alpha JPEG", () => {
    const data = new Uint8Array([3, 0, 0, 0, 10, 11, 12, 20, 21])
    const { color, alpha } = splitJpegAlpha(data.subarray(0))
    assert.deepEqual([...color], [10, 11, 12])
    assert.deepEqual([...alpha], [20, 21])
    // also from a view into a larger message
    const message = new Uint8Array([9, 9, ...data])
    assert.deepEqual([...splitJpegAlpha(message.subarray(2)).alpha], [20, 21])
  })

  it('a JPEG with alpha whose lengths do not add up is rejected', () => {
    assert.throws(() => splitJpegAlpha(new Uint8Array([1, 0])))
    assert.throws(() => splitJpegAlpha(new Uint8Array([0, 0, 0, 0, 1])))
    assert.throws(() => splitJpegAlpha(new Uint8Array([5, 0, 0, 0, 1, 2, 3, 4, 5])), 'no alpha JPEG')
  })
})
