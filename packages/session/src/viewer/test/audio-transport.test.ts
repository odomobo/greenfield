import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { decodeEnvelope, PatchFormat } from '@gfld/scene-protocol'
import type { Congestion } from '@nebula/session-contracts'
import { WebSocketViewerTransport } from '../ViewerTransport.js'

/** Just enough of a ws WebSocket: every send is kept, and completes when the test says so. */
class FakeWebSocket extends EventEmitter {
  binaryType = 'nodebuffer'
  readyState: number = WebSocket.OPEN
  bufferedAmount = 0
  sent: { data: Uint8Array; callback?: () => void }[] = []

  send(data: Uint8Array, _options: unknown, callback?: () => void) {
    this.sent.push({ data, callback })
  }

  close() {
    this.emit('close', 1000, Buffer.from(''))
  }

  kinds(): string[] {
    return this.sent.map((sent) => decodeEnvelope(new Uint8Array(sent.data).slice().buffer).kind)
  }
}

/** A congestion controller that never lets a data item go (audio must not depend on it). */
const refusing: Congestion = {
  canSend: () => false,
  nextSendTime: () => Infinity,
  onSend: () => undefined,
  onAck: () => undefined,
  setDataWaiting: () => undefined,
}

function setup() {
  const ws = new FakeWebSocket()
  const transport = new WebSocketViewerTransport(ws as unknown as WebSocket, { congestion: refusing })
  return { ws, transport }
}

const packet = (seq: number, opus = [1, 2, 3]) => ({ seq, timestamp: seq * 960, opus: new Uint8Array(opus) })

test('audio packets are sent at once, whatever the congestion controller says about data', () => {
  const { ws, transport } = setup()
  transport.send({
    priority: 'patch',
    tier: 'normal',
    surface: 's',
    patch: {
      contentSerial: 1,
      surfaceSize: { width: 1, height: 1 },
      rect: { x: 0, y: 0, width: 1, height: 1 },
      format: PatchFormat.QOI,
      channels: 4,
      data: new Uint8Array(1),
    },
  })
  assert.equal(ws.sent.length, 0, 'the patch waits')
  transport.send({ priority: 'audio', packet: packet(7) })
  transport.send({ priority: 'audio', packet: packet(8, [4]) })
  assert.deepEqual(ws.kinds(), ['audio', 'audio'])
  const second = decodeEnvelope(new Uint8Array(ws.sent[1].data).slice().buffer)
  assert.deepEqual(second, { kind: 'audio', seq: 8, timestamp: 8 * 960, opus: new Uint8Array([4]) })
})

test('audio packets are never dropped, however much the socket has buffered', () => {
  const { ws, transport } = setup()
  ws.bufferedAmount = 1024 * 1024
  transport.send({ priority: 'audio', packet: packet(1) })
  transport.send({ priority: 'audio', packet: packet(2) })
  assert.deepEqual(ws.kinds(), ['audio', 'audio'])
})

test('audio packets after closing are ignored', () => {
  const { ws, transport } = setup()
  transport.close(1000, 'bye')
  transport.send({ priority: 'audio', packet: packet(3) })
  assert.equal(ws.sent.length, 0)
})

test('queued control messages are written before an audio packet', () => {
  const { ws, transport } = setup()
  ws.readyState = WebSocket.CONNECTING
  transport.send({ priority: 'control', message: { type: 'audio.state', available: true } })
  assert.equal(ws.sent.length, 0)
  ws.readyState = WebSocket.OPEN
  transport.send({ priority: 'audio', packet: packet(1) })
  assert.deepEqual(ws.kinds(), ['control', 'audio'])
})
