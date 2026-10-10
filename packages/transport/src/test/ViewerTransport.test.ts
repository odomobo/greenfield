import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { decodeEnvelope, encodeAck, encodeControl, Patch, PatchFormat } from '@gfld/scene-protocol'
import type { Congestion } from '@nebula/session-contracts'
import { WebSocketViewerTransport } from '../index.js'
import { TIERS } from './tiers.js'

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

  /** let the oldest send complete */
  flush() {
    this.sent.shift()?.callback()
  }
}

function h264Frame(serial: number, key: boolean): Uint8Array {
  const accessUnit = [0, 0, 1, key ? 0x65 : 0x41, serial]
  const frame = new Uint8Array(12 + 4 + 16 + 4 + accessUnit.length + 4)
  const view = new DataView(frame.buffer)
  view.setUint32(8, serial, true)
  view.setUint16(12, 0, true)
  view.setUint32(32, accessUnit.length, true)
  frame.set(accessUnit, 36)
  return frame
}

function patch(serial: number): Patch {
  return {
    contentSerial: serial,
    surfaceSize: { width: 100, height: 100 },
    rect: { x: 0, y: serial, width: 10, height: 1 },
    format: PatchFormat.QOI,
    channels: 4,
    data: new Uint8Array([serial]),
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
  const transport = new WebSocketViewerTransport(ws as unknown as WebSocket, {
    congestion: oneAtATime(ws),
    tiers: TIERS,
  })
  /** what reached the socket: 'k1' key frame, 'd2' delta frame, 'p3' patch */
  const delivered = () => {
    const result: string[] = []
    while (ws.sent.length) {
      const envelope = decodeEnvelope(new Uint8Array(ws.sent[0].data).slice().buffer)
      if (envelope.kind === 'frame') {
        const serial = new DataView(envelope.frame.buffer, envelope.frame.byteOffset).getUint32(8, true)
        const key = envelope.frame[39] === 0x65
        result.push(`${key ? 'k' : 'd'}${serial}`)
      } else if (envelope.kind === 'patch') {
        result.push(`p${envelope.patch.contentSerial}`)
      }
      ws.flush()
    }
    return result
  }
  return { ws, transport, delivered }
}

test('frames and patches of a surface are sent in order', () => {
  const { transport, delivered } = setup()
  const done: boolean[] = []
  transport.send({ priority: 'frame', tier: 'streaming', surface: 's', frame: h264Frame(1, true) })
  transport.send({ priority: 'frame', tier: 'streaming', surface: 's', frame: h264Frame(2, false) })
  transport.send({
    priority: 'patch',
    tier: 'normal',
    surface: 's',
    patch: patch(3),
    done: (sent) => done.push(sent),
  })
  transport.send({
    priority: 'patch',
    tier: 'normal',
    surface: 's',
    patch: patch(4),
    done: (sent) => done.push(sent),
  })
  assert.deepEqual(delivered(), ['k1', 'd2', 'p3', 'p4'])
  assert.deepEqual(done, [true, true])
})

test('a key frame is queued like any item: the patches before it still go out', () => {
  const { transport, delivered } = setup()
  const done: boolean[] = []
  transport.send({ priority: 'frame', tier: 'streaming', surface: 'other', frame: h264Frame(9, true) }) // occupies the socket
  transport.send({
    priority: 'patch',
    tier: 'normal',
    surface: 's',
    patch: patch(1),
    done: (sent) => done.push(sent),
  })
  transport.send({
    priority: 'patch',
    tier: 'normal',
    surface: 's',
    patch: patch(2),
    done: (sent) => done.push(sent),
  })
  transport.send({
    priority: 'frame',
    tier: 'streaming',
    surface: 's',
    frame: h264Frame(3, true),
    done: (sent) => done.push(sent),
  })
  assert.deepEqual(done, [])
  assert.deepEqual(delivered(), ['k9', 'p1', 'p2', 'k3'])
  assert.deepEqual(done, [true, true, true])
})

test('the transport does not look into frames: a delta goes out without a key frame before it', () => {
  const { transport, delivered } = setup()
  const done: boolean[] = []
  for (const serial of [1, 2]) {
    transport.send({
      priority: 'frame',
      tier: 'streaming',
      surface: 's',
      frame: h264Frame(serial, false),
      done: (sent) => done.push(sent),
    })
  }
  assert.deepEqual(delivered(), ['d1', 'd2'])
  assert.deepEqual(done, [true, true])
})

test('a destroyed surface needs no call: its queued items go out, then nothing of it is left', () => {
  const { transport, delivered } = setup()
  const done: boolean[] = []
  transport.send({ priority: 'frame', tier: 'streaming', surface: 'other', frame: h264Frame(9, true) })
  transport.send({
    priority: 'frame',
    tier: 'streaming',
    surface: 's',
    frame: h264Frame(1, true),
    done: (sent) => done.push(sent),
  })
  transport.send({
    priority: 'patch',
    tier: 'normal',
    surface: 's',
    patch: patch(2),
    done: (sent) => done.push(sent),
  })
  assert.ok(transport.unsentBytes('s', 'settle') > 0)
  assert.deepEqual(delivered(), ['k9', 'k1', 'p2'])
  assert.deepEqual(done, [true, true])
  assert.equal(transport.unsentBytes('s', 'settle'), 0)
})

test('closing reports unsent patches as dropped', () => {
  const { ws, transport } = setup()
  const done: boolean[] = []
  transport.send({ priority: 'frame', tier: 'streaming', surface: 'other', frame: h264Frame(9, true) })
  transport.send({
    priority: 'patch',
    tier: 'normal',
    surface: 's',
    patch: patch(1),
    done: (sent) => done.push(sent),
  })
  ws.close()
  assert.deepEqual(done, [false])
})

test('nothing is coalesced or dropped, however many items of a surface wait', () => {
  const { transport, delivered } = setup()
  const done: boolean[] = []
  transport.send({ priority: 'frame', tier: 'streaming', surface: 'other', frame: h264Frame(9, true) })
  for (let i = 1; i <= 10; i++) {
    transport.send({
      priority: 'patch',
      tier: 'normal',
      surface: 'p',
      patch: patch(i),
      done: (sent) => done.push(sent),
    })
  }
  transport.send({ priority: 'frame', tier: 'streaming', surface: 'v', frame: h264Frame(20, true) })
  for (let i = 21; i <= 26; i++) {
    transport.send({
      priority: 'frame',
      tier: 'streaming',
      surface: 'v',
      frame: h264Frame(i, false),
      done: (sent) => done.push(sent),
    })
  }
  const sent = delivered()
  assert.deepEqual(
    sent.filter((entry) => entry.startsWith('p')),
    Array.from({ length: 10 }, (_, i) => `p${i + 1}`),
  )
  assert.deepEqual(
    sent.filter((entry) => entry !== 'k9' && !entry.startsWith('p')),
    ['k20', 'd21', 'd22', 'd23', 'd24', 'd25', 'd26'],
  )
  assert.equal(done.length, 16)
  assert.ok(done.every((sent) => sent))
})

test('frames held back by a full socket go out once queued control messages are written', () => {
  const { ws, transport } = setup()
  // a burst of control messages (as on attach) fills the socket, with no frame in flight
  ws.bufferedAmount = 1024 * 1024
  transport.send({ priority: 'control', message: { type: 'scene' } })
  transport.send({ priority: 'patch', tier: 'normal', surface: 's', patch: patch(1) })
  assert.equal(ws.sent.length, 1, 'only the control message is sent while the socket is full')
  // the socket drains; nothing else is sent, the control message's completion must restart the frames
  ws.bufferedAmount = 0
  ws.flush()
  assert.equal(ws.sent.length, 1)
  const envelope = decodeEnvelope(new Uint8Array(ws.sent[0].data).slice().buffer)
  assert.equal(envelope.kind, 'patch')
})

test('acks from the viewer go to onAck, control messages still to onMessage', () => {
  const { ws, transport } = setup()
  const acks: unknown[] = []
  const messages: unknown[] = []
  transport.onAck = (ack) => acks.push(ack)
  transport.onMessage = (message) => messages.push(message)
  ws.emit('message', Buffer.from(encodeAck({ received: 7, backlogBytes: 1000, largestPendingBytes: 600 })), true)
  ws.emit('message', Buffer.from(encodeControl({ type: 'focus', focused: true })), true)
  assert.deepEqual(acks, [{ kind: 'ack', received: 7, backlogBytes: 1000, largestPendingBytes: 600 }])
  assert.deepEqual(messages, [{ type: 'focus', focused: true }])
})
