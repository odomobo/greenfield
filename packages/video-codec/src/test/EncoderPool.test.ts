import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EncoderPool } from '../EncoderPool.js'

class FakeEncoder {
  destroyed = false

  destroy() {
    this.destroyed = true
  }
}

test('an encoder that cannot be created is reported once and the pool behaves as empty', async () => {
  let reported = 0
  const pool = new EncoderPool<FakeEncoder>(
    () => {
      throw new Error('no device')
    },
    4,
    () => reported++,
  )
  pool.warm()
  assert.equal(pool.size, 0)
  assert.equal(pool.available, 0)
  assert.equal(pool.acquire(), undefined)
  assert.equal(pool.acquireAlways(), undefined)
  assert.equal(reported, 1)
})

test('a size 0 pool never creates an encoder', async () => {
  let created = 0
  const pool = new EncoderPool<FakeEncoder>(() => {
    created++
    return new FakeEncoder()
  }, 0)
  pool.warm()
  assert.equal(pool.acquire(), undefined)
  assert.equal(pool.acquireAlways(), undefined)
  assert.equal(pool.size, 0)
  assert.equal(created, 0)
})

test('encoders are lent one at a time; one beyond the size is destroyed when released', () => {
  const pool = new EncoderPool<FakeEncoder>(() => new FakeEncoder(), 1)
  const first = pool.acquire()
  assert.ok(first)
  assert.equal(pool.available, 0)
  assert.equal(pool.acquire(), undefined)
  const extra = pool.acquireAlways()
  assert.ok(extra && extra !== first)
  pool.release(extra)
  assert.ok(extra.destroyed)
  pool.release(first)
  assert.ok(!first.destroyed)
  assert.equal(pool.available, 1)
  assert.equal(pool.acquire(), first)
})
