import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  audioPacketsLost,
  decodeEnvelope,
  decodeViewerEnvelope,
  encodeAudio,
  encodeControl,
  isDataEnvelope,
  PROTOCOL_VERSION,
} from '../src/protocol.js'

const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer

describe('the AUDIO envelope', () => {
  it('carries the sequence number, the timestamp and the Opus packet', () => {
    const opus = new Uint8Array([0xfc, 1, 2, 3, 4])
    const envelope = decodeEnvelope(toBuffer(encodeAudio({ seq: 513, timestamp: 0xdeadbeef, opus })))
    assert.deepEqual(envelope, { kind: 'audio', seq: 513, timestamp: 0xdeadbeef, opus })
  })

  it('wraps the sequence number at 16 bits and the timestamp at 32', () => {
    const opus = new Uint8Array([1])
    const envelope = decodeEnvelope(toBuffer(encodeAudio({ seq: 0x10005, timestamp: 0x100000010, opus })))
    assert.equal(envelope.kind === 'audio' && envelope.seq, 5)
    assert.equal(envelope.kind === 'audio' && envelope.timestamp, 16)
  })

  it('starts with the protocol version (21) and kind 6, and has a header of 8 bytes', () => {
    const bytes = encodeAudio({ seq: 1, timestamp: 2, opus: new Uint8Array(10) })
    assert.equal(PROTOCOL_VERSION, 21)
    assert.deepEqual([...bytes.subarray(0, 2)], [21, 6])
    assert.equal(bytes.length, 18)
  })

  it('rejects an envelope without a packet', () => {
    const bytes = encodeAudio({ seq: 1, timestamp: 2, opus: new Uint8Array(1) })
    assert.throws(() => decodeEnvelope(toBuffer(bytes.subarray(0, 8))), /AUDIO envelope/)
  })

  it('is no data envelope: it is not acknowledged', () => {
    assert.equal(isDataEnvelope(encodeAudio({ seq: 1, timestamp: 2, opus: new Uint8Array(1) })), false)
  })
})

describe('audioPacketsLost', () => {
  it('counts the packets missing between two sequence numbers, also across the wrap', () => {
    assert.equal(audioPacketsLost(4, 5), 0)
    assert.equal(audioPacketsLost(4, 9), 4)
    assert.equal(audioPacketsLost(65535, 0), 0)
    assert.equal(audioPacketsLost(65534, 1), 2)
  })
})

describe('audio messages', () => {
  it('audio.mute goes from the viewer to the server as a control message', () => {
    const decoded = decodeViewerEnvelope(encodeControl({ type: 'audio.mute', muted: true }))
    assert.deepEqual(decoded, { kind: 'control', message: { type: 'audio.mute', muted: true } })
  })

  it('audio.state reaches the viewer as a control message', () => {
    const decoded = decodeEnvelope(toBuffer(encodeControl({ type: 'audio.state', available: false })))
    assert.deepEqual(decoded, { kind: 'control', message: { type: 'audio.state', available: false } })
  })
})
