import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Patch } from '@gfld/scene-protocol'
import { EncoderPool } from '../EncoderPool.js'
import { CLASS_PERIOD_MS, DEMOTE_HOLD_MS, SurfaceClass } from '../policy.js'
import { area, Rect } from '../region.js'
import {
  BufferInfo,
  EncodingContext,
  EncodingSink,
  MAX_NORMAL_ENCODES,
  PatchPump,
  PatchSource,
  StreamingEncodePool,
  SURFACE_SLOTS,
  SurfaceEncoder,
  SurfaceHost,
} from '../SurfaceEncoder.js'

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

class FakeEncoder {
  keyUnits = 0
  destroyed = false

  requestKeyUnit() {
    this.keyUnits++
  }

  destroy() {
    this.destroyed = true
  }
}

type Held = { surface: string; done: (sent: boolean) => void }

class FakeSink implements EncodingSink {
  active = true
  /** call items' done right away (as if the network took them immediately) */
  autoDone = true
  frames: { surface: string; frame: Uint8Array; surfaceClass: SurfaceClass }[] = []
  patches: { surface: string; patch: Patch; surfaceClass: SurfaceClass }[] = []
  keyFramesRequired: string[] = []
  patchesDropped: string[] = []
  /** items handed over and not yet "sent" (autoDone off) */
  held: Held[] = []

  sendFrame(surface: string, frame: Uint8Array, surfaceClass: SurfaceClass, done: (sent: boolean) => void) {
    this.frames.push({ surface, frame, surfaceClass })
    this.take({ surface, done })
  }

  sendPatch(surface: string, patch: Patch, surfaceClass: SurfaceClass, done: (sent: boolean) => void) {
    this.patches.push({ surface, patch, surfaceClass })
    this.take({ surface, done })
  }

  private take(item: Held) {
    if (this.autoDone) {
      item.done(true)
    } else {
      this.held.push(item)
    }
  }

  /** the network takes everything held, and everything from now on */
  flowFreely() {
    this.autoDone = true
    this.sendHeld()
  }

  /** the network takes everything held */
  sendHeld() {
    for (const item of this.held.splice(0)) {
      item.done(true)
    }
  }

  requireKeyFrame(surface: string) {
    this.keyFramesRequired.push(surface)
  }

  /** like the transport: unsent items of the surface are dropped and reported */
  dropPatches(surface: string) {
    this.patchesDropped.push(surface)
    const dropped = this.held.filter((item) => item.surface === surface)
    this.held = this.held.filter((item) => item.surface !== surface)
    for (const item of dropped) {
      item.done(false)
    }
  }
}

class FakeSurface implements SurfaceHost<FakeEncoder> {
  buffer?: BufferInfo
  readable = true
  reads: Rect[] = []
  encodes: { encoder: FakeEncoder; resolve: (frame: Uint8Array) => void }[] = []
  /** resolve video encodings right away */
  autoEncode = true
  videoEncodes = 0

  constructor(width: number, height: number) {
    this.buffer = { bufferId: 1, creationSerial: 1, contentSerial: 1, width, height }
  }

  currentBuffer() {
    return this.buffer
  }

  readPixels(rect: Rect) {
    if (!this.readable) {
      return undefined
    }
    this.reads.push(rect)
    return new Uint8Array(rect.width * rect.height * 4)
  }

  encodeVideo(encoder: FakeEncoder, buffer: BufferInfo) {
    this.videoEncodes++
    return new Promise<Uint8Array>((resolve) => {
      const frame = new Uint8Array([buffer.contentSerial])
      if (this.autoEncode) {
        resolve(frame)
      } else {
        this.encodes.push({ encoder, resolve })
      }
    })
  }

  /** a new buffer: the client committed */
  touch() {
    this.buffer = { ...this.buffer!, contentSerial: this.buffer!.contentSerial + 1 }
  }
}

class FakeStreamingPool implements StreamingEncodePool {
  canAccept = true
  onCapacity?: () => void
  calls = 0

  async encode(rgba: Uint8Array) {
    this.calls++
    return new Uint8Array([rgba.length & 0xff, 1])
  }

  setCapacity(canAccept: boolean) {
    this.canAccept = canAccept
    this.onCapacity?.()
  }
}

