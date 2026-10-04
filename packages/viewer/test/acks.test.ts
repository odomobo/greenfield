import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AckTracker } from '../src/acks.js'
import { BACKLOG_HOLD_BYTES, decodeViewerEnvelope, encodeAck, type ViewerAck } from '../src/protocol.js'

function setup(holdBytes = 1000) {
  const sent: ViewerAck[] = []
  const tracker = new AckTracker((ack) => sent.push(ack), holdBytes)
  return { tracker, sent }
}

describe('AckTracker', () => {
  it('acknowledges every data envelope on arrival, with the backlog', () => {
    const { tracker, sent } = setup()
    tracker.arrived(100)
    tracker.arrived(300)
    assert.deepEqual(sent, [
      { received: 1, backlogBytes: 100, largestPendingBytes: 100 },
      { received: 2, backlogBytes: 400, largestPendingBytes: 300 },
    ])
  })

  it('applied envelopes leave the backlog, without an ack while under the limit', () => {
    const { tracker, sent } = setup()
    const first = tracker.arrived(100)
    tracker.arrived(300)
    tracker.applied(first)
    tracker.applied(first) // twice does nothing
    assert.equal(sent.length, 2)
    tracker.arrived(50)
    assert.deepEqual(sent.at(-1), { received: 3, backlogBytes: 350, largestPendingBytes: 300 })
  })

  it('reports again after applying while the last report was over the limit, until it is under', () => {
    const { tracker, sent } = setup(1000)
    const tokens = [600, 600, 600].map((bytes) => tracker.arrived(bytes))
    // 1800 pending, 600 of it the largest: 1200 over the limit of 1000
    assert.deepEqual(sent.at(-1), { received: 3, backlogBytes: 1800, largestPendingBytes: 600 })
    tracker.applied(tokens[0])
    // the fresh report: same count, 1200 - 600 = 600, under the limit
    assert.deepEqual(sent.at(-1), { received: 3, backlogBytes: 1200, largestPendingBytes: 600 })
    const count = sent.length
    tracker.applied(tokens[1])
    assert.equal(sent.length, count, 'no more reports once under the limit')
  })

  it('starts over on a new connection', () => {
    const { tracker, sent } = setup()
    tracker.arrived(100)
    tracker.reset()
    tracker.arrived(200)
    assert.deepEqual(sent.at(-1), { received: 1, backlogBytes: 200, largestPendingBytes: 200 })
  })

  it('round-trips through the ACK envelope', () => {
    const ack = { received: 0xfffffffe, backlogBytes: BACKLOG_HOLD_BYTES + 5, largestPendingBytes: 70_000 }
    assert.deepEqual(decodeViewerEnvelope(encodeAck(ack)), { kind: 'ack', ...ack })
  })
})
