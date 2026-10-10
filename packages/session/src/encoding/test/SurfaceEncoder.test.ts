import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Patch, PatchFormat } from '@gfld/scene-protocol'
import type { EncodedPatch, Frame, Rect, SendTier, SurfaceClass } from '@nebula/session-contracts'
import { EncoderPool } from '@nebula/video-codec'
import { CLASS_PERIOD_MS } from '../policy.js'
import { area } from '../region.js'
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
  VideoQuality,
} from '../SurfaceEncoder.js'

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

class FakeEncoder {
  keyUnits = 0
  destroyed = false
  quality: VideoQuality = 'high'

  requestKeyUnit() {
    this.keyUnits++
  }

  setQuality(quality: VideoQuality) {
    this.quality = quality
  }

  destroy() {
    this.destroyed = true
  }
}

type Held = { surface: string; done: (sent: boolean) => void; bytes: number }

class FakeSink implements EncodingSink {
  active = true
  bandwidthLimited = false
  linkBandwidth: number | undefined = undefined
  /** call items' done right away (as if the network took them immediately) */
  autoDone = true
  frames: { surface: string; frame: Uint8Array; surfaceClass: SurfaceClass }[] = []
  patches: { surface: string; patch: Patch; tier: SendTier }[] = []
  /** items handed over and not yet "sent" (autoDone off) */
  held: Held[] = []

  sendFrame(surface: string, frame: Uint8Array, surfaceClass: SurfaceClass, done: (sent: boolean) => void) {
    this.frames.push({ surface, frame, surfaceClass })
    this.take({ surface, done, bytes: frame.length })
  }

  sendPatch(surface: string, patch: Patch, tier: SendTier, done: (sent: boolean) => void) {
    this.patches.push({ surface, patch, tier })
    this.take({ surface, done, bytes: tier === 'settle' ? 0 : patch.data.length })
  }

  /** like the transport: what's held of the surface, except settling patches */
  queuedBytes(surface: string) {
    return this.held.filter((item) => item.surface === surface).reduce((sum, { bytes }) => sum + bytes, 0)
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

  /** the network went away: everything held is reported unsent (the only time the transport does that) */
  dropHeld() {
    for (const item of this.held.splice(0)) {
      item.done(false)
    }
  }
}

class FakeSurface implements SurfaceHost<FakeEncoder> {
  buffer?: BufferInfo
  readable = true
  opaque = false
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

  /** frames taken and not released yet */
  heldFrames = 0
  framesTaken = 0

  takeFrame(): Frame | undefined {
    const buffer = this.buffer
    if (buffer === undefined) {
      return undefined
    }
    this.heldFrames++
    this.framesTaken++
    let released = false
    return {
      width: buffer.width,
      height: buffer.height,
      contentSerial: buffer.contentSerial,
      readPixels: (rect: Rect) => {
        if (!this.readable || released) {
          return undefined
        }
        this.reads.push(rect)
        return { pixels: new Uint8Array(rect.width * rect.height * 4), opaque: this.opaque }
      },
      release: () => {
        if (!released) {
          released = true
          this.heldFrames--
        }
      },
    }
  }

  /** like the video codec: the frame is released once encoded */
  encodeVideo(encoder: FakeEncoder, frame: Frame) {
    this.videoEncodes++
    return new Promise<Uint8Array>((resolve) => {
      const encoded = new Uint8Array([frame.contentSerial])
      const done = (result: Uint8Array) => {
        frame.release()
        resolve(result)
      }
      if (this.autoEncode) {
        done(encoded)
      } else {
        this.encodes.push({ encoder, resolve: done })
      }
    })
  }