function setup(poolSize = 2) {
  let now = 1000
  const sink = new FakeSink()
  const errors: string[] = []
  let created = 0
  const pool = new EncoderPool(() => {
    created++
    return new FakeEncoder()
  }, poolSize)
  const streaming = new FakeStreamingPool()
  const normalCalls: { width: number; height: number; resolve: () => void }[] = []
  let holdNormal = false
  let normalStarted = 0
  const context = new EncodingContext<FakeEncoder>(
    sink,
    pool,
    {
      normal: (rgba, width, height) => {
        normalStarted++
        if (holdNormal) {
          return new Promise<Uint8Array>((resolve) =>
            normalCalls.push({ width, height, resolve: () => resolve(new Uint8Array([rgba.length & 0xff])) }),
          )
        }
        return Promise.resolve(new Uint8Array([rgba.length & 0xff]))
      },
      streaming,
    },
    { error: (message) => errors.push(message) },
    () => now,
  )
  return {
    sink,
    pool,
    context,
    streaming,
    errors,
    normalCalls,
    get created() {
      return created
    },
    get normalStarted() {
      return normalStarted
    },
    holdNormal(hold: boolean) {
      holdNormal = hold
    },
    advance(ms: number) {
      now += ms
    },
    surface(key: string, width = 1000, height = 1000) {
      const host = new FakeSurface(width, height)
      return { host, encoder: new SurfaceEncoder(key, host, context) }
    },
  }
}

type Env = ReturnType<typeof setup>

const settle = () => new Promise((resolve) => setImmediate(resolve))

const full = (host: FakeSurface) => [r(0, 0, host.buffer!.width, host.buffer!.height)]

/** A relentless surface: full repaints every 50 ms while the network takes nothing, so its patches queue up. */
async function relentless(env: Env, encoder: SurfaceEncoder<FakeEncoder>, host: FakeSurface, ms = CLASS_PERIOD_MS + 100) {
  env.sink.autoDone = false
  for (let t = 0; t < ms; t += 50) {
    env.advance(50)
    host.touch()
    await encoder.commit(full(host))
  }
  await settle()
}

test('a new surface is normal and sends patches, not video', async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  assert.equal(encoder.surfaceClass, 'normal')
  await encoder.commit(full(host))
  await settle()
  await settle()
  assert.equal(env.sink.frames.length, 0)
  assert.deepEqual(env.sink.keyFramesRequired, [])
  assert.equal(area(env.sink.patches.map(({ patch }) => patch.rect)), 1000 * 1000)
  assert.ok(env.sink.patches.every(({ surfaceClass }) => surfaceClass === 'normal'))
  assert.equal(env.pool.available, 2)
  assert.equal(env.streaming.calls, 0, 'normal patches are not encoded by the streaming workers')
})

test('a one-off large repaint of a quiet surface stays normal', async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  env.sink.autoDone = false
  await encoder.commit(full(host))
  await settle()
  // the repaint is slow to go out, but there are no new commits meanwhile
  for (let i = 0; i < 40; i++) {
    env.advance(100)
    env.sink.sendHeld()
    env.context.tick()
    await settle()
  }
  assert.equal(encoder.surfaceClass, 'normal')
})

test('a surface that keeps committing while its patches queue is promoted to streaming, after a whole period', async () => {
  const env = setup(0)
  const { encoder, host } = env.surface('a')
  await relentless(env, encoder, host, CLASS_PERIOD_MS - 100)
  assert.equal(encoder.surfaceClass, 'normal', 'not before a whole period')
  await relentless(env, encoder, host, 300)
  assert.equal(encoder.surfaceClass, 'streaming')
})

test('without a video encoder a streaming surface keeps sending patches, on the low priority workers', async () => {
  const env = setup(0)
  const { encoder, host } = env.surface('a')
  await relentless(env, encoder, host)
  assert.equal(encoder.surfaceClass, 'streaming')
  assert.equal(env.created, 0, 'no video encoder is ever created')
  assert.equal(env.sink.frames.length, 0)
  assert.deepEqual(env.sink.keyFramesRequired, [])
  assert.equal(env.sink.patchesDropped.length, 0, 'a class change without video drops nothing')
  // new patches are streaming class and go to the workers
  const callsBefore = env.streaming.calls
  env.sink.sendHeld()
  await settle()
  await settle()
  assert.ok(env.streaming.calls > callsBefore)
  assert.ok(env.sink.patches.some(({ surfaceClass }) => surfaceClass === 'streaming'))
})

test('with an encoder, promotion switches to video with a key frame and drops the unsent patches', async () => {
  const env = setup(2)
  const { encoder, host } = env.surface('a')
  await relentless(env, encoder, host)
  assert.equal(encoder.surfaceClass, 'streaming')
  assert.ok(encoder.usesVideo)
  assert.equal(env.pool.available, 1, 'one encoder lent out')
  assert.ok(env.sink.patchesDropped.includes('a'))
  assert.ok(env.sink.keyFramesRequired.includes('a'))
  assert.equal(encoder.queuedPatches.length, 0)
  assert.ok(env.sink.frames.length >= 1)
  assert.ok(env.sink.frames.every(({ surfaceClass }) => surfaceClass === 'streaming'))
})

