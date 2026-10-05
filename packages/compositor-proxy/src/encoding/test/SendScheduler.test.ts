import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import {
  ChunkAssembler,
  decodeChunk,
  decodeEnvelope,
  isChunkEnvelope,
  Patch,
  PatchFormat,
} from '@gfld/scene-protocol'
import type { SendTier } from '../policy.js'
import {
  CHUNK_MAX_BYTES,
  CHUNK_MIN_BYTES,
  CHUNK_MS,
  Congestion,
  WebSocketViewerTransport,
} from '../../viewer/ViewerTransport.js'
import { CHUNK_HEADER_BYTES } from '@gfld/scene-protocol'

/** Just enough of a ws WebSocket: sends complete when the test says so. */
class FakeWebSocket extends EventEmitter {
  binaryType = 'nodebuffer'
  readyState = WebSocket.OPEN
  bufferedAmount = 0
  sent: { data: Uint8Array; callback: () => void }[] = []

  send(data: Uint8Array, _options: unknown, callback: () => void) {
    this.sent.push({ data, callback })
  }

  close() {
    this.emit('close', 1000, Buffer.from(''))
  }
}

/** A patch whose data is `bytes` long, so its size on the wire is about that (plus a small header). */
function patch(serial: number, bytes: number): Patch {
  return {
    contentSerial: serial,
    surfaceSize: { width: 100, height: 100 },
    rect: { x: 0, y: 0, width: 10, height: 1 },
    format: PatchFormat.QOI,
    channels: 4,
    data: new Uint8Array(bytes),
  }
}

/** A congestion controller that lets a data item go only while the fake socket has nothing unsent. */
function oneAtATime(ws: { sent: unknown[] }): Congestion {
  return {
    canSend: () => ws.sent.length === 0,
    // only a completed send (it pumps again) makes room
    nextSendTime: () => Infinity,
    onSend: () => undefined,
    onAck: () => undefined,
    setDataWaiting: () => undefined,
  }
}

/** `bandwidthEstimate`: the controller's, in bytes per ms (it sets the chunk size); none by default. */
function setup(bandwidthEstimate?: number) {
  const ws = new FakeWebSocket()
  // These tests are about the order of sending when the network is the bottleneck, not about congestion control: one
  // data item at a time, the next once the socket took the last (the test's flush()).
  const transport = new WebSocketViewerTransport(ws as unknown as WebSocket, {
    congestion: { ...oneAtATime(ws), bandwidthEstimate },
  })
  const queue = (surface: string, tier: SendTier, serial: number, bytes: number) =>
    transport.send({ priority: 'patch', surface, tier, patch: patch(serial, bytes) })
  const assembler = new ChunkAssembler()
  /** bytes on the wire of each item in progress (by chunk id) */
  const partialSizes = new Map<number, number>()
  /** what went over the wire, piece by piece: a whole envelope's kind, or a chunk of an item */
  const pieces: ({ kind: 'chunk'; id: number; first: boolean; last: boolean; size: number } | { kind: string })[] = []
  /**
   * Let every pending send complete, in order, and say what was sent, items joined from their chunks: [surface, serial,
   * wire size (all its chunks)], when the item was complete.
   */
  const drain = () => {
    const result: { surface: string; serial: number; size: number }[] = []
    while (ws.sent.length) {
      const { data, callback } = ws.sent.shift()!
      let bytes = new Uint8Array(data)
      let size = data.length
      if (isChunkEnvelope(bytes)) {
        const chunk = decodeChunk(bytes)
        pieces.push({ kind: 'chunk', id: chunk.id, first: chunk.first, last: chunk.last, size: data.length })
        size += partialSizes.get(chunk.id) ?? 0
        partialSizes.set(chunk.id, size)
        const whole = assembler.push(chunk)
        if (whole === undefined) {
          callback()
          continue
        }
        partialSizes.delete(chunk.id)
        bytes = whole
      }
      const envelope = decodeEnvelope(bytes.slice().buffer)
      if (!isChunkEnvelope(new Uint8Array(data))) {
        pieces.push({ kind: envelope.kind })
      }
      if (envelope.kind === 'patch') {
        result.push({ surface: envelope.surface, serial: envelope.patch.contentSerial, size })
      }
      callback()
    }
    return result
  }
  /** occupy the socket, so everything queued next waits for the scheduler */
  const block = () => {
    queue('blocker', 'normal', 0, 10)
    assert.equal(ws.sent.length, 1)
  }
  return { ws, transport, queue, drain, block, pieces }
}

