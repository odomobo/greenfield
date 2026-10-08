import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CongestionController, MIN_ITEMS_IN_FLIGHT } from '../congestion.js'
import {
  constantRate,
  HOLD_BYTES,
  itemsBetween,
  LinkConfig,
  maxQueueDelay,
  mbit,
  saturating,
  scripted,
  seededRandom,
  simulate,
  SimResult,
  utilization,
} from './sim-link.js'

/** item sizes like patches: 4-30 KB */
function patchSizes(seed: number) {
  const random = seededRandom(seed)
  return () => 4096 + Math.floor(random() * 26 * 1024)
}

/**
 * Items sent outside of bandwidth probes: a probe is ProbeBW_UP and the ProbeBW_DOWN that drains its queue. A probe
 * sends faster than the link on purpose, its queue only shows a round trip later: probe peaks have their own (higher)
 * bounds below.
 */
const outsideProbes = (result: SimResult, from: number, to: number) =>
  itemsBetween(result, from, to).filter(
    (item) => item.stateAtSend !== 'ProbeBW_UP' && item.stateAtSend !== 'ProbeBW_DOWN',
  )
/** at 40 ms RTT, see ARCHITECTURE.md: the delay threshold plus what a probe adds in the round trip before it sees it */
const PROBE_PEAK_MS = 50
const inState = (result: SimResult, from: number, to: number, state: string) =>
  itemsBetween(result, from, to).filter((item) => item.stateAtSend === state)

/** Every simulated scenario runs with these seeds (item sizes, jitter, bursts): one seed can be lucky. */
const SEEDS = [7, 3, 11]

function seededTest(name: string, body: (seed: number) => void) {
  test(name, () => {
    for (const seed of SEEDS) {
      try {
        body(seed)
      } catch (e) {
        if (e instanceof Error) {
          e.message = `seed ${seed}: ${e.message}`
        }
        throw e
      }
    }
  })
}

// --- the scenarios of ARCHITECTURE.md, "Transport and congestion control", "Testing" -----------------------------------

seededTest('1. 20 Mbit/s, 40 ms: full link, short queue', (seed) => {
  const config: LinkConfig = { seed, rate: () => mbit(20), baseRtt: () => 40 }
  const result = simulate(config, saturating(patchSizes(seed)), 20_000)
  assert.ok(utilization(result, config, 2000, 19_500) >= 0.85, 'throughput')
  assert.ok(maxQueueDelay(inState(result, 2000, 19_500, 'ProbeBW_CRUISE')) <= 20, 'CRUISE queue')
  assert.ok(maxQueueDelay(outsideProbes(result, 2000, 19_500)) <= 20, 'queue outside of probes')
  assert.ok(maxQueueDelay(itemsBetween(result, 2000, 19_500)) <= PROBE_PEAK_MS, 'probe peaks')
})

seededTest('2. 100 Mbit/s, 300 ms: full link, probes stay under 0.3 RTT', (seed) => {
  const config: LinkConfig = { seed, rate: () => mbit(100), baseRtt: () => 300 }
  const result = simulate(config, saturating(patchSizes(seed)), 30_000)
  assert.ok(utilization(result, config, 4000, 29_500) >= 0.8, 'throughput')
  assert.ok(maxQueueDelay(itemsBetween(result, 4000, 29_500)) <= 0.3 * 300, 'queue peaks')
  assert.ok(maxQueueDelay(inState(result, 4000, 29_500, 'ProbeBW_CRUISE')) <= 20, 'CRUISE queue')
})

seededTest('3. bandwidth drops 50 -> 10 Mbit/s: the queue is short again within 1 s', (seed) => {
  const config: LinkConfig = { seed, rate: (t) => mbit(t < 10_000 ? 50 : 10), baseRtt: () => 40 }
  const result = simulate(config, saturating(patchSizes(seed)), 16_000)
  assert.ok(maxQueueDelay(outsideProbes(result, 11_000, 15_500)) <= 25, 'queue after 1 s')
  assert.ok(maxQueueDelay(itemsBetween(result, 11_000, 15_500)) <= PROBE_PEAK_MS, 'probe peaks')
})

seededTest('4. bandwidth rises 10 -> 50 Mbit/s: found within 6 s', (seed) => {
  const config: LinkConfig = { seed, rate: (t) => mbit(t < 10_000 ? 10 : 50), baseRtt: () => 40 }
  const result = simulate(config, saturating(patchSizes(seed)), 20_000)
  assert.ok(utilization(result, config, 16_000, 19_500) >= 0.8, 'throughput')
})

