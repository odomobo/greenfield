import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BANDWIDTH_PERIOD_MS,
  BandwidthMonitor,
  LIMITED_PERIODS,
  LOSSY_RATIO_GUESS,
  MIN_LIMITED_MS,
  SentItem,
} from '../bandwidth.js'
import { constantRate, mbit, saturating, simulate } from './sim-link.js'

const PERIOD = BANDWIDTH_PERIOD_MS
/** when a monitor held back from 0 on is limited */
const LIMITED_AT = LIMITED_PERIODS * PERIOD

/** A monitor on a link of `capacity` bytes per ms, with its state changes recorded. */
function setup(capacity = 1000) {
  const changes: { limited: boolean; held: number; demand: number }[] = []
  const monitor = new BandwidthMonitor(0, () => capacity, (limited, period) => changes.push({ limited, ...period }))
  return { monitor, changes }
}

const patch = (bytes: number, pixels: number, lossy: boolean, surface = 's'): SentItem => ({
  kind: 'patch',
  surface,
  surfaceClass: 'streaming',
  bytes,
  pixels,
  lossy,
})

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

test("doesn't recover while lossy output, counted losslessly, would need most of the bandwidth", () => {
  const { monitor } = setup(1000)
  // the surface's lossless patches take 2 bytes per pixel
  monitor.onSent(patch(20_000, 10_000, false), 0)
  monitor.setHeld(true, 0)
  monitor.setHeld(false, LIMITED_AT)
  assert.equal(monitor.limited(LIMITED_AT), true)
  // lossy patches use 30% of the link and are never held back, but lossless they'd take 120% of it
  for (let t = LIMITED_AT; t < 7 * PERIOD; t += 100) {
    monitor.onSent(patch(30_000, 60_000, true), t)
  }
  assert.equal(monitor.limited(7 * PERIOD), true)
  // the surface calms down: lossless it would now fit
  for (let t = 7 * PERIOD; t < 9 * PERIOD; t += 100) {
    monitor.onSent(patch(3000, 6000, true), t)
  }
  assert.equal(monitor.limited(9 * PERIOD), false)
})

test("a lossy patch of a surface without a lossless measure counts as LOSSY_RATIO_GUESS times its size", () => {
  const { monitor } = setup(1000)
  monitor.setHeld(true, 0)
  monitor.setHeld(false, LIMITED_AT)
  // 25% of the link as JPEG: about 75% lossless, over the 70% it takes to recover
  assert.ok(0.25 * LOSSY_RATIO_GUESS > 0.7)
  for (let t = LIMITED_AT; t < 5 * PERIOD; t += 100) {
    monitor.onSent(patch(25_000, 1, true, 'new'), t)
  }
  assert.equal(monitor.limited(5 * PERIOD), true)
})

test('lower-quality video frames count as twice their size', () => {
  const { monitor } = setup(1000)
  monitor.setHeld(true, 0)
  monitor.setHeld(false, LIMITED_AT)
  const frame: SentItem = { kind: 'frame', surface: 's', surfaceClass: 'streaming', bytes: 40_000 }
  // 40% of the link at the lower quality, 80% at the higher one
  for (let t = LIMITED_AT; t < 5 * PERIOD; t += 100) {
    monitor.onSent(frame, t)
  }
  assert.equal(monitor.limited(5 * PERIOD), true)
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
    (monitor ??= new BandwidthMonitor(0, () => controller.bandwidthEstimate, (limited) => changes.push({ time: now, limited })))
  return {
    changes,
    onPump: (time: number, held: boolean, controller: { bandwidthEstimate: number }) => {
      now = time
      get(controller).setHeld(held, time)
    },
    onTransmit: (time: number, size: number) => {
      now = time
      // lossless patches of 1 byte per pixel
      monitor?.onSent(patch(size, size, false), time)
    },
  }
}

const link = { rate: () => mbit(20), baseRtt: () => 40 }

test('a stream the link cannot keep up with makes it limited within a few seconds', () => {
  const observer = monitored()
  simulate({ ...link, ...observer }, saturating(() => 30_000), 8000)
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