const NORMAL = 100
const STREAMING = 200

test('the classes share the link 3 : 1 by bytes, also with mixed item sizes', () => {
  const { queue, drain, block } = setup()
  block()
  // normal: 4 KB patches; streaming: alternating 1 KB and 15 KB patches (average 8 KB)
  for (let i = 0; i < 200; i++) {
    queue('n', 'normal', NORMAL + i, 4000)
  }
  for (let i = 0; i < 100; i++) {
    queue('s', 'streaming', STREAMING + i, i % 2 ? 15_000 : 1000)
  }
  const sent = drain().slice(1, 61)
  const bytes = { normal: 0, streaming: 0 }
  for (const { serial, size } of sent) {
    bytes[serial >= STREAMING ? 'streaming' : 'normal'] += size
  }
  assert.ok(bytes.streaming > 0, 'streaming is not starved')
  const ratio = bytes.normal / bytes.streaming
  assert.ok(ratio > 2.6 && ratio < 3.4, `normal : streaming was ${ratio.toFixed(2)} : 1`)
})

const SETTLE = 300

test('settling gets a third of the streaming share: 9 : 3 : 1 by bytes, and all of what the others leave', () => {
  const { queue, drain, block } = setup()
  block()
  for (let i = 0; i < 300; i++) {
    queue('n', 'normal', NORMAL + i, 4000)
    queue('s', 'streaming', STREAMING + i, 4000)
    queue('x', 'settle', SETTLE + i, 4000)
  }
  const sent = drain()
  const bytes = { normal: 0, streaming: 0, settle: 0 }
  for (const { serial, size } of sent.slice(1, 131)) {
    bytes[serial >= SETTLE ? 'settle' : serial >= STREAMING ? 'streaming' : 'normal'] += size
  }
  assert.ok(bytes.settle > 0, 'settling is not starved')
  const normal = bytes.normal / bytes.settle
  const streaming = bytes.streaming / bytes.settle
  assert.ok(normal > 7.5 && normal < 10.5, `normal : settle was ${normal.toFixed(2)} : 1`)
  assert.ok(streaming > 2.4 && streaming < 3.6, `streaming : settle was ${streaming.toFixed(2)} : 1`)
  // the end: settling alone takes the whole link
  assert.ok(sent.slice(-20).every(({ serial }) => serial >= SETTLE))
})

test("a surface's settling patch followed by damage waits in the damage's tier (they go in order)", () => {
  const { transport, queue, drain, block } = setup()
  block()
  queue('a', 'settle', SETTLE, 4000)
  assert.equal(transport.queuedBytes('a'), 0, 'settling never counts as backlog')
  queue('a', 'normal', NORMAL, 100)
  assert.ok(transport.queuedBytes('a') > 100)
  for (let i = 0; i < 20; i++) {
    queue('x', 'settle', SETTLE + 1 + i, 4000)
  }
  // the normal tier takes its turn first: 'a' is in it, settling patch and all
  assert.deepEqual(
    drain()
      .slice(1, 3)
      .map(({ surface, serial }) => [surface, serial]),
    [
      ['a', SETTLE],
      ['a', NORMAL],
    ],
  )
})

test('an item larger than the quantum is still sent, after its class saved up', () => {
  const { queue, drain, block } = setup()
  block()
  queue('big', 'streaming', STREAMING, 100_000)
  for (let i = 0; i < 100; i++) {
    queue('n', 'normal', NORMAL + i, 4000)
  }
  const order = drain().slice(1)
  const at = order.findIndex(({ serial }) => serial === STREAMING)
  assert.ok(at > 0 && at < order.length - 1, 'sent in between the normal items, not first and not last')
  assert.equal(order.length, 101)
})

test('work conserving: a class with nothing waiting leaves the whole link to the other', () => {
  const { queue, drain, block } = setup()
  block()
  for (let i = 0; i < 20; i++) {
    queue('s', 'streaming', STREAMING + i, 10_000)
  }
  assert.deepEqual(
    drain()
      .slice(1)
      .map(({ serial }) => serial),
    Array.from({ length: 20 }, (_, i) => STREAMING + i),
  )
  block()
  for (let i = 0; i < 20; i++) {
    queue('n', 'normal', NORMAL + i, 10_000)
  }
  assert.equal(drain().length, 21)
})