test('a streaming surface stays on patches while all encoders are taken, and takes a freed one', async () => {
  const env = setup(1)
  const a = env.surface('a')
  await relentless(env, a.encoder, a.host)
  assert.ok(a.encoder.usesVideo)

  const b = env.surface('b')
  await relentless(env, b.encoder, b.host)
  assert.equal(b.encoder.surfaceClass, 'streaming')
  assert.ok(!b.encoder.usesVideo, 'the pool is empty: still patches')

  a.encoder.destroy()
  b.host.touch()
  await b.encoder.commit(full(b.host))
  assert.ok(b.encoder.usesVideo, 'takes the freed encoder')
})

test('a quiet streaming surface is demoted after DEMOTE_HOLD_MS and its video is replaced by a crisp image', async () => {
  const env = setup(2)
  const { encoder, host } = env.surface('a')
  await relentless(env, encoder, host)
  assert.ok(encoder.usesVideo)
  env.sink.flowFreely()
  await settle()
  // quiet: ticks only. The fraction falls under 0.4 after ~900 ms, then it must stay below for the hold time.
  let quietMs = 0
  while (encoder.surfaceClass === 'streaming' && quietMs < 20_000) {
    env.advance(200)
    quietMs += 200
    env.context.tick()
    await settle()
  }
  assert.equal(encoder.surfaceClass, 'normal')
  assert.ok(quietMs >= DEMOTE_HOLD_MS)
  assert.ok(!encoder.usesVideo)
  assert.equal(env.pool.available, 2, 'the encoder went back to the pool')
  await settle()
  await settle()
  const covered = env.sink.patches.map(({ patch }) => patch.rect)
  assert.equal(area(covered), 1000 * 1000, 'the whole surface as patches')
  assert.ok(covered.every((rect) => rect.width * rect.height <= 64 * 1024))
})

test('demotion without video changes only the priority', async () => {
  const env = setup(0)
  const { encoder, host } = env.surface('a')
  await relentless(env, encoder, host)
  assert.equal(encoder.surfaceClass, 'streaming')
  env.sink.flowFreely()
  const patchesBefore = env.sink.patches.length
  const queuedBefore = encoder.queuedPatches.length
  let quietMs = 0
  while (encoder.surfaceClass === 'streaming' && quietMs < 20_000) {
    env.advance(200)
    quietMs += 200
    env.context.tick()
    await settle()
  }
  assert.equal(encoder.surfaceClass, 'normal')
  await settle()
  // nothing was re-sent (only what was queued already went out)
  const queuedArea = encoder.queuedPatches.reduce((sum, rect) => sum + rect.width * rect.height, 0)
  assert.equal(queuedArea, 0)
  assert.ok(env.sink.patches.length - patchesBefore <= queuedBefore + SURFACE_SLOTS)
})

test('a surface has at most SURFACE_SLOTS items between capture and the socket', async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  env.sink.autoDone = false
  await encoder.commit(full(host))
  await settle()
  await settle()
  assert.equal(env.sink.held.length, SURFACE_SLOTS)
  assert.equal(host.reads.length, SURFACE_SLOTS)
  assert.ok(!encoder.hasFreeSlot)
  const queued = encoder.queuedPatches.length
  assert.ok(queued > 0)

  // one is handed to the socket: its slot is free, the next patch is captured
  env.sink.held.shift()!.done(true)
  await settle()
  await settle()
  assert.equal(host.reads.length, SURFACE_SLOTS + 1)
  assert.equal(encoder.queuedPatches.length, queued - 1)
  assert.ok(!encoder.hasFreeSlot)

  // everything goes out eventually
  for (let i = 0; i < 100 && encoder.hasUnsentWork; i++) {
    env.sink.sendHeld()
    await settle()
  }
  assert.ok(encoder.hasFreeSlot)
  assert.equal(area(env.sink.patches.map(({ patch }) => patch.rect)), 1000 * 1000)
})

test('a dropped item gives its slot back too', async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  env.sink.autoDone = false
  await encoder.commit(full(host))
  await settle()
  await settle()
  assert.ok(!encoder.hasFreeSlot)
  await encoder.refresh() // drops the unsent patches, queues the whole surface again
  assert.equal(env.sink.patchesDropped.at(-1), 'a')
  await settle()
  assert.equal(env.sink.held.length, SURFACE_SLOTS)
})