seededTest('5. base RTT rises 40 -> 120 ms: full link again within 12 s', (seed) => {
  const config: LinkConfig = { seed, rate: () => mbit(20), baseRtt: (t) => (t < 10_000 ? 40 : 120) }
  const result = simulate(config, saturating(patchSizes(seed)), 26_000)
  assert.ok(utilization(result, config, 22_000, 25_500) >= 0.8, 'throughput')
})

seededTest('6. a source 5% faster than the link for 60 s: no drift', (seed) => {
  const rate = mbit(20)
  const itemSize = 16 * 1024
  const config: LinkConfig = { seed, rate: () => rate, baseRtt: () => 40 }
  const result = simulate(config, constantRate(rate * 1.05, itemSize), 60_000)
  assert.ok(maxQueueDelay(outsideProbes(result, 2000, 59_500)) <= 30, 'queue outside of probes')
  assert.ok(maxQueueDelay(itemsBetween(result, 2000, 59_500)) <= PROBE_PEAK_MS, 'probe peaks: bounded, not growing')
  // the RTT samples min_rtt is made of include the item's own transmission time
  const trueMin = 40 + itemSize / rate
  for (const sample of result.minRttSamples.filter((s) => s.time > 2000)) {
    assert.ok(sample.minRtt <= trueMin + 5, `min_rtt ${sample.minRtt} at ${sample.time}`)
  }
})

seededTest('7. sporadic desktop traffic: idle periods neither lower max_bw nor cause ProbeRTT', (seed) => {
  const random = seededRandom(seed)
  // a large update first, to measure the link, then bursts of 1-30 patches with idle gaps
  const bursts = [{ at: 0, sizes: Array.from({ length: 300 }, () => 20_000) }]
  for (let t = 3000; t < 33_000; t += 300 + random() * 1200) {
    const count = 1 + Math.floor(random() * 30)
    bursts.push({ at: t, sizes: Array.from({ length: count }, () => 4096 + Math.floor(random() * 26 * 1024)) })
  }
  const maxBw: { time: number; value: number }[] = []
  const config: LinkConfig = {
    seed,
    rate: () => mbit(20),
    baseRtt: () => 40,
    trace: (now, controller) => maxBw.push({ time: now, value: controller.max_bw }),
  }
  const result = simulate(config, scripted(bursts), 34_000)
  const measured = maxBw.filter((s) => s.time < 3000).at(-1)!.value
  assert.ok(measured >= 0.9 * mbit(20), 'the link was measured')
  for (const sample of maxBw.filter((s) => s.time >= 3000)) {
    assert.ok(sample.value >= 0.9 * measured, `max_bw ${sample.value} at ${sample.time}`)
  }
  assert.ok(!result.states.some((s) => s.time > 3000 && s.state === 'ProbeRTT'), 'no ProbeRTT while idle')
})

seededTest('8. jitter and batched acks: full link, delay signals stay harmless', (seed) => {
  const config: LinkConfig = { seed, rate: () => mbit(20), baseRtt: () => 40, jitterMs: 5, ackBatchMs: 16 }
  const result = simulate(config, saturating(patchSizes(seed)), 22_000)
  assert.ok(utilization(result, config, 2000, 21_500) >= 0.8, 'throughput')
  // Noise of up to ~26 ms (16 ms of ack batching, +-5 ms of jitter) on top of a real queue does push some rounds over
  // the 20 ms threshold (about three times as many as on a clean link, see ARCHITECTURE.md). They only resize the
  // short-term bounds to the measured delivery rate: the estimate and the link's use must not collapse.
  // the noise blurs the controller's view of the queue by about its own size: a few items (under 1%) go over 20 ms
  assert.ok(maxQueueDelay(inState(result, 2000, 21_500, 'ProbeBW_CRUISE')) <= 25, 'CRUISE queue')
  assert.ok(result.controller.bw >= 0.8 * mbit(20), `bandwidth estimate ${result.controller.bw}`)
  assert.ok(result.controller.stats.congestionRounds <= 2 * 22, 'at most about 2 congestion rounds a second')
})