test('a class that was idle does not bank credit', () => {
  const { queue, drain, block } = setup()
  // streaming alone for a long while
  block()
  for (let i = 0; i < 30; i++) {
    queue('s', 'streaming', STREAMING + i, 10_000)
  }
  drain()
  // now both: the share is 3 : 1 from the start, not a burst from banked credit
  block()
  for (let i = 0; i < 100; i++) {
    queue('n', 'normal', NORMAL + i, 4000)
    queue('s', 'streaming', STREAMING + 100 + i, 4000)
  }
  const first = drain().slice(1, 41)
  const streaming = first.filter(({ serial }) => serial >= STREAMING).length
  assert.ok(streaming >= 8 && streaming <= 12, `${streaming} of 40 were streaming`)
})

test('within a class surfaces take turns, and a surface keeps its own order', () => {
  const { queue, drain, block } = setup()
  block()
  for (let i = 1; i <= 3; i++) {
    queue('a', 'normal', 10 + i, 100)
    queue('b', 'normal', 20 + i, 100)
    queue('c', 'streaming', 30 + i, 100)
  }
  const order = drain()
    .slice(1)
    .map(({ serial }) => serial)
  assert.deepEqual(
    order.filter((serial) => serial < 20),
    [11, 12, 13],
  )
  assert.deepEqual(
    order.filter((serial) => serial >= 20 && serial < 30),
    [21, 22, 23],
  )
  assert.deepEqual(
    order.filter((serial) => serial >= 30),
    [31, 32, 33],
  )
  // a and b alternate while both have items
  assert.deepEqual(order.slice(0, 6), [11, 21, 12, 22, 13, 23])
})

test('a surface whose class changes keeps its items in order', () => {
  const { queue, drain, block } = setup()
  block()
  queue('a', 'normal', 1, 100)
  queue('a', 'streaming', 2, 100)
  queue('a', 'streaming', 3, 100)
  queue('a', 'normal', 4, 100)
  assert.deepEqual(
    drain()
      .slice(1)
      .map(({ serial }) => serial),
    [1, 2, 3, 4],
  )
})

test('control messages go out before queued data, always', () => {
  const { ws, transport, queue, block } = setup()
  block()
  for (let i = 0; i < 5; i++) {
    queue('n', 'normal', NORMAL + i, 1000)
    queue('s', 'streaming', STREAMING + i, 1000)
  }
  transport.send({ priority: 'control', message: { type: 'scene' } })
  // the control message is written at once, though the socket is busy with the blocker
  assert.equal(ws.sent.length, 2)
  const envelope = decodeEnvelope(new Uint8Array(ws.sent[1].data).slice().buffer)
  assert.equal(envelope.kind, 'control')
})

// Chunks ----------------------------------------------------------------------------------------------------------

const chunkSizes = (pieces: ReturnType<typeof setup>['pieces']) =>
  pieces.flatMap((piece) => ('size' in piece ? [piece.size - CHUNK_HEADER_BYTES] : []))

test('items larger than the chunk size go in chunks: 10 ms of the bandwidth estimate, at least 10 KB, at most 300 KB', () => {
  // no estimate yet: the minimum
  {
    const { queue, drain, block, pieces } = setup()
    block()
    queue('a', 'normal', NORMAL, 35_000)
    queue('b', 'normal', NORMAL + 1, CHUNK_MIN_BYTES - 100)
    const sent = drain()
    assert.deepEqual(
      sent.map(({ serial }) => serial),
      [0, NORMAL, NORMAL + 1],
      'whole again, in order',
    )
    const sizes = chunkSizes(pieces)
    assert.equal(sizes.length, 4, 'the large one in 4 chunks, the small one whole')
    assert.ok(sizes.slice(0, 3).every((size) => size === CHUNK_MIN_BYTES))
  }
  // 10 MB/s: 100 KB chunks
  {
    const { queue, drain, block, pieces } = setup(10_000)
    block()
    queue('a', 'normal', NORMAL, 250_000)
    drain()
    assert.deepEqual(chunkSizes(pieces).slice(0, 2), [10_000 * CHUNK_MS, 10_000 * CHUNK_MS])
  }
  // an estimate of 1 GB/s: the maximum
  {
    const { queue, drain, block, pieces } = setup(1_000_000)
    block()
    queue('a', 'normal', NORMAL, 700_000)
    drain()
    assert.equal(chunkSizes(pieces)[0], CHUNK_MAX_BYTES)
  }
})