test('at most MAX_NORMAL_ENCODES normal patches are encoded at once; streaming ones wait for their workers', async () => {
  const env = setup(0)
  env.holdNormal(true)
  const surfaces = Array.from({ length: 6 }, (_, i) => env.surface(`s${i}`))
  for (const { encoder, host } of surfaces) {
    await encoder.commit(full(host))
  }
  assert.equal(env.normalStarted, MAX_NORMAL_ENCODES)
  assert.equal(env.context.pump.normalEncoding, MAX_NORMAL_ENCODES)
  env.normalCalls.shift()!.resolve()
  await settle()
  assert.equal(env.normalStarted, MAX_NORMAL_ENCODES + 1, 'a finished encode makes room for the next')
  assert.equal(env.streaming.calls, 0)
})

test('a streaming surface captures only while a streaming worker can take its patch', async () => {
  const env = setup(0)
  const { encoder, host } = env.surface('a')
  await relentless(env, encoder, host)
  assert.equal(encoder.surfaceClass, 'streaming')
  env.sink.flowFreely()
  await settle()
  await settle()

  env.streaming.canAccept = false
  const reads = host.reads.length
  host.touch()
  await encoder.commit(full(host))
  await settle()
  assert.equal(host.reads.length, reads, 'nothing is captured while the workers are busy')
  assert.ok(encoder.hasQueuedPatches)

  env.streaming.setCapacity(true)
  await settle()
  assert.ok(host.reads.length > reads)
})

test('new damage over a queued patch is not queued again, over a captured one it is', async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  env.sink.autoDone = false // patches stay unsent, the surface runs out of slots
  await encoder.commit(full(host))
  await settle()
  await settle()
  const queued = encoder.queuedPatches.length
  assert.ok(queued > 0)
  const captured = env.sink.patches.map(({ patch }) => patch.rect)
  assert.equal(captured.length, SURFACE_SLOTS)
  const queuedRect = encoder.queuedPatches[encoder.queuedPatches.length - 1]

  await encoder.commit([r(queuedRect.x + 1, queuedRect.y + 1, 10, 10)])
  assert.equal(encoder.queuedPatches.length, queued, 'a queued patch will pick up the latest pixels')

  await encoder.commit([r(captured[0].x + 1, captured[0].y + 1, 10, 10)])
  assert.equal(encoder.queuedPatches.length, queued + 1, 'a captured patch may be stale, queue again')
  assert.deepEqual(encoder.queuedPatches[queued], r(captured[0].x + 1, captured[0].y + 1, 10, 10))
})

test('video that finishes encoding after the surface was destroyed is dropped and gives its slot back', async () => {
  const env = setup(2)
  const { encoder, host } = env.surface('a')
  await relentless(env, encoder, host)
  assert.ok(encoder.usesVideo)
  env.sink.flowFreely()
  await settle()
  host.autoEncode = false
  host.touch()
  void encoder.commit(full(host))
  const framesBefore = env.sink.frames.length
  assert.equal(host.encodes.length, 1)
  assert.ok(!encoder.hasFreeSlot || encoder.hasUnsentWork)
  encoder.destroy()
  host.encodes[0].resolve(new Uint8Array([1]))
  await settle()
  assert.equal(env.sink.frames.length, framesBefore, 'the stale frame is not sent')
  assert.ok(encoder.hasFreeSlot)
  assert.equal(env.pool.available, 2)
})

test('a video frame wanted while both slots are taken is encoded when one frees up', async () => {
  const env = setup(2)
  const { encoder, host } = env.surface('a')
  await relentless(env, encoder, host)
  assert.ok(encoder.usesVideo)
  await settle()
  // fill both slots with frames the network doesn't take
  while (encoder.hasFreeSlot) {
    host.touch()
    await encoder.commit(full(host))
    await settle()
  }
  const encodes = host.videoEncodes
  host.touch()
  await encoder.commit(full(host))
  assert.equal(host.videoEncodes, encodes, 'no slot, no encode')
  assert.ok(encoder.hasUnsentWork)
  env.sink.held.shift()!.done(true)
  await settle()
  assert.equal(host.videoEncodes, encodes + 1, 'the latest content is encoded once a slot is free')
})

test('small surfaces are never video, whatever their class', async () => {
  const env = setup()
  const { encoder, host } = env.surface('cursor', 64, 64)
  await relentless(env, encoder, host)
  assert.equal(encoder.surfaceClass, 'streaming')
  assert.ok(!encoder.usesVideo)
  assert.equal(env.pool.available, 2)
  assert.equal(env.sink.frames.length, 0)
  assert.ok(env.sink.patches.length > 0)
})