seededTest('9. a slow viewer: data is held over the backlog limit, without deadlock', (seed) => {
  const applyRate = mbit(10)
  const itemSize = 16_384
  const config: LinkConfig = { seed, rate: () => mbit(20), baseRtt: () => 40, applyRate }
  const result = simulate(
    config,
    saturating(() => itemSize),
    20_000,
  )
  // the report is half a round trip old: the real backlog may exceed the limit by what arrives meanwhile
  const allowance = HOLD_BYTES + itemSize + mbit(20) * 20 + 2 * itemSize
  for (const sample of result.backlogSamples) {
    assert.ok(sample.bytes <= allowance, `backlog ${sample.bytes} at ${sample.time}`)
  }
  const items = itemsBetween(result, 2000, 19_500)
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i].sendTime - items[i - 1].sendTime < 1000, `no data from ${items[i - 1].sendTime}`)
  }
  const sentRate = (items.length * itemSize) / 17_500
  assert.ok(sentRate >= 0.9 * applyRate, `sent ${sentRate} bytes/ms, the viewer applies ${applyRate}`)
})

test('10. control messages are never delayed by the controller or the backlog hold', () => {
  const controlAt = Array.from({ length: 200 }, (_, i) => 1000 + i * 97)
  const config: LinkConfig = { rate: () => mbit(20), baseRtt: () => 40, applyRate: mbit(5), controlAt }
  const result = simulate(
    config,
    saturating(() => 16_384),
    21_000,
  )
  assert.equal(result.controlDelays.length, controlAt.length)
  assert.ok(result.controlDelays.every((delay) => delay === 0))
  assert.ok(result.controller.holding || result.backlogSamples.some((s) => s.bytes > HOLD_BYTES), 'it did hold')
})

test('11. a single item larger than the in-flight limit is still sent', () => {
  const controller = new CongestionController({ now: 0 })
  const huge = 4 * 1024 * 1024
  for (let i = 0; i < MIN_ITEMS_IN_FLIGHT; i++) {
    assert.ok(controller.canSend(huge, 0) || controller.nextSendTime(huge, 0) < Infinity, `item ${i}`)
    controller.onSend(huge, controller.nextSendTime(huge, 0))
  }
  assert.equal(controller.nextSendTime(huge, 0), Infinity, 'a third one waits for an ack')
})

// --- the controller's API -------------------------------------------------------------------------------------------

test('acks are cumulative and wrap around at 2^32', () => {
  const controller = new CongestionController({ now: 0 })
  // pretend 2^32 - 1 items were acked before
  ;(controller as unknown as { ackedCount: number }).ackedCount = 0xffffffff
  controller.onSend(1000, 0)
  controller.onSend(1000, 0)
  assert.equal(controller.itemsInFlight, 2)
  controller.onAck({ received: 0, backlogBytes: 0, largestPendingBytes: 0 }, 40)
  assert.equal(controller.itemsInFlight, 1)
  controller.onAck({ received: 1, backlogBytes: 0, largestPendingBytes: 0 }, 41)
  assert.equal(controller.itemsInFlight, 0)
  assert.equal(controller.inflight, 0)
})

test('the backlog hold follows the latest report, not counting the largest item', () => {
  const controller = new CongestionController({ now: 0 })
  controller.onSend(1000, 0)
  controller.onAck({ received: 1, backlogBytes: HOLD_BYTES + 500_000, largestPendingBytes: 400_000 }, 40)
  assert.ok(controller.holding)
  assert.equal(controller.canSend(1000, 50), false)
  assert.equal(controller.nextSendTime(1000, 50), Infinity)
  // a fresh report without new items (the viewer applied some)
  controller.onAck({ received: 1, backlogBytes: HOLD_BYTES + 300_000, largestPendingBytes: 400_000 }, 60)
  assert.ok(!controller.holding)
  assert.ok(controller.canSend(1000, 60))
})

test('sends are paced once the bandwidth is known', () => {
  const config: LinkConfig = { rate: () => mbit(20), baseRtt: () => 40 }
  const result = simulate(
    config,
    saturating(() => 16_384),
    5000,
  )
  const controller = result.controller
  const now = 5000
  const next = controller.nextSendTime(16_384, now)
  if (next !== Infinity) {
    controller.onSend(16_384, Math.max(now, next))
    const after = controller.nextSendTime(16_384, Math.max(now, next))
    assert.ok(after === Infinity || after > Math.max(now, next), 'the next item has to wait')
  }
  assert.ok(controller.pacing_rate > 0.8 * mbit(20) && controller.pacing_rate < 1.5 * mbit(20), 'pacing rate')
})
