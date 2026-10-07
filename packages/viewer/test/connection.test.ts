import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Connection } from '../src/connection.js'

/** A stand-in for the browser's WebSocket: records what the page sends, the test plays the server. */
class FakeWebSocket {
  static readonly OPEN = 1
  static last: FakeWebSocket
  readyState = 0
  binaryType = 'blob'
  bufferedAmount = 0
  readonly sent: (string | Uint8Array)[] = []
  onopen?: () => void
  onmessage?: (event: { data: unknown }) => void
  onclose?: (event: { code: number; reason: string }) => void

  constructor(readonly url: string) {
    FakeWebSocket.last = this
  }

  send(data: string | Uint8Array) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  serverSends(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

Object.assign(globalThis, { WebSocket: FakeWebSocket, location: { protocol: 'https:', host: 'example.test' } })

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Connection', () => {
  it('sends nothing but the sign-in conversation until it succeeded', async () => {
    const connection = new Connection()
    const result = connection.signIn('alice', {
      prompt: async () => 'secret',
      message: () => undefined,
    })
    const ws = FakeWebSocket.last
    ws.open()
    // the desktop and the audio player send whenever they like (frame pacing feedback, focus, ...)
    connection.send({ type: 'feedback', refreshInterval: 16 })
    ws.serverSends({ type: 'prompt', text: 'Password: ', echo: false })
    connection.send({ type: 'focus', focused: true })
    await tick()
    assert.deepEqual(ws.sent, [
      JSON.stringify({ type: 'begin', username: 'alice' }),
      JSON.stringify({ type: 'answer', text: 'secret' }),
    ])
    assert.equal(connection.open, false)

    ws.serverSends({ type: 'result', ok: true, username: 'alice' })
    assert.deepEqual(await result, { ok: true, username: 'alice' })
    assert.equal(connection.open, true)
    connection.send({ type: 'focus', focused: true })
    assert.equal(ws.sent.length, 3)
    assert.notEqual(typeof ws.sent[2], 'string')
  })

  it('reports a failed sign-in with the server message', async () => {
    const connection = new Connection()
    const result = connection.signIn('bob', { prompt: async () => 'wrong', message: () => undefined })
    const ws = FakeWebSocket.last
    ws.open()
    ws.serverSends({ type: 'prompt', text: 'Password: ', echo: false })
    await tick()
    ws.serverSends({ type: 'result', ok: false, message: 'The username or password is incorrect.' })
    assert.deepEqual(await result, { ok: false, message: 'The username or password is incorrect.' })
  })
})
