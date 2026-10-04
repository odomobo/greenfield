import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLASS_PERIOD_MS,
  DEMOTE_FRACTION,
  DEMOTE_HOLD_MS,
  MAX_PATCH_PIXELS,
  planPatches,
  PROMOTE_FRACTION,
  RelentlessMeter,
} from '../policy.js'
import { area, Rect } from '../region.js'

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

/**
 * Drives a meter like a surface would: a clock, backlogged intervals, and an evaluation every 50 ms (commits and the
 * 200 ms tick).
 */
function clock(meter: RelentlessMeter, start = 0) {
  let now = start
  return {
    get now() {
      return now
    },
    /** advance by `ms`, evaluating every 50 ms; `backlogged` is whether the surface is backlogged throughout */
    run(ms: number, backlogged: boolean) {
      const end = now + ms
      if (backlogged) {
        meter.markBackloggedStart(now)
      } else {
        meter.markBackloggedEnd(now)
      }
      while (now < end) {
        now = Math.min(end, now + 50)
        meter.evaluate(now)
      }
    },
  }
}

test('the fraction is the share of the last period spent backlogged', () => {
  const meter = new RelentlessMeter()
  assert.equal(meter.fraction(1000), 0)
  meter.markBackloggedStart(1000)
  assert.equal(meter.fraction(1000 + CLASS_PERIOD_MS / 2), 0.5)
  meter.markBackloggedEnd(1000 + CLASS_PERIOD_MS / 2)
  assert.equal(meter.fraction(1000 + CLASS_PERIOD_MS), 0.5)
  // it slides: half of the backlogged time is out of the period now
  assert.equal(meter.fraction(1000 + CLASS_PERIOD_MS + CLASS_PERIOD_MS / 4), 0.25)
  assert.equal(meter.fraction(1000 + 3 * CLASS_PERIOD_MS), 0)
})

test('start and end are idempotent', () => {
  const meter = new RelentlessMeter()
  meter.markBackloggedStart(0)
  meter.markBackloggedStart(500)
  meter.markBackloggedEnd(1000)
  meter.markBackloggedEnd(1200)
  assert.equal(meter.fraction(CLASS_PERIOD_MS), 1000 / CLASS_PERIOD_MS)
})

test('a one-off big repaint stays normal', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  time.run(5000, false)
  // the repaint takes 300 ms to go out, no new commits meanwhile
  time.run(300, false)
  time.run(5000, false)
  assert.equal(meter.surfaceClass, 'normal')
})

test('a surface that commits while its patches queue is promoted once a whole period has passed', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  time.run(CLASS_PERIOD_MS - 50, true)
  assert.equal(meter.surfaceClass, 'normal', 'not before CLASS_PERIOD_MS of age, however backlogged')
  time.run(50, true)
  assert.equal(meter.surfaceClass, 'streaming')
})

test('promotion is within about a period for a surface backlogged from its first commit', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  time.run(100, false) // not backlogged until its second commit
  time.run(CLASS_PERIOD_MS, true)
  // backlogged for (period - 100) ms of the last period is only 0.93 of it: promoted
  assert.equal(meter.surfaceClass, 'streaming')
  assert.ok(meter.fraction(time.now) >= PROMOTE_FRACTION)
})

test('a throttled surface stays streaming: it is backlogged however slowly it is allowed to draw', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  time.run(3000, true)
  assert.equal(meter.surfaceClass, 'streaming')
  // drains for a moment between frames (10%), still far above the demotion threshold
  for (let i = 0; i < 20; i++) {
    time.run(450, true)
    time.run(50, false)
  }
  assert.equal(meter.surfaceClass, 'streaming')
})

test('a needy surface that drains between its commits stays normal', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  // 60 commits a second, each takes about 5 ms to go out: backlogged a third of the time at most
  for (let i = 0; i < 300; i++) {
    time.run(5, true)
    time.run(11, false)
  }
  assert.equal(meter.surfaceClass, 'normal')
  assert.ok(meter.fraction(time.now) < PROMOTE_FRACTION)
})

test('a surface above the demotion fraction is not demoted, however long', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  time.run(2000, true)
  assert.equal(meter.surfaceClass, 'streaming')
  // backlogged 60% of the time: between the thresholds
  for (let i = 0; i < 40; i++) {
    time.run(450, true)
    time.run(300, false)
  }
  assert.ok(meter.fraction(time.now) > DEMOTE_FRACTION)
  assert.equal(meter.surfaceClass, 'streaming')
})

test('demotion needs DEMOTE_HOLD_MS below the fraction without interruption', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  time.run(2000, true)
  assert.equal(meter.surfaceClass, 'streaming')
  time.run(0, false)
  // the fraction falls below DEMOTE_FRACTION after (1 - 0.4) of a period, then the hold starts
  const below = CLASS_PERIOD_MS * (1 - DEMOTE_FRACTION)
  // the hold has run for about half of DEMOTE_HOLD_MS
  time.run(below + DEMOTE_HOLD_MS / 2, false)
  assert.equal(meter.surfaceClass, 'streaming', 'still holding')
  // an interruption: backlogged again long enough to lift the fraction over the threshold resets the hold
  time.run(1000, true)
  time.run(0, false)
  // the backlog starts to slide out of the period 500 ms after it ended, and the fraction is below the threshold
  // 400 ms later
  time.run(900 + DEMOTE_HOLD_MS - 600, false)
  assert.equal(meter.surfaceClass, 'streaming', 'the hold restarted')
  time.run(800, false)
  assert.equal(meter.surfaceClass, 'normal')
})

test('demotion takes DEMOTE_HOLD_MS after the fraction fell below the threshold', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  time.run(2000, true)
  const end = time.now
  time.run(0, false)
  let demotedAt: number | undefined
  while (time.now < end + 10_000 && demotedAt === undefined) {
    time.run(50, false)
    if (meter.surfaceClass === 'normal') {
      demotedAt = time.now
    }
  }
  assert.ok(demotedAt !== undefined)
  const belowSince = end + CLASS_PERIOD_MS * (1 - DEMOTE_FRACTION)
  assert.ok(demotedAt - belowSince >= DEMOTE_HOLD_MS && demotedAt - belowSince < DEMOTE_HOLD_MS + 100)
})

test('planPatches leaves out damage that a queued patch will pick up', () => {
  const bounds = r(0, 0, 1000, 1000)
  assert.deepEqual(planPatches([r(10, 10, 20, 20)], [r(0, 0, 100, 100)], bounds), [], 'fully covered')
  const partial = planPatches([r(50, 0, 100, 10)], [r(0, 0, 100, 100)], bounds)
  assert.deepEqual(partial, [r(100, 0, 50, 10)], 'only the uncovered part')
  assert.deepEqual(planPatches([r(990, 990, 50, 50)], [], bounds), [r(990, 990, 10, 10)], 'clipped to the buffer')
})

test('planPatches splits large damage and merges many pieces into their bounding box', () => {
  const bounds = r(0, 0, 1920, 1080)
  const full = planPatches([bounds], [], bounds)
  assert.ok(full.every((patch) => patch.width * patch.height <= MAX_PATCH_PIXELS))
  assert.equal(area(full), 1920 * 1080)

  const scattered = Array.from({ length: 50 }, (_, i) => r(i * 20, 0, 5, 5))
  const merged = planPatches(scattered, [], bounds)
  assert.deepEqual(merged, [r(0, 0, 985, 5)])
})
