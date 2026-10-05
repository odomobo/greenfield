import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FrameCallbackQueue, MAX_FRAME_RATE, tickIntervalFor } from '../../FramePacing.js'

test('a frame callback is held while the surface has no free slot and released at the next tick once it has one', () => {
  const queue = new FrameCallbackQueue()
  let slotFree = false
  const called: number[] = []
  queue.schedule(0, () => slotFree, (time) => called.push(time))

  queue.tick(16, 100)
  queue.tick(16, 116)
  assert.deepEqual(called, [], 'held while both slots are taken')
  assert.equal(queue.length, 1)

  slotFree = true
  assert.deepEqual(called, [], 'not between ticks')
  queue.tick(16, 132)
  assert.deepEqual(called, [132])
  assert.equal(queue.length, 0)
})

test('the viewer decode time delays the callback even when a slot is free', () => {
  const queue = new FrameCallbackQueue()
  const called: number[] = []
  queue.schedule(30, () => true, (time) => called.push(time))
  queue.tick(16, 1)
  assert.deepEqual(called, [])
  queue.tick(16, 2)
  assert.deepEqual(called, [2])
})

test('callbacks are independent and one scheduled from a callback waits for the next tick', () => {
  const queue = new FrameCallbackQueue()
  const called: string[] = []
  let aFree = false
  queue.schedule(0, () => aFree, () => called.push('a'))
  queue.schedule(0, () => true, () => {
    called.push('b')
    queue.schedule(0, () => true, () => called.push('c'))
  })
  queue.tick(16, 1)
  assert.deepEqual(called, ['b'])
  aFree = true
  queue.tick(16, 2)
  assert.deepEqual(called, ['b', 'a', 'c'])
})

test('the frame clock ticks at most 30 times a second, slower only for a slower display', () => {
  assert.equal(MAX_FRAME_RATE, 30)
  // a 60 Hz or 144 Hz display, or none reported yet: 30 Hz
  assert.equal(tickIntervalFor(16.667), 1000 / 30)
  assert.equal(tickIntervalFor(6.944), 1000 / 30)
  assert.equal(tickIntervalFor(0), 1000 / 30)
  // a display refreshing 24 times a second: its rate
  assert.equal(tickIntervalFor(41.667), 41.667)
})