test('empty damage sends nothing', async () => {
  const env = setup()
  const { encoder } = env.surface('a')
  await encoder.commit([])
  await encoder.commit([r(2000, 2000, 10, 10)])
  await settle()
  assert.equal(env.sink.frames.length + env.sink.patches.length, 0)
})

test('only the damage is sent', async () => {
  const env = setup()
  const { encoder } = env.surface('a')
  await encoder.commit([r(1, 2, 3, 4)])
  await settle()
  assert.deepEqual(
    env.sink.patches.map(({ patch }) => patch.rect),
    [r(1, 2, 3, 4)],
  )
})

test('a buffer that cannot be read is streamed as video, whatever its class, even beyond the pool', async () => {
  const env = setup(1)
  const a = env.surface('a')
  await relentless(env, a.encoder, a.host)
  assert.ok(a.encoder.usesVideo)
  env.sink.flowFreely()
  const b = env.surface('b')
  b.host.readable = false
  await b.encoder.commit(full(b.host))
  await settle()
  await settle()
  assert.equal(b.encoder.surfaceClass, 'normal')
  assert.ok(b.encoder.usesVideo)
  assert.ok(env.sink.frames.some((frame) => frame.surface === 'b'))
  assert.equal(env.errors.length, 0)
})

test('without a video encoder a buffer that cannot be read is not shown: logged once, nothing sent', async () => {
  const env = setup(0)
  const { encoder, host } = env.surface('a')
  host.readable = false
  await encoder.commit(full(host))
  await settle()
  host.touch()
  await encoder.commit(full(host))
  await settle()
  await encoder.refresh()
  await settle()
  assert.equal(env.sink.frames.length + env.sink.patches.length, 0)
  assert.equal(env.errors.length, 1)
  assert.match(env.errors[0], /\ba\b/)
  assert.equal(env.created, 0)
})

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

test('refresh resends the whole surface, as a key frame for video and as patches otherwise', async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  await encoder.commit(full(host))
  await settle()
  env.sink.patches.length = 0
  await encoder.refresh()
  await settle()
  await settle()
  assert.equal(area(env.sink.patches.map(({ patch }) => patch.rect)), 1000 * 1000)

  await relentless(env, encoder, host)
  assert.ok(encoder.usesVideo)
  env.sink.flowFreely()
  const keyFrames = env.sink.keyFramesRequired.length
  await encoder.refresh()
  await settle()
  assert.equal(env.sink.keyFramesRequired.length, keyFrames + 1)
})

test('nothing is encoded without a viewer', async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  env.sink.active = false
  await encoder.commit(full(host))
  await settle()
  assert.equal(host.reads.length, 0)
  assert.equal(env.sink.patches.length + env.sink.frames.length, 0)
})

test("a surface's patches are sent in capture order, even when their encodings finish out of order", async () => {
  const sink = new FakeSink()
  const encodings: ((png: Uint8Array) => void)[] = []
  const streaming = new FakeStreamingPool()
  const pump = new PatchPump(
    sink,
    () => new Promise<Uint8Array>((resolve) => encodings.push(resolve)),
    streaming,
    { error: () => undefined },
  )
  const rects = [r(0, 0, 100, 100), r(10, 10, 5, 5)]
  let serial = 0
  let slots = 0
  const source: PatchSource = {
    key: 'a',
    destroyed: false,
    surfaceClass: 'normal',
    get hasQueuedPatches() {
      return serial < rects.length
    },
    get hasFreeSlot() {
      return slots < SURFACE_SLOTS
    },
    capturePatch() {
      slots++
      const rect = rects[serial++]
      return {
        rect,
        pixels: new Uint8Array(4),
        surfaceSize: { width: 100, height: 100 },
        serial,
        epoch: 0,
        surfaceClass: 'normal',
      }
    },
    releaseSlot() {
      slots--
    },
    isCurrent: () => true,
  }
  pump.schedule(source)
  assert.equal(encodings.length, 2)
  // the newer, smaller patch finishes encoding first
  encodings[1](new Uint8Array([2]))
  await settle()
  assert.equal(sink.patches.length, 0)
  encodings[0](new Uint8Array([1]))
  await settle()
  assert.deepEqual(
    sink.patches.map(({ patch }) => patch.contentSerial),
    [1, 2],
  )
  assert.equal(slots, 0)
  assert.equal(pump.normalEncoding, 0)
})
