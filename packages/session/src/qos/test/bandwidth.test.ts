import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BURST_MS } from '../../encoding/policy.js'
import { BANDWIDTH_PERIOD_MS, BandwidthMonitor, LIMITED_PERIODS, MIN_LIMITED_MS } from '../bandwidth.js'
import { constantRate, mbit, saturating, simulate } from './sim-link.js'

const PERIOD = BANDWIDTH_PERIOD_MS
/** when a monitor held back from 0 on is limited */
const LIMITED_AT = LIMITED_PERIODS * PERIOD

/**
 * A monitor on a link of `capacity` bytes per ms, with a predicted backlog the test sets, and its state changes
 * recorded.
 */
function setup(capacity = 1000) {
  const changes: { limited: boolean; held: number; backlogMs: number }[] = []
  const state = { capacity, backlog: 0 }
  const monitor = new BandwidthMonitor(
    0,
    () => state.capacity,
    () => state.backlog,
    (limited, reason) => changes.push({ limited, ...reason }),
  )
  return { monitor, changes, state }
}

/** Held back from `from` for `ms` (then not). */
function hold(monitor: BandwidthMonitor, from: number, ms: number) {
  monitor.setHeld(true, from)
  monitor.setHeld(false, from + ms)
}

test('not limited while streaming data is held back less than 80% of a period', () => {
  const { monitor, changes } = setup()
  for (let period = 0; period < 5; period++) {
    hold(monitor, period * PERIOD, 0.75 * PERIOD)
  }
  assert.equal(monitor.limited(5 * PERIOD), false)
  assert.deepEqual(changes, [])
})

test('limited from the end of two periods in a row held back at least 80% of the time', () => {
  const { monitor } = setup()
  hold(monitor, 100, 850)
  assert.equal(monitor.limited(PERIOD), false, 'one period is not enough')
  hold(monitor, PERIOD + 100, 850)
  assert.equal(monitor.limited(2 * PERIOD - 1), false, 'only once the period is over')
  assert.equal(monitor.limited(2 * PERIOD), true)
})

test('a single held period (as when the controller probes for the round-trip time) is not enough', () => {
  const { monitor } = setup()
  for (let period = 0; period < 10; period += 2) {
    hold(monitor, period * PERIOD, PERIOD)
  }
  assert.equal(monitor.limited(10 * PERIOD), false)
})

test('held back without interruption across period ends counts for each period', () => {
  const { monitor } = setup()
  monitor.setHeld(true, 0)
  assert.equal(monitor.limited(LIMITED_AT), true)
})

test('recovers after a quiet period, but not before MIN_LIMITED_MS', () => {
  const { monitor, changes } = setup()
  monitor.setHeld(true, 0)
  monitor.setHeld(false, LIMITED_AT)
  assert.equal(monitor.limited(LIMITED_AT), true)
  // nothing waits from here on: still limited until MIN_LIMITED_MS after it began
  assert.equal(monitor.limited(LIMITED_AT + MIN_LIMITED_MS - 1), true)
  assert.equal(monitor.limited(LIMITED_AT + MIN_LIMITED_MS), false)
  assert.deepEqual(
    changes.map(({ limited }) => limited),
    [true, false],
  )
})

test('the bandwidth is only known once the link was saturated, then remembered', () => {
  const { monitor, state } = setup(1000)
  assert.equal(monitor.linkBandwidth, undefined)
  // a single held period (Startup, ProbeRTT) doesn't count
  hold(monitor, 0, PERIOD)
  monitor.limited(2 * PERIOD)
  assert.equal(monitor.linkBandwidth, undefined)
  monitor.setHeld(true, 2 * PERIOD)
  monitor.setHeld(false, 2 * PERIOD + LIMITED_AT)
  assert.equal(monitor.limited(2 * PERIOD + LIMITED_AT), true)
  assert.equal(monitor.linkBandwidth, 1000)
  // the link is idle: the controller's estimate decays, the measured bandwidth stays
  state.capacity = 100
  monitor.limited(20 * PERIOD)
  assert.equal(monitor.linkBandwidth, 1000)
  // but a higher estimate is a better lower bound
  state.capacity = 1500
  assert.equal(monitor.linkBandwidth, 1500)
})

