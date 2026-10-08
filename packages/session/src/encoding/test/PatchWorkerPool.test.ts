import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodePatch } from '../patch-encoder.js'
import { NORMAL_ENCODE_NICE, PatchWorkerPool, STREAMING_ENCODE_NICE, STREAMING_ENCODE_WORKERS } from '../PatchWorkerPool.js'

const logger = { error: (message: string) => process.stderr.write(`${message}\n`) }

/** The nice value of a thread of this process (field 19 of /proc/self/task/<tid>/stat, after the "(comm)"). */
function niceOf(tid: number): number {
  const stat = readFileSync(`/proc/self/task/${tid}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  // fields[0] is the state (field 3), so field 19 (nice) is fields[16]
  return Number(fields[16])
}

function pixels(width: number, height: number, seed = 1): Uint8Array {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < data.length; i++) {
    data[i] = (i * seed + (i >> 5)) & 0xff
  }
  return data
}

test('the worker threads really run at nice 19, the main thread does not', async () => {
  const pool = new PatchWorkerPool(logger)
  try {
    const tids = await pool.threadIds()
    assert.equal(tids.length, STREAMING_ENCODE_WORKERS)
    assert.equal(new Set(tids).size, tids.length)
    for (const tid of tids) {
      assert.ok(tid > 0, `setThreadNice returned ${tid}`)
      assert.equal(niceOf(tid), STREAMING_ENCODE_NICE)
    }
    assert.ok(niceOf(process.pid) < STREAMING_ENCODE_NICE, 'the process itself is not niced')
  } finally {
    pool.destroy()
  }
})

test('a normal pool runs its threads at normal priority', async () => {
  const pool = new PatchWorkerPool(logger, 2, NORMAL_ENCODE_NICE)
  try {
    for (const tid of await pool.threadIds()) {
      assert.ok(tid > 0)
      assert.equal(niceOf(tid), niceOf(process.pid))
    }
  } finally {
    pool.destroy()
  }
})

test("a worker's patch is byte for byte what the native encoder produces", async () => {
  const pool = new PatchWorkerPool(logger)
  try {
    for (const [width, height, seed] of [
      [1, 1, 3],
      [64, 32, 7],
      [256, 256, 1],
    ]) {
      const rgba = pixels(width, height, seed)
      for (const opaque of [false, true]) {
        const expected = encodePatch(rgba, width, height, opaque)
        const encoded = await pool.encode(new Uint8Array(rgba), width, height, opaque)
        assert.deepEqual(encoded, expected)
      }
    }
  } finally {
    pool.destroy()
  }
})

test('the pixels may be a slice of a larger buffer (it is copied, not transferred)', async () => {
  const pool = new PatchWorkerPool(logger)
  try {
    const rgba = pixels(16, 16, 5)
    const big = new Uint8Array(rgba.length + 100)
    big.set(rgba, 50)
    const slice = big.subarray(50, 50 + rgba.length)
    const encoded = await pool.encode(slice, 16, 16, false)
    assert.deepEqual(encoded, encodePatch(rgba, 16, 16, false))
    assert.equal(big.buffer.byteLength, rgba.length + 100, 'the shared buffer is untouched')
  } finally {
    pool.destroy()
  }
})

test('at most one patch per worker is encoding and one waiting; capacity is reported when one finishes', async () => {
  const pool = new PatchWorkerPool(logger)
  try {
    assert.ok(pool.canAccept)
    let capacity = 0
    pool.onCapacity = () => capacity++
    const jobs: Promise<unknown>[] = []
    for (let i = 0; i < STREAMING_ENCODE_WORKERS * 2; i++) {
      assert.ok(pool.canAccept)
      jobs.push(pool.encode(pixels(128, 128, i + 1), 128, 128, false))
    }
    assert.ok(!pool.canAccept)
    assert.equal(pool.outstanding, STREAMING_ENCODE_WORKERS * 2)
    const results = await Promise.all(jobs)
    assert.equal(results.length, STREAMING_ENCODE_WORKERS * 2)
    assert.equal(pool.outstanding, 0)
    assert.ok(pool.canAccept)
    assert.ok(capacity >= STREAMING_ENCODE_WORKERS * 2)
  } finally {
    pool.destroy()
  }
})

test('an invalid job fails without breaking the worker', async () => {
  const pool = new PatchWorkerPool(logger, 1)
  try {
    await assert.rejects(pool.encode(new Uint8Array(3), 4, 4, false), /don't match/)
    const rgba = pixels(8, 8)
    // (the buffer is transferred to the worker, so give it a copy)
    assert.deepEqual(await pool.encode(new Uint8Array(rgba), 8, 8, false), encodePatch(rgba, 8, 8, false))
  } finally {
    pool.destroy()
  }
})
