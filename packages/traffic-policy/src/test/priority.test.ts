import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLASS_PERIOD_MS, DEMOTE_FRACTION, PROMOTE_FRACTION, RelentlessMeter } from '../priority.js'

const P = CLASS_PERIOD_MS

/** Drives a meter like a surface does: a clock that ticks every 5 ms, calling `each` and then evaluating at each. */
function clock(meter: RelentlessMeter) {
  let now = 0
  return {
    get now() {
      return now
    },
    run(ms: number, each: (now: number) => void = () => undefined) {
      const end = now + ms
      while (now < end) {
        now += 5
        each(now)
        meter.evaluate(now)
      }
    },
  }
}

/**
 * A callback-paced client: a commit every 50 ms (backlogged if the last period was busy enough), each draining `idleMs`
 * before the next one.
 */
function paced(meter: RelentlessMeter, idleMs: number) {
  return (now: number) => {
    const phase = now % 50
    if (phase === 0) {
      meter.markBackloggedStart(now)
      meter.markBusyStart(now)
    } else if (idleMs > 0 && phase === 50 - idleMs) {
      meter.markBusyEnd(now)
    }
  }
}

test('nothing happens before two periods have completed', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  time.run(2 * P - 50, paced(meter, 0))
  assert.equal(meter.surfaceClass, 'normal')
  assert.ok(meter.lastPeriod!.busy > 0.9)
  assert.equal(meter.lastPeriod?.backlogged, 0, 'a commit needs a completed previous period to be backlogged')
})

test('a callback-paced relentless client is promoted at the end of its second period', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  time.run(2 * P - 50, paced(meter, 0))
  assert.equal(meter.surfaceClass, 'normal')
  time.run(50, paced(meter, 0))
  assert.equal(meter.surfaceClass, 'streaming')
  assert.ok(meter.lastPeriod!.backlogged >= PROMOTE_FRACTION)
})

test('a paced client that drains a little before each next commit is still promoted', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  // busy 90% of the time: the next commit comes 5 ms after it drained
  time.run(2 * P, paced(meter, 5))
  assert.equal(meter.surfaceClass, 'streaming')
})

test('a one-off big repaint is never backlogged, however long it takes to drain', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  time.run(3 * P)
  // a single damage after quiet periods, draining over several periods with no further commits
  meter.markBackloggedStart(time.now)
  meter.markBusyStart(time.now)
  assert.ok(!meter.backlogged)
  time.run(4 * P)
  assert.equal(meter.surfaceClass, 'normal')
  assert.equal(meter.lastPeriod?.busy, 1)
  assert.equal(meter.lastPeriod?.backlogged, 0)
  meter.markBusyEnd(time.now)
  time.run(2 * P)
  assert.equal(meter.surfaceClass, 'normal')
})

test('a needy client under the busy threshold stays normal, however often it commits', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  // busy 40% of each frame
  time.run(10 * P, paced(meter, 30))
  assert.ok(meter.lastPeriod!.busy < PROMOTE_FRACTION)
  assert.equal(meter.surfaceClass, 'normal')
})

test('a surface is backlogged only after a period that was busy at least PROMOTE_FRACTION', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  // first period busy 55%: below
  meter.markBusyStart(0)
  time.run(P * 0.55)
  meter.markBusyEnd(time.now)
  time.run(P * 0.45)
  assert.ok(meter.lastPeriod!.busy < PROMOTE_FRACTION)
  meter.markBackloggedStart(time.now)
  assert.ok(!meter.backlogged)
  // a period busy 65%: above
  meter.markBusyStart(time.now)
  time.run(P * 0.65)
  meter.markBusyEnd(time.now)
  time.run(P * 0.35)
  assert.ok(meter.lastPeriod!.busy >= PROMOTE_FRACTION)
  meter.markBackloggedStart(time.now)
  assert.ok(meter.backlogged)
  meter.markBusyEnd(time.now + 10)
  assert.ok(!meter.backlogged, 'backlogged ends when the surface is not busy anymore')
})

test('a quiet streaming surface is demoted at the end of the first period below DEMOTE_FRACTION', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  time.run(2 * P, paced(meter, 0))
  assert.equal(meter.surfaceClass, 'streaming')
  meter.markBusyEnd(time.now)
  time.run(P - 50)
  assert.equal(meter.surfaceClass, 'streaming', 'judged only at the end of a period')
  time.run(50)
  assert.equal(meter.surfaceClass, 'normal')
  assert.ok(meter.lastPeriod!.backlogged < DEMOTE_FRACTION)
})

test('a streaming surface that is busy and backlogged most of each period stays streaming', () => {
  const meter = new RelentlessMeter(0)
  const time = clock(meter)
  time.run(2 * P, paced(meter, 0))
  assert.equal(meter.surfaceClass, 'streaming')
  // busy 70% of each period, with gaps of 30%
  for (let i = 0; i < 6; i++) {
    time.run(P * 0.7, paced(meter, 0))
    meter.markBusyEnd(time.now)
    time.run(P * 0.3)
  }
  assert.ok(meter.lastPeriod!.backlogged >= DEMOTE_FRACTION)
  assert.equal(meter.surfaceClass, 'streaming')
})