test('a predicted backlog over BURST_MS makes the link limited at once, but only once its bandwidth is known', () => {
  const { monitor, state, changes } = setup(1000)
  state.backlog = 10 * BURST_MS * 1000
  assert.equal(monitor.limited(PERIOD / 2), false, 'bandwidth unknown')
  // saturated once, then recovered
  monitor.setHeld(true, PERIOD)
  monitor.setHeld(false, PERIOD + LIMITED_AT)
  state.backlog = 0
  assert.equal(monitor.limited(PERIOD + LIMITED_AT), true)
  assert.equal(monitor.limited(PERIOD + LIMITED_AT + MIN_LIMITED_MS), false)
  // a burst: just over BURST_MS of backlog at 1000 bytes per ms
  state.backlog = (BURST_MS + 1) * 1000
  assert.equal(monitor.limited(6.5 * PERIOD), true, 'at once, mid-period')
  assert.equal(changes.at(-1)?.limited, true)
  assert.ok(changes.at(-1)!.backlogMs > BURST_MS)
})

test('it ends only when both are quiet: held back under half the period, and the predicted backlog under BURST_MS', () => {
  const { monitor, state } = setup(1000)
  monitor.setHeld(true, 0)
  monitor.setHeld(false, LIMITED_AT)
  assert.equal(monitor.limited(LIMITED_AT), true)
  // nothing is held back, but a backlog is predicted (say a stream gone lossy that would need more than the link)
  state.backlog = 2 * BURST_MS * 1000
  assert.equal(monitor.limited(LIMITED_AT + 3 * MIN_LIMITED_MS), true)
  state.backlog = (BURST_MS / 2) * 1000
  const end = LIMITED_AT + 3 * MIN_LIMITED_MS + PERIOD
  // the backlog is checked at the end of a period
  assert.equal(monitor.limited(end - 1), true)
  assert.equal(monitor.limited(end), false)
})

test('a long quiet stretch is skipped over, not walked through', () => {
  const { monitor } = setup()
  monitor.setHeld(true, 0)
  assert.equal(monitor.limited(LIMITED_AT), true)
  monitor.setHeld(false, LIMITED_AT)
  const start = performance.now()
  assert.equal(monitor.limited(1e12), false)
  assert.ok(performance.now() - start < 50)
  // and it measures periods from now on as usual
  monitor.setHeld(true, 1e12)
  assert.equal(monitor.limited(1e12 + LIMITED_AT), true)
})

// With the real congestion controller on a simulated link ---------------------------------------------------------

/** A monitor fed by the simulated link's pumps, with when it changed state. */
function monitored() {
  let monitor: BandwidthMonitor | undefined
  const changes: { time: number; limited: boolean }[] = []
  let now = 0
  const get = (controller: { bandwidthEstimate: number }) =>
    (monitor ??= new BandwidthMonitor(
      0,
      () => controller.bandwidthEstimate,
      () => 0,
      (limited) => changes.push({ time: now, limited }),
    ))
  return {
    changes,
    onPump: (time: number, held: boolean, controller: { bandwidthEstimate: number }) => {
      now = time
      get(controller).setHeld(held, time)
    },
  }
}

const link = { rate: () => mbit(20), baseRtt: () => 40 }

test('a stream the link cannot keep up with makes it limited within a few seconds', () => {
  const observer = monitored()
  simulate(
    { ...link, ...observer },
    saturating(() => 30_000),
    8000,
  )
  assert.ok(observer.changes.length > 0, 'limited')
  assert.equal(observer.changes[0].limited, true)
  assert.ok(observer.changes[0].time <= 4 * PERIOD, `limited at ${observer.changes[0].time} ms`)
  assert.deepEqual(
    observer.changes.map(({ limited }) => limited),
    [true],
    'and stays limited',
  )
})

test('a stream at up to 80% of the link never makes it limited', () => {
  for (const share of [0.4, 0.7, 0.8]) {
    for (const seed of [1, 2, 3]) {
      const observer = monitored()
      simulate({ ...link, ...observer, seed, jitterMs: 3 }, constantRate(share * mbit(20), 20_000), 12_000)
      assert.deepEqual(observer.changes, [], `${share * 100}% of the link, seed ${seed}`)
    }
  }
})
