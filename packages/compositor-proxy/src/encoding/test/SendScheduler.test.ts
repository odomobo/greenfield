import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { decodeEnvelope, Patch, PatchFormat } from '@gfld/scene-protocol'
import type { SendTier } from '../policy.js'
import { Congestion, WebSocketViewerTransport } from '../../viewer/ViewerTransport.js'

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

function setup() {
  const ws = new FakeWebSocket()
  // These tests are about the order of sending when the network is the bottleneck, not about congestion control: one
  // data item at a time, the next once the socket took the last (the test's flush()).
  const transport = new WebSocketViewerTransport(ws as unknown as WebSocket, { congestion: oneAtATime(ws) })
  const queue = (surface: string, tier: SendTier, serial: number, bytes: number) =>
    transport.send({ priority: 'patch', surface, tier, patch: patch(serial, bytes) })
  /** Let every pending send complete, in order, and say what was sent: [surface, serial, wire size]. */
  const drain = () => {
    const result: { surface: string; serial: number; size: number }[] = []
    while (ws.sent.length) {
      const { data, callback } = ws.sent.shift()!
      const envelope = decodeEnvelope(new Uint8Array(data).slice().buffer)
      if (envelope.kind === 'patch') {
        result.push({ surface: envelope.surface, serial: envelope.patch.contentSerial, size: data.length })
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
  return { ws, transport, queue, drain, block }
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
