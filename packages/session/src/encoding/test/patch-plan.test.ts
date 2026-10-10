import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Rect } from '@nebula/session-contracts'
import { MAX_PATCH_PIXELS, planPatches } from '../patch-plan.js'
import { area } from '../region.js'

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

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
