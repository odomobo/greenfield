import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FrameCallbackQueue,
  MAX_FRAME_HOLD_MS,
  MAX_FRAME_RATE,
  MIN_FRAME_RATE,
  tickIntervalFor,
} from '../FramePacing.js'

test("a frame callback is held while the surface's stream is not ready and released at the next tick once it is", () => {
  const queue = new FrameCallbackQueue()
  let streamReady = false
  const called: number[] = []
  queue.schedule(
    0,
    () => streamReady,
    (time) => called.push(time),
  )

  queue.tick(16, 100)
  queue.tick(16, 116)
  assert.deepEqual(called, [], 'held while its stream is not ready')
  assert.equal(queue.length, 1)

  streamReady = true
  assert.deepEqual(called, [], 'not between ticks')
  queue.tick(16, 132)
  assert.deepEqual(called, [132])
  assert.equal(queue.length, 0)
})

test('a surface that stays busy still gets a frame callback at least 10 times a second', () => {
  assert.equal(MIN_FRAME_RATE, 10)
  const queue = new FrameCallbackQueue()
  const called: number[] = []
  queue.schedule(
    0,
    () => false,
    (time) => called.push(time),
  )
  let time = 0
  for (let waited = 25; waited < MAX_FRAME_HOLD_MS; waited += 25) {
    queue.tick(25, (time += 25))
  }
  assert.equal(called.length, 0, 'held for less than MAX_FRAME_HOLD_MS')
  queue.tick(25, (time += 25))
  assert.equal(called[0], MAX_FRAME_HOLD_MS)
  // the hold counts only after the minimum wait (no pacing viewer)
  queue.schedule(
    1000,
    () => false,
    (time) => called.push(time),
  )
  for (let i = 0; i < (1000 + MAX_FRAME_HOLD_MS) / 25 - 1; i++) {
    queue.tick(25, (time += 25))
  }
  assert.equal(called.length, 1)
  queue.tick(25, (time += 25))
  assert.equal(called.length, 2)
})

test('a surface streamed as video is never forced: its callback waits until it is ready', () => {
  const queue = new FrameCallbackQueue()
  const called: number[] = []
  let ready = false
  queue.schedule(
    0,
    () => ready,
    (time) => called.push(time),
    () => false,
  )
  for (let time = 25; time <= 4 * MAX_FRAME_HOLD_MS; time += 25) {
    queue.tick(25, time)
  }
  assert.equal(called.length, 0)
  ready = true
  queue.tick(25, 1000)
  assert.deepEqual(called, [1000])
})

test('the viewer decode time delays the callback even when the stream is ready', () => {
  const queue = new FrameCallbackQueue()
  const called: number[] = []
  queue.schedule(
    30,
    () => true,
    (time) => called.push(time),
  )
  queue.tick(16, 1)
  assert.deepEqual(called, [])
  queue.tick(16, 2)
  assert.deepEqual(called, [2])
})

test('callbacks are independent and one scheduled from a callback waits for the next tick', () => {
  const queue = new FrameCallbackQueue()
  const called: string[] = []
  let aFree = false
  queue.schedule(
    0,
    () => aFree,
    () => called.push('a'),
  )
  queue.schedule(
    0,
    () => true,
    () => {
      called.push('b')
      queue.schedule(
        0,
        () => true,
        () => called.push('c'),
      )
    },
  )
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
