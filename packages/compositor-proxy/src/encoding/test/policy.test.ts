import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DamageMeter,
  FAST_ABOVE_PIXELS_PER_SECOND,
  INITIAL_FAST_MS,
  MAX_PATCH_PIXELS,
  MEASURE_PERIOD_MS,
  nextMode,
  planPatches,
  SLOW_BELOW_PIXELS_PER_SECOND,
} from '../policy.js'
import { area, Rect } from '../region.js'

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

test('the single largest damage in the period is ignored', () => {
  const meter = new DamageMeter()
  meter.record(0, 2_000_000)
  assert.equal(meter.pixelsPerSecond(100), 0, 'one full repaint alone is not busy')
  meter.record(200, 1000)
  meter.record(300, 1000)
  // 2M ignored, 2000 px over the period
  assert.equal(meter.pixelsPerSecond(400), (2000 * 1000) / MEASURE_PERIOD_MS)
  // the others count: a few full repaints per period are busy
  meter.record(500, 2_000_000)
  meter.record(550, 2_000_000)
  assert.ok(meter.pixelsPerSecond(600) > FAST_ABOVE_PIXELS_PER_SECOND)
})

test('damage older than the period is forgotten', () => {
  const meter = new DamageMeter()
  for (let t = 0; t < 1000; t += 16) {
    meter.record(t, 500_000)
  }
  assert.ok(meter.pixelsPerSecond(1000) > FAST_ABOVE_PIXELS_PER_SECOND)
  assert.equal(meter.pixelsPerSecond(1000 + MEASURE_PERIOD_MS), 0)
})

test('a young surface is measured over its age, but at least INITIAL_FAST_MS', () => {
  const meter = new DamageMeter(1000)
  meter.record(1000, 100) // largest, ignored
  meter.record(1050, 30)
  meter.record(1100, 30)
  assert.equal(meter.pixelsPerSecond(1100), (60 * 1000) / INITIAL_FAST_MS)
  assert.equal(meter.pixelsPerSecond(1000 + 600), (60 * 1000) / 600)
  assert.equal(meter.pixelsPerSecond(1000 + MEASURE_PERIOD_MS - 1), (60 * 1000) / (MEASURE_PERIOD_MS - 1))
  // older than a period: measured over the period, 1000 and 1050 have dropped out, 2400 is the largest
  meter.record(2400, 100)
  assert.equal(meter.pixelsPerSecond(2560), (30 * 1000) / MEASURE_PERIOD_MS)
})

test('mode switches with hysteresis', () => {
  const between = (FAST_ABOVE_PIXELS_PER_SECOND + SLOW_BELOW_PIXELS_PER_SECOND) / 2
  assert.equal(nextMode('fast', between), 'fast')
  assert.equal(nextMode('slow', between), 'slow')
  assert.equal(nextMode('fast', SLOW_BELOW_PIXELS_PER_SECOND - 1), 'slow')
  assert.equal(nextMode('slow', FAST_ABOVE_PIXELS_PER_SECOND + 1), 'fast')
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