test('control messages go between chunks', () => {
  const { ws, transport, queue, drain, block, pieces } = setup()
  block()
  queue('a', 'normal', NORMAL, 50_000)
  // the blocker, then the first chunk
  ws.sent.shift()!.callback()
  assert.equal(ws.sent.length, 1)
  transport.send({ priority: 'control', message: { type: 'scene' } })
  drain()
  const kinds = pieces.map((piece) => ('id' in piece ? (piece.last ? 'last' : 'chunk') : piece.kind))
  assert.deepEqual(kinds, ['chunk', 'control', 'chunk', 'chunk', 'chunk', 'last'])
})

test("a higher tier's item goes between a lower tier's chunks, then the started item continues", () => {
  const { ws, queue, drain, block, pieces } = setup()
  block()
  queue('x', 'settle', SETTLE, 50_000)
  ws.sent.shift()!.callback()
  // the first settling chunk is on the socket; a window draws
  queue('n', 'normal', NORMAL, 500)
  const order = drain().map(({ serial }) => serial)
  assert.deepEqual(order, [NORMAL, SETTLE])
  const kinds = pieces.map((piece) => ('id' in piece ? (piece.first ? 'first' : 'chunk') : piece.kind))
  assert.deepEqual(kinds.slice(0, 3), ['first', 'patch', 'chunk'], 'right after the chunk on the socket')
})

test('a tier sends one item at a time: chunks of two items of a tier are not interleaved', () => {
  const { queue, drain, block, pieces } = setup()
  block()
  queue('a', 'streaming', STREAMING, 30_000)
  queue('b', 'streaming', STREAMING + 1, 30_000)
  queue('a', 'streaming', STREAMING + 2, 30_000)
  assert.deepEqual(
    drain().map(({ serial }) => serial),
    [0, STREAMING, STREAMING + 1, STREAMING + 2],
    'surfaces still take turns per item',
  )
  const ids = pieces.flatMap((piece) => ('id' in piece ? [piece.id] : []))
  assert.deepEqual(
    ids,
    [...ids].sort((x, y) => x - y),
    'each item whole before the next',
  )
})

test("a surface's next item waits for its started one, which then goes in the next item's tier", () => {
  const { ws, queue, drain, block } = setup()
  block()
  queue('a', 'settle', SETTLE, 50_000)
  queue('x', 'settle', SETTLE + 1, 50_000)
  ws.sent.shift()!.callback()
  // a's settling item started; damage of a (overlapping it, say) must not overtake it
  queue('a', 'normal', NORMAL, 500)
  queue('n', 'normal', NORMAL + 1, 500)
  const order = drain().map(({ serial }) => serial)
  assert.ok(order.indexOf(SETTLE) < order.indexOf(NORMAL), 'in order')
  // and a's started item was pulled ahead of x's by the damage behind it
  assert.ok(order.indexOf(SETTLE) < order.indexOf(SETTLE + 1))
})

test('a started item is never dropped, an unstarted one is; its done comes with its last chunk', () => {
  const { ws, transport, drain, block } = setup()
  block()
  const done: { serial: number; sent: boolean }[] = []
  const send = (serial: number, bytes: number) =>
    transport.send({
      priority: 'patch',
      surface: 'a',
      tier: 'streaming',
      patch: patch(serial, bytes),
      done: (sent) => done.push({ serial, sent }),
    })
  send(STREAMING, 50_000)
  send(STREAMING + 1, 50_000)
  ws.sent.shift()!.callback()
  assert.ok(transport.queuedBytes('a') > 85_000)
  transport.dropPatches('a')
  assert.deepEqual(done, [{ serial: STREAMING + 1, sent: false }])
  assert.ok(transport.queuedBytes('a') > 30_000 && transport.queuedBytes('a') < 50_000, 'what is left of the started one')
  // the chunks go one by one (the first is on the socket already); done only once the last is written
  let chunks = 0
  while (ws.sent.length && done.length === 1) {
    ws.sent.shift()!.callback()
    chunks++
  }
  assert.equal(chunks, Math.ceil(50_000 / CHUNK_MIN_BYTES))
  assert.deepEqual(done[1], { serial: STREAMING, sent: true })
  assert.deepEqual(
    drain().map(({ serial }) => serial),
    [],
  )
  assert.equal(transport.queuedBytes('a'), 0)
})

test('a key frame replaces unsent items but not a started one', () => {
  const { ws, transport, queue, drain, block } = setup()
  block()
  queue('a', 'normal', NORMAL, 50_000)
  queue('a', 'normal', NORMAL + 1, 500)
  ws.sent.shift()!.callback()
  transport.requireKeyFrame('a')
  assert.deepEqual(
    drain().map(({ serial }) => serial),
    [NORMAL],
  )
})
