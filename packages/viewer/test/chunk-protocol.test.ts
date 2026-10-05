import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ChunkAssembler,
  decodeChunk,
  encodeChunk,
  isChunkEnvelope,
  isDataEnvelope,
  PROTOCOL_VERSION,
} from '@gfld/scene-protocol'

/** An envelope of `length` bytes with recognizable content. */
const envelopeOf = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 7 + 3) & 0xff)

/** Cut an envelope into chunks of `size` bytes, as the server does. */
const cut = (id: number, envelope: Uint8Array, size: number) => {
  const chunks: Uint8Array[] = []
  for (let start = 0; start < envelope.byteLength; start += size) {
    chunks.push(encodeChunk(id, envelope, start, Math.min(envelope.byteLength, start + size)))
  }
  return chunks
}

describe('the CHUNK envelope', () => {
  it('carries the version, kind 7, the item id and first/last flags; it is a data envelope', () => {
    const [first, middle, last] = cut(0xfffffffe, envelopeOf(25), 10)
    assert.equal(first[0], PROTOCOL_VERSION)
    assert.equal(first[1], 7)
    assert.ok(isChunkEnvelope(first) && isDataEnvelope(first))
    assert.deepEqual(
      [first, middle, last].map((chunk) => {
        const { id, first, last, data } = decodeChunk(chunk)
        return [id, first, last, data.length]
      }),
      [
        [0xfffffffe, true, false, 10],
        [0xfffffffe, false, false, 10],
        [0xfffffffe, false, true, 5],
      ],
    )
  })

  it('is joined back into the envelope, also with items interleaved', () => {
    const a = envelopeOf(35)
    const b = envelopeOf(21).reverse()
    const [a1, a2, a3, a4] = cut(1, a, 10)
    const [b1, b2, b3] = cut(2, b, 10)
    const assembler = new ChunkAssembler()
    const out: (Uint8Array | undefined)[] = [a1, a2, b1, a3, b2, b3, a4].map((chunk) => assembler.push(decodeChunk(chunk)))
    assert.deepEqual(out.slice(0, 5), [undefined, undefined, undefined, undefined, undefined])
    assert.deepEqual(out[5], b)
    assert.deepEqual(out[6], a)
    assert.equal(assembler.pending, 0)
  })

  it('a chunk that is first and last is the whole envelope', () => {
    const envelope = envelopeOf(8)
    assert.deepEqual(new ChunkAssembler().push(decodeChunk(cut(5, envelope, 100)[0])), envelope)
  })

  it('a chunk of an unknown item, or an item started twice, is a protocol error', () => {
    const [first, second] = cut(3, envelopeOf(30), 10)
    assert.throws(() => new ChunkAssembler().push(decodeChunk(second)))
    const assembler = new ChunkAssembler()
    assembler.push(decodeChunk(first))
    assert.throws(() => assembler.push(decodeChunk(first)))
  })
})