  /** a new buffer: the client committed */
  touch() {
    this.buffer = { ...this.buffer!, contentSerial: this.buffer!.contentSerial + 1 }
  }
}

/** what the encoders return in these tests: the bytes are not looked at */
function fakeEncoded(data: Uint8Array): EncodedPatch {
  return { format: PatchFormat.QOI, channels: 4, data }
}

class FakeStreamingPool implements StreamingEncodePool {
  canAccept = true
  onCapacity?: () => void
  calls = 0
  lossyCalls = 0
  /** a lossy encode comes out as JPEG (smaller than lossless), else as the lossless QOI */
  jpegWins = true

  async encode(rgba: Uint8Array, _width: number, _height: number, _opaque: boolean, lossy = false) {
    this.calls++
    if (lossy) {
      this.lossyCalls++
      if (this.jpegWins) {
        return { format: PatchFormat.JPEG_ALPHA, channels: 4 as const, data: new Uint8Array([rgba.length & 0xff, 2]) }
      }
    }
    return fakeEncoded(new Uint8Array([rgba.length & 0xff, 1]))
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
  const infos: string[] = []
  let created = 0
  const encoders: FakeEncoder[] = []
  const pool = new EncoderPool(() => {
    created++
    const encoder = new FakeEncoder()
    encoders.push(encoder)
    return encoder
  }, poolSize)
  const streaming = new FakeStreamingPool()
  const normalCalls: { width: number; height: number; resolve: () => void }[] = []
  let holdNormal = false
  let normalStarted = 0
  const opaqueSeen: boolean[] = []
  const context = new EncodingContext<FakeEncoder>(
    sink,
    pool,
    {
      normal: (rgba, width, height, opaque) => {
        normalStarted++
        opaqueSeen.push(opaque)
        if (holdNormal) {
          return new Promise<EncodedPatch>((resolve) =>
            normalCalls.push({
              width,
              height,
              resolve: () => resolve(fakeEncoded(new Uint8Array([rgba.length & 0xff]))),
            }),
          )
        }
        return Promise.resolve(fakeEncoded(new Uint8Array([rgba.length & 0xff])))
      },
      streaming,
    },
    { error: (message) => errors.push(message), info: (message) => infos.push(message) },
    () => now,
  )
  return {
    sink,
    pool,
    encoders,
    context,
    streaming,
    errors,
    infos,
    normalCalls,
    opaqueSeen,
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
async function relentless(
  env: Env,
  encoder: SurfaceEncoder<FakeEncoder>,
  host: FakeSurface,
  ms = 2 * CLASS_PERIOD_MS + 100,
) {
  env.sink.autoDone = false
  for (let t = 0; t < ms; t += 50) {
    env.advance(50)
    host.touch()
    await encoder.commit(full(host))
  }
  await settle()
}

test("a patch reads its pixels from a frame, released right after the read (not held while it's encoded)", async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  env.sink.autoDone = false
  await encoder.commit(full(host))
  assert.ok(host.framesTaken > 0)
  assert.equal(host.framesTaken, host.reads.length)
  assert.equal(host.heldFrames, 0)
  await settle()
  assert.equal(host.heldFrames, 0)
})

test("the opaque flag the host reports for a patch's pixels goes to the encoder", async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  host.opaque = true
  await encoder.commit(full(host))
  await settle()
  assert.ok(env.opaqueSeen.length > 0)
  assert.ok(env.opaqueSeen.every((opaque) => opaque))
  env.opaqueSeen.length = 0
  host.opaque = false
  host.touch()
  await encoder.commit(full(host))
  await settle()
  assert.ok(env.opaqueSeen.length > 0)
  assert.ok(env.opaqueSeen.every((opaque) => !opaque))
})

test('a new surface is normal and sends patches, not video', async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  assert.equal(encoder.surfaceClass, 'normal')
  await encoder.commit(full(host))
  await settle()
  await settle()
  assert.equal(env.sink.frames.length, 0)
  assert.equal(area(env.sink.patches.map(({ patch }) => patch.rect)), 1000 * 1000)
  assert.ok(env.sink.patches.every(({ tier }) => tier === 'normal'))
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
  await relentless(env, encoder, host, 2 * CLASS_PERIOD_MS - 100)
  assert.equal(encoder.surfaceClass, 'normal', 'not before two whole periods')
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
  // new patches are streaming class and go to the workers
  const callsBefore = env.streaming.calls
  env.sink.sendHeld()
  await settle()
  await settle()
  assert.ok(env.streaming.calls > callsBefore)
  assert.ok(env.sink.patches.some(({ tier }) => tier === 'streaming'))
})

test('with an encoder, promotion switches to video with a key frame, after the patches already handed over', async () => {
  const env = setup(2)
  const { encoder, host } = env.surface('a')
  await relentless(env, encoder, host)
  assert.equal(encoder.surfaceClass, 'streaming')
  assert.ok(encoder.usesVideo)
  assert.equal(env.pool.available, 1, 'one encoder lent out')
  assert.ok(
    env.encoders.some(({ keyUnits }) => keyUnits >= 1),
    'the first frame is a key frame',
  )
  assert.equal(encoder.queuedPatches.length, 0, 'patches not handed over yet are superseded')
  // the patches handed over are not taken back: they go out first, the key frame paints over them
  const heldPatches = env.sink.held.length
  assert.ok(heldPatches > 0)
  assert.equal(env.sink.frames.length, 0, 'the key frame waits for a slot')
  env.sink.sendHeld()
  await settle()
  await settle()
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

test('a quiet streaming surface is demoted within two periods and its video is replaced by a crisp image', async () => {
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
  assert.ok(quietMs <= 2 * CLASS_PERIOD_MS, `demoted after ${quietMs} ms`)
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

test('an item reported unsent gives its slot back too', async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  env.sink.autoDone = false
  await encoder.commit(full(host))
  await settle()
  await settle()
  assert.ok(!encoder.hasFreeSlot)
  assert.ok(encoder.hasQueuedPatches)
  const handedOver = env.sink.patches.length
  env.sink.dropHeld()
  await settle()
  assert.equal(env.sink.held.length, SURFACE_SLOTS, 'the next queued patches take the slots')
  assert.equal(env.sink.patches.length, handedOver + SURFACE_SLOTS)
})

test('refresh takes back nothing handed over: the whole surface is queued behind it', async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  env.sink.autoDone = false
  await encoder.commit(full(host))
  await settle()
  await settle()
  const handedOver = env.sink.patches.length
  const held = [...env.sink.held]
  assert.equal(held.length, SURFACE_SLOTS)
  await encoder.refresh()
  await settle()
  assert.deepEqual(env.sink.held, held, 'still waiting to go out')
  assert.equal(env.sink.patches.length, handedOver, 'the refresh waits for a slot')
  assert.equal(area([...encoder.queuedPatches]), 1000 * 1000)
  env.sink.flowFreely()
  for (let i = 0; i < 20 && encoder.hasQueuedPatches; i++) {
    await settle()
  }
  assert.equal(area(env.sink.patches.slice(handedOver).map(({ patch }) => patch.rect)), 1000 * 1000)
})

test('destroying a surface takes back nothing handed over', async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  env.sink.autoDone = false
  await encoder.commit(full(host))
  await settle()
  await settle()
  const patches = env.sink.patches.length
  assert.equal(env.sink.held.length, SURFACE_SLOTS)
  encoder.destroy()
  assert.equal(env.sink.held.length, SURFACE_SLOTS, 'its items still go out, the viewer ignores them')
  env.sink.flowFreely()
  await settle()
  await settle()
  assert.equal(env.sink.patches.length, patches, 'nothing new of it is captured')
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

test('each video frame is encoded from a frame of the buffer, held only while it is encoded', async () => {
  const env = setup(2)
  const { encoder, host } = env.surface('a')
  await relentless(env, encoder, host)
  assert.ok(encoder.usesVideo)
  env.sink.flowFreely()
  await settle()
  assert.equal(host.heldFrames, 0)
  host.autoEncode = false
  host.touch()
  void encoder.commit(full(host))
  assert.equal(host.encodes.length, 1)
  assert.equal(host.heldFrames, 1, 'the frame being encoded')
  host.encodes[0].resolve(new Uint8Array([1]))
  await settle()
  assert.equal(host.heldFrames, 0)
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
  const keyUnits = () => env.encoders.reduce((sum, { keyUnits }) => sum + keyUnits, 0)
  const keyFrames = keyUnits()
  const frames = env.sink.frames.length
  await encoder.refresh()
  await settle()
  assert.equal(keyUnits(), keyFrames + 1, 'the next frame is a key frame')
  assert.ok(env.sink.frames.length > frames)
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
  const encodings: ((encoded: EncodedPatch) => void)[] = []
  const streaming = new FakeStreamingPool()
  const pump = new PatchPump(sink, () => new Promise<EncodedPatch>((resolve) => encodings.push(resolve)), streaming, {
    error: () => undefined,
  })
  const rects = [r(0, 0, 100, 100), r(10, 10, 5, 5)]
  let serial = 0
  let slots = 0
  const source: PatchSource = {
    key: 'a',
    destroyed: false,
    sendTier: 'normal',
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
        opaque: false,
        surfaceSize: { width: 100, height: 100 },
        serial,
        epoch: 0,
        tier: 'normal',
        lossy: false,
      }
    },
    patchSending: () => undefined,
    releaseSlot() {
      slots--
    },
    isCurrent: () => true,
  }
  pump.schedule(source)
  assert.equal(encodings.length, 2)
  // the newer, smaller patch finishes encoding first
  encodings[1](fakeEncoded(new Uint8Array([2])))
  await settle()
  assert.equal(sink.patches.length, 0)
  encodings[0](fakeEncoded(new Uint8Array([1])))
  await settle()
  assert.deepEqual(
    sink.patches.map(({ patch }) => patch.contentSerial),
    [1, 2],
  )
  assert.equal(slots, 0)
  assert.equal(pump.normalEncoding, 0)
})

const formatsOf = (patches: { patch: Patch }[]) => new Set(patches.map(({ patch }) => patch.format))
const areaOf = (patches: { patch: Patch }[]) => area(patches.map(({ patch }) => patch.rect))
const inTier = <T extends { tier: SendTier }>(patches: T[], tier: SendTier) =>
  patches.filter((patch) => patch.tier === tier)

/**
 * A streaming surface without video while bandwidth is short, its whole area damaged. The network takes nothing:
 * `send` hands over what's held until `until` holds.
 */
async function lossyStreaming(env: Env, encoder: SurfaceEncoder<FakeEncoder>, host: FakeSurface) {
  await relentless(env, encoder, host)
  assert.equal(encoder.surfaceClass, 'streaming')
  env.sink.bandwidthLimited = true
  env.sink.sendHeld()
  await settle()
  env.sink.patches.length = 0
  host.touch()
  await encoder.commit(full(host))
  await settle()
}

/** The network takes what's held (and what comes of it) until `until` holds. */
async function sendUntil(env: Env, until: () => boolean) {
  for (let i = 0; i < 200 && !until(); i++) {
    env.sink.sendHeld()
    await settle()
    await settle()
  }
  assert.ok(until(), 'reached')
}

test("while bandwidth is short a streaming surface's damage may be lossy, a normal surface's never is", async () => {
  const env = setup(0)
  const { encoder, host } = env.surface('a')
  await lossyStreaming(env, encoder, host)
  await sendUntil(env, () => !encoder.hasDamageWork)
  const damage = inTier(env.sink.patches, 'streaming')
  assert.deepEqual(formatsOf(damage), new Set([PatchFormat.JPEG_ALPHA]))
  assert.equal(areaOf(damage), 1000 * 1000)
  const normal = env.surface('b', 100, 100)
  env.sink.flowFreely()
  env.sink.patches.length = 0
  await normal.encoder.commit(full(normal.host))
  await settle()
  const ofB = env.sink.patches.filter(({ surface }) => surface === 'b')
  assert.equal(normal.encoder.surfaceClass, 'normal')
  assert.ok(ofB.length > 0)
  assert.deepEqual(formatsOf(ofB), new Set([PatchFormat.QOI]))
  assert.deepEqual(normal.encoder.lossyRegion, [])
})

test('once its damage is sent, a surface settles: its lossy areas go again losslessly, in the settle tier, while bandwidth is still short', async () => {
  const env = setup(0)
  const { encoder, host } = env.surface('a')
  await lossyStreaming(env, encoder, host)
  // not while damage is left
  await sendUntil(env, () => env.sink.patches.some(({ tier }) => tier === 'settle'))
  const first = env.sink.patches.findIndex(({ tier }) => tier === 'settle')
  assert.equal(areaOf(env.sink.patches.slice(0, first)), 1000 * 1000)
  assert.ok(env.infos.some((message) => message.includes('lossy pixels again, losslessly (settling)')))
  env.sink.flowFreely()
  await settle()
  await settle()
  const settling = inTier(env.sink.patches, 'settle')
  assert.deepEqual(formatsOf(settling), new Set([PatchFormat.QOI]))
  assert.equal(areaOf(settling), 1000 * 1000)
  assert.deepEqual(encoder.lossyRegion, [])
  assert.equal(env.sink.bandwidthLimited, true)
  // nothing more to settle
  const sent = env.sink.patches.length
  env.context.tick()
  await settle()
  assert.equal(env.sink.patches.length, sent)
})

test('new damage pre-empts settling, and the settling patches it covers are dropped', async () => {
  const env = setup(0)
  const { encoder, host } = env.surface('a')
  await lossyStreaming(env, encoder, host)
  await sendUntil(env, () => env.sink.patches.some(({ tier }) => tier === 'settle'))
  // settling fills both slots, but the app may still draw (its frame callbacks wait for readyForFrame)
  assert.equal(env.sink.held.length, 2)
  assert.ok(!encoder.hasFreeSlot)
  assert.ok(encoder.readyForFrame)
  // damage in a corner not settled yet, which comes out lossless: it goes as soon as a slot frees
  env.streaming.jpegWins = false
  host.touch()
  await encoder.commit([r(990, 990, 10, 10)])
  assert.ok(!encoder.readyForFrame, 'one frame of damage waiting is enough')
  const before = env.sink.patches.length
  env.sink.held.shift()!.done(true)
  await settle()
  assert.deepEqual(env.sink.patches.slice(before), [
    { surface: 'a', patch: env.sink.patches[before].patch, tier: 'streaming' },
  ])
  assert.deepEqual(env.sink.patches[before].patch.rect, r(990, 990, 10, 10))
  env.sink.flowFreely()
  await settle()
  await settle()
  // the damaged corner wasn't settled: the damage covered it
  assert.equal(areaOf(inTier(env.sink.patches, 'settle')), 1000 * 1000 - 100)
  assert.deepEqual(encoder.lossyRegion, [])
})

test('damage that goes lossy again during settling is settled once the queue is done', async () => {
  const env = setup(0)
  const { encoder, host } = env.surface('a')
  await lossyStreaming(env, encoder, host)
  await sendUntil(env, () => env.sink.patches.some(({ tier }) => tier === 'settle'))
  host.touch()
  await encoder.commit([r(990, 990, 10, 10)])
  env.sink.flowFreely()
  await settle()
  await settle()
  await settle()
  const damage = env.sink.patches.findIndex(({ patch }) => patch.rect.x === 990 && patch.rect.width === 10)
  assert.equal(env.sink.patches[damage].patch.format, PatchFormat.JPEG_ALPHA)
  const after = inTier(env.sink.patches.slice(damage + 1), 'settle')
  assert.ok(
    after.some(({ patch }) => patch.rect.x <= 990 && patch.rect.x + patch.rect.width >= 1000 && patch.rect.y <= 990),
  )
  assert.deepEqual(encoder.lossyRegion, [])
})

test('a streaming surface is demoted only once it is fully settled', async () => {
  const env = setup(0)
  const { encoder, host } = env.surface('a')
  await lossyStreaming(env, encoder, host)
  await sendUntil(env, () => env.sink.patches.some(({ tier }) => tier === 'settle'))
  // quiet for many periods, but its settling patches aren't sent
  for (let i = 0; i < 4 * (CLASS_PERIOD_MS / 100); i++) {
    env.advance(100)
    env.context.tick()
  }
  assert.ok(encoder.lastPeriod!.backlogged < 0.15)
  assert.equal(encoder.surfaceClass, 'streaming')
  env.sink.flowFreely()
  await settle()
  await settle()
  assert.deepEqual(encoder.lossyRegion, [])
  env.context.tick()
  assert.equal(encoder.surfaceClass, 'normal')
})

test('random patch order: every queued rectangle is still sent once, just not oldest first', async () => {
  const env = setup(0)
  env.context.patchOrder = 'random'
  env.holdNormal(true)
  const { encoder, host } = env.surface('a', 1000, 1000)
  await encoder.commit(full(host))
  const planned = encoder.queuedPatches.length + SURFACE_SLOTS
  for (let i = 0; i < 200 && env.normalCalls.length > 0; i++) {
    env.normalCalls.shift()!.resolve()
    await settle()
  }
  const rects = env.sink.patches.map(({ patch }) => patch.rect)
  assert.equal(rects.length, planned)
  assert.equal(area(rects), 1000 * 1000)
  const ys = rects.map((rect) => rect.y * 1000 + rect.x)
  assert.notDeepEqual(
    ys,
    [...ys].sort((a, b) => a - b),
    'not in order (could be by chance with 16 patches: 1 in 16!)',
  )
})

test("random patch order: each commit's patches are a batch, batches go oldest first", async () => {
  const env = setup(0)
  env.context.patchOrder = 'random'
  env.holdNormal(true)
  const { encoder, host } = env.surface('a', 1000, 1000)
  // two commits while the slots are taken: the top half, then the bottom half
  await encoder.commit([r(0, 0, 1000, 500)])
  host.touch()
  await encoder.commit([r(0, 500, 1000, 500)])
  const top = (rect: Rect) => rect.y < 500
  for (let i = 0; i < 200 && env.normalCalls.length > 0; i++) {
    env.normalCalls.shift()!.resolve()
    await settle()
  }
  const rects = env.sink.patches.map(({ patch }) => patch.rect)
  assert.equal(area(rects), 1000 * 1000)
  const firstBottom = rects.findIndex((rect) => !top(rect))
  assert.ok(firstBottom > 0)
  assert.ok(
    rects.slice(firstBottom).every((rect) => !top(rect)),
    'all of the first batch before any of the second',
  )
})

test("a surface's lossless bytes per pixel: measured on all its lossless patches", async () => {
  const env = setup(0)
  const { encoder, host } = env.surface('a', 100, 100)
  assert.equal(encoder.bytesPerPixel, 4)
  // the fake normal encoder: 1 byte for 10000 pixels
  await encoder.commit(full(host))
  await settle()
  assert.equal(encoder.bytesPerPixel, 1 / 10_000)
  const big = env.surface('b')
  await lossyStreaming(env, big.encoder, big.host)
  const measured = big.encoder.bytesPerPixel
  // JPEG patches don't count
  const before = env.sink.patches.length
  env.sink.sendHeld()
  await settle()
  await settle()
  const handed = env.sink.patches.slice(before)
  assert.equal(handed.length, SURFACE_SLOTS)
  assert.deepEqual(formatsOf(handed), new Set([PatchFormat.JPEG_ALPHA]))
  assert.equal(big.encoder.bytesPerPixel, measured)
  // a patch that could have been lossy but came out lossless (the smaller) does
  await sendUntil(env, () => !big.encoder.hasUnsentWork)
  env.streaming.jpegWins = false
  big.host.touch()
  const settled = big.encoder.bytesPerPixel
  await big.encoder.commit([r(0, 0, 10, 10)])
  await sendUntil(env, () => !big.encoder.hasUnsentWork)
  assert.equal(env.sink.patches.at(-1)!.patch.format, PatchFormat.QOI)
  assert.notEqual(big.encoder.bytesPerPixel, settled)
})

test('burst promotion: while the normal surfaces would need more than BURST_MS of the link, the largest is promoted', async () => {
  const env = setup(0)
  env.sink.autoDone = false
  env.holdNormal(true)
  const small = env.surface('small', 100, 100)
  const large = env.surface('large', 1000, 1000)
  // 100 bytes per ms: BURST_MS is 20 KB
  env.sink.linkBandwidth = 100
  // 10000 pixels at 4 bytes (nothing measured yet): 40 KB
  await small.encoder.commit(full(small.host))
  assert.equal(small.encoder.surfaceClass, 'streaming', 'alone over the threshold')
  const other = env.surface('other', 50, 50)
  // 2500 pixels at 4 bytes: 10 KB, under the threshold; the streaming surface doesn't count
  await other.encoder.commit(full(other.host))
  assert.equal(other.encoder.surfaceClass, 'normal')
  // 4 MB: the largest, promoted first; then 10 KB of normal backlog is left
  await large.encoder.commit(full(large.host))
  assert.equal(large.encoder.surfaceClass, 'streaming')
  assert.equal(other.encoder.surfaceClass, 'normal')
  assert.ok(env.infos.some((message) => message.startsWith('Surface large is now streaming (a burst')))
})

test('no burst promotion before the link was bandwidth-limited (its bandwidth is unknown)', async () => {
  const env = setup(0)
  env.sink.autoDone = false
  env.holdNormal(true)
  const { encoder, host } = env.surface('a')
  await encoder.commit(full(host))
  env.context.tick()
  assert.equal(encoder.surfaceClass, 'normal')
  env.sink.linkBandwidth = 100
  env.context.tick()
  assert.equal(encoder.surfaceClass, 'streaming')
})

test("a burst's first patches already go out lossy when bandwidth is short", async () => {
  const env = setup(0)
  env.sink.linkBandwidth = 100
  env.sink.bandwidthLimited = true
  env.sink.autoDone = false
  const { encoder, host } = env.surface('a')
  await encoder.commit(full(host))
  await settle()
  assert.equal(encoder.surfaceClass, 'streaming')
  assert.equal(env.normalStarted, 0)
  assert.equal(env.streaming.lossyCalls, SURFACE_SLOTS)
  assert.deepEqual(formatsOf(env.sink.patches), new Set([PatchFormat.JPEG_ALPHA]))
})

test('video is encoded at the lower quality while bandwidth is short, and its area counts as lossy', async () => {
  const env = setup(1)
  const { encoder, host } = env.surface('a')
  await relentless(env, encoder, host)
  assert.ok(encoder.usesVideo)
  env.sink.flowFreely()
  assert.equal(env.encoders.length, 1)
  const lease = env.encoders[0]
  assert.equal(area(encoder.lossyRegion as Rect[]), 1000 * 1000)
  env.sink.bandwidthLimited = true
  host.touch()
  await encoder.commit(full(host))
  await settle()
  assert.equal(lease.quality, 'low')
  env.sink.bandwidthLimited = false
  host.touch()
  await encoder.commit(full(host))
  await settle()
  assert.equal(lease.quality, 'high')
})
