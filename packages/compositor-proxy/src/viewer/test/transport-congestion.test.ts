import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { decodeEnvelope, encodeAck, encodePatch, Patch, PatchFormat } from '@gfld/scene-protocol'
import { CongestionController } from '../congestion.js'
import { Congestion, WebSocketViewerTransport } from '../ViewerTransport.js'

/** Just enough of a ws WebSocket: sends are handed to the kernel at once (their callbacks run right away). */
class FakeWebSocket extends EventEmitter {
  binaryType = 'nodebuffer'
  readyState = WebSocket.OPEN
  bufferedAmount = 0
  sent: Uint8Array[] = []

  send(data: Uint8Array, _options: unknown, callback: () => void) {
    this.sent.push(data)
    queueMicrotask(callback)
  }

  close() {
    this.emit('close', 1000, Buffer.from(''))
  }

  /** the viewer's ACK envelope arrives */
  ack(received: number, backlogBytes = 0, largestPendingBytes = 0) {
    this.emit('message', Buffer.from(encodeAck({ received, backlogBytes, largestPendingBytes })), true)
  }

  kinds(): string[] {
    return this.sent.map((data) => decodeEnvelope(new Uint8Array(data).slice().buffer).kind)
  }
}

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

const settle = () => new Promise((resolve) => setImmediate(resolve))
/** Pacing timers run on real time, the controller on the test's clock: move the clock, then let the timers fire. */
const later = async (clock: { advance: (ms: number) => void }, ms: number) => {
  clock.advance(ms)
  await new Promise((resolve) => setTimeout(resolve, 5))
}

function setup(congestion?: Congestion) {
  const ws = new FakeWebSocket()
  let time = 1000
  const clock = { now: () => time, advance: (ms: number) => (time += ms) }
  const controller = new CongestionController({ now: time })
  const transport = new WebSocketViewerTransport(ws as unknown as WebSocket, {
    now: clock.now,
    congestion: congestion ?? controller,
    // these tests are about the window, not chunking (see SendScheduler.test.ts)
    chunkBytes: { min: 1 << 30, max: 1 << 30 },
  })
  const queuePatch = (serial: number, bytes: number) =>
    transport.send({ priority: 'patch', surface: 's', tier: 'normal', patch: patch(serial, bytes) })
  const queueControl = () => transport.send({ priority: 'control', message: { type: 'scene' } })
  return { ws, clock, controller, transport, queuePatch, queueControl }
}

test('data waits for the window, control messages go out anyway', async () => {
  const { ws, clock, controller, queuePatch, queueControl } = setup()
  // 40 KB patches against a 64 KB initial window: the 2-item floor lets two go, the third waits for an ack
  for (let i = 1; i <= 3; i++) {
    queuePatch(i, 40_000)
  }
  await later(clock, 10)
  assert.deepEqual(ws.kinds(), ['patch', 'patch'])
  await later(clock, 10)
  assert.deepEqual(ws.kinds(), ['patch', 'patch'], 'still waiting for the ack, not for time')
  queueControl()
  await settle()
  assert.deepEqual(ws.kinds(), ['patch', 'patch', 'control'], 'the control message is not held back')
  // the bytes counted are the envelopes' as sent, as the viewer counts them
  assert.equal(controller.inflight, 2 * encodePatch('s', patch(1, 40_000)).length)
  ws.ack(1)
  await later(clock, 10)
  assert.deepEqual(ws.kinds(), ['patch', 'patch', 'control', 'patch'], 'the ack let the third one go')
})

test('the viewer backlog holds data, not control messages, until a fresh ack', async () => {
  const { ws, clock, queuePatch, queueControl } = setup()
  queuePatch(1, 1000)
  await later(clock, 40)
  ws.ack(1, 3_000_000, 10_000)
  queuePatch(2, 1000)
  queueControl()
  await later(clock, 40)
  assert.deepEqual(ws.kinds(), ['patch', 'control'], 'held, but control goes out')
  // the viewer applied most of it: same count, smaller backlog
  ws.ack(1, 500_000, 10_000)
  await later(clock, 10)
  assert.deepEqual(ws.kinds(), ['patch', 'control', 'patch'])
})

test('a paced item goes out when it is due, by a timer', async () => {
  const ws = new FakeWebSocket()
  let due = Infinity
  const start = Date.now()
  // a controller that paces: the next item is due 20 ms after the first one
  const congestion: Congestion = {
    canSend: (_bytes, now) => now >= due || due === Infinity,
    nextSendTime: (_bytes, now) => Math.max(now, due),
    onSend: (_bytes, now) => {
      due = now + 20
    },
    onAck: () => undefined,
    setDataWaiting: () => undefined,
  }
  const transport = new WebSocketViewerTransport(ws as unknown as WebSocket, { now: () => Date.now(), congestion })
  for (let i = 1; i <= 2; i++) {
    transport.send({ priority: 'patch', surface: 's', tier: 'normal', patch: patch(i, 100) })
  }
  await settle()
  assert.equal(ws.sent.length, 1)
  while (ws.sent.length < 2 && Date.now() - start < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.equal(ws.sent.length, 2)
  assert.ok(Date.now() - start >= 19, 'not before it was due')
  transport.close(1000, '')
})

test('nothing goes out past the 256 KB safety limit of buffered data, control messages still do', async () => {
  const { ws, queuePatch, queueControl } = setup({
    canSend: () => true,
    nextSendTime: (_bytes, now) => now,
    onSend: () => undefined,
    onAck: () => undefined,
    setDataWaiting: () => undefined,
  })
  ws.bufferedAmount = 300 * 1024
  queuePatch(1, 100)
  queueControl()
  await settle()
  assert.deepEqual(ws.kinds(), ['control'])
  ws.bufferedAmount = 0
  queueControl()
  await settle()
  assert.deepEqual(ws.kinds(), ['control', 'control', 'patch'])
})
