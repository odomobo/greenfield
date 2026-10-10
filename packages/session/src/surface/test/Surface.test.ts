import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Patch, PatchFormat } from '@gfld/scene-protocol'
import type {
  BufferInfo,
  ContextSurface,
  EncodedPatch,
  EncodingSink,
  Frame,
  PatchEncode,
  PatchOrder,
  PatchShape,
  Rect,
  SendTier,
  StreamingEncodePool,
  SurfaceClass,
  SurfaceContext,
  SurfaceHost,
  VideoQuality,
} from '@nebula/session-contracts'
import { PatchPump } from '@nebula/scheduler'
import { CLASS_PERIOD_MS, TrafficPolicy } from '@nebula/traffic-policy'
import { EncoderPool } from '@nebula/video-codec'
import { area } from '../../patch-renderer/index.js'
import { Surface } from '../index.js'

/**
 * The surface with both renderers, in a context like the session's (real traffic policy, patch pump and encoder pool;
 * fake sink, capture and codecs). The tests of one renderer alone are in the renderers' own tests.
 */

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

type Held = {
  surface: string
  done: (sent: boolean) => void
  /** its bytes as queuedBytes counts them (settling patches don't) */
  bytes: number
  /** its size for the stream's readiness (see FakeSink.sizeOf) */
  size: number
  settle: boolean
}

/**
 * Like the transport: a surface's stream is ready while at most one chunk of its items is held (not sent). Each item
 * counts as a chunk unless a test says otherwise (sizeOf), so a surface that the network takes nothing of has
 * ITEMS_HELD items held: one waiting, and the one encoded while that was all.
 */
const FAKE_CHUNK = 1000
const ITEMS_HELD = 2

class FakeSink implements EncodingSink {
  active = true
  /** call items' done right away (as if the network took them immediately) */
  autoDone = true
  frames: { surface: string; frame: Uint8Array; surfaceClass: SurfaceClass }[] = []
  patches: { surface: string; patch: Patch; tier: SendTier }[] = []
  /** items handed over and not yet "sent" (autoDone off) */
  held: Held[] = []
  /** an item's size for readiness, against a chunk of FAKE_CHUNK bytes */
  sizeOf: (data: Uint8Array) => number = () => FAKE_CHUNK
  onStreamReady?: (surface: string) => void
  /** surfaces found not ready, told when they are */
  private readonly waiting = new Set<string>()
  /** streams found not ready, and told when they were ready again, for tests */
  notReadyAnswers = 0
  readyNotifications: string[] = []

  sendFrame(surface: string, frame: Uint8Array, surfaceClass: SurfaceClass, done: (sent: boolean) => void) {
    this.frames.push({ surface, frame, surfaceClass })
    this.take({ surface, done, bytes: frame.length, size: this.sizeOf(frame), settle: false })
  }

  sendPatch(surface: string, patch: Patch, tier: SendTier, done: (sent: boolean) => void) {
    this.patches.push({ surface, patch, tier })
    this.take({
      surface,
      done,
      bytes: tier === 'settle' ? 0 : patch.data.length,
      size: this.sizeOf(patch.data),
      settle: tier === 'settle',
    })
  }

  /** like the transport: what's held of the surface, except settling patches */
  queuedBytes(surface: string) {
    return this.held.filter((item) => item.surface === surface).reduce((sum, { bytes }) => sum + bytes, 0)
  }

  streamReady(surface: string, exceptSettling = false) {
    const ready = this.heldSize(surface, exceptSettling) <= FAKE_CHUNK
    if (!ready) {
      this.notReadyAnswers++
      this.waiting.add(surface)
    }
    return ready
  }

  private heldSize(surface: string, exceptSettling: boolean) {
    return this.held
      .filter((item) => item.surface === surface && !(exceptSettling && item.settle))
      .reduce((sum, { size }) => sum + size, 0)
  }

  private take(item: Held) {
    if (this.autoDone) {
      item.done(true)
      return
    }
    // sent or not: it leaves the queue, the streams found not ready that are now are told, then its done
    const done = item.done
    const entry: Held = {
      ...item,
      done: (sent) => {
        const index = this.held.indexOf(entry)
        if (index >= 0) {
          this.held.splice(index, 1)
        }
        this.notifyReady()
        done(sent)
      },
    }
    this.held.push(entry)
  }

  private notifyReady() {
    for (const surface of [...this.waiting]) {
      if (this.heldSize(surface, false) <= FAKE_CHUNK) {
        this.waiting.delete(surface)
        this.readyNotifications.push(surface)
        this.onStreamReady?.(surface)
      }
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

/** Like the session's encoding context: the shared resources, the ticks, and the streams' readiness. */
class TestContext implements SurfaceContext<FakeEncoder> {
  readonly surfaces = new Set<ContextSurface>()
  readonly pump: PatchPump
  patchOrder: PatchOrder = 'oldest'
  patchShape: PatchShape = 'bands'

  constructor(
    readonly sink: EncodingSink,
    readonly pool: EncoderPool<FakeEncoder>,
    encoders: { normal: PatchEncode; streaming: StreamingEncodePool },
    readonly traffic: TrafficPolicy,
    readonly logger: { error(message: string): void; info(message: string): void },
  ) {
    this.pump = new PatchPump(sink, encoders.normal, encoders.streaming, logger)
    sink.onStreamReady = (key) => {
      for (const surface of this.surfaces) {
        if (surface.key === key) {
          surface.onStreamReady()
        }
      }
    }
  }

  addSurface(surface: ContextSurface) {
    this.surfaces.add(surface)
  }

  removeSurface(surface: ContextSurface) {
    this.surfaces.delete(surface)
  }

  tick() {
    this.traffic.judgeLink()
    for (const surface of this.surfaces) {
      surface.tick()
    }
    this.traffic.checkBurst()
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
  const logger = { error: (message: string) => errors.push(message), info: (message: string) => infos.push(message) }
  // traffic policy, judging a link the tests set
  const link = { bandwidthLimited: false, linkBandwidth: undefined as number | undefined }
  const traffic = new TrafficPolicy({ logger, now: () => now })
  traffic.useLink(link)
  const context = new TestContext(
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
    traffic,
    logger,
  )
  return {
    sink,
    link,
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
      return { host, encoder: new Surface(key, host, context) }
    },
  }
}

type Env = ReturnType<typeof setup>

const settle = () => new Promise((resolve) => setImmediate(resolve))

const full = (host: FakeSurface) => [r(0, 0, host.buffer!.width, host.buffer!.height)]

/** A relentless surface: full repaints every 50 ms while the network takes nothing, so its patches queue up. */
async function relentless(env: Env, encoder: Surface<FakeEncoder>, host: FakeSurface, ms = 2 * CLASS_PERIOD_MS + 100) {
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
  assert.equal(env.sink.frames.length, 0, 'the key frame waits for the stream to be ready')
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

test('a surface promoted again after its video stopped streams video again, from a key frame', async () => {
  const env = setup(1)
  const { encoder, host } = env.surface('a')
  await relentless(env, encoder, host)
  assert.ok(encoder.usesVideo)
  env.sink.flowFreely()
  await settle()
  for (let quietMs = 0; encoder.surfaceClass === 'streaming' && quietMs < 20_000; quietMs += 200) {
    env.advance(200)
    env.context.tick()
    await settle()
  }
  assert.ok(!encoder.usesVideo)
  assert.equal(env.pool.available, 1)
  await relentless(env, encoder, host)
  assert.ok(encoder.usesVideo)
  assert.equal(env.pool.available, 0)
  assert.equal(encoder.lossyRegion.length, 1, 'the whole surface is lossy again')
  const keyUnits = env.encoders.reduce((sum, { keyUnits }) => sum + keyUnits, 0)
  assert.ok(keyUnits >= 2, 'a key frame at each start')
  const frames = env.sink.frames.length
  env.sink.flowFreely()
  await settle()
  await settle()
  assert.ok(env.sink.frames.length > frames)
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
  assert.ok(env.sink.patches.length - patchesBefore <= queuedBefore + ITEMS_HELD)
})

test('a surface captures its next patch only while its stream is ready: the rest waits in its queue', async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  env.sink.autoDone = false
  await encoder.commit(full(host))
  await settle()
  await settle()
  // each item a chunk: the first is captured, then a second while one chunk waits, then the stream isn't ready
  assert.equal(env.sink.held.length, ITEMS_HELD)
  assert.equal(host.reads.length, ITEMS_HELD)
  assert.ok(!encoder.mayEncode)
  const queued = encoder.queuedPatches.length
  assert.ok(queued > 0)

  // one is sent: the stream is ready (the sink says so), the next patch is captured
  env.sink.held.shift()!.done(true)
  assert.deepEqual(env.sink.readyNotifications, ['a'])
  await settle()
  await settle()
  assert.equal(host.reads.length, ITEMS_HELD + 1)
  assert.equal(encoder.queuedPatches.length, queued - 1)
  assert.ok(!encoder.mayEncode)

  // everything goes out eventually
  for (let i = 0; i < 100 && encoder.hasUnsentWork; i++) {
    env.sink.sendHeld()
    await settle()
  }
  assert.ok(encoder.mayEncode)
  assert.equal(area(env.sink.patches.map(({ patch }) => patch.rect)), 1000 * 1000)
})

test('one encode at a time per surface; different surfaces encode in parallel', async () => {
  const env = setup(0)
  env.holdNormal(true)
  const a = env.surface('a')
  const b = env.surface('b')
  await a.encoder.commit(full(a.host))
  assert.equal(env.normalStarted, 1, 'the stream is ready, but one patch of a surface encodes at a time')
  assert.ok(!a.encoder.mayEncode)
  await b.encoder.commit(full(b.host))
  assert.equal(env.normalStarted, 2)
  env.normalCalls.shift()!.resolve()
  await settle()
  assert.equal(env.normalStarted, 3, "a's next patch once its first was handed to the sink")
  assert.equal(env.sink.patches.length, 1)
})

test("frame callbacks wait for the surface's stream to be ready", async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  assert.ok(encoder.readyForFrame)
  env.sink.autoDone = false
  await encoder.commit(full(host))
  await settle()
  await settle()
  assert.ok(!encoder.readyForFrame, 'more than a chunk waits')
  env.sink.held.shift()!.done(true)
  assert.ok(encoder.readyForFrame, 'a chunk left: the app may draw')
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
  assert.equal(held.length, ITEMS_HELD)
  await encoder.refresh()
  await settle()
  assert.deepEqual(env.sink.held, held, 'still waiting to go out')
  assert.equal(env.sink.patches.length, handedOver, 'the refresh waits for the stream to be ready')
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
  assert.equal(env.sink.held.length, ITEMS_HELD)
  encoder.destroy()
  assert.equal(env.sink.held.length, ITEMS_HELD, 'its items still go out, the viewer ignores them')
  env.sink.flowFreely()
  await settle()
  await settle()
  assert.equal(env.sink.patches.length, patches, 'nothing new of it is captured')
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

const formatsOf = (patches: { patch: Patch }[]) => new Set(patches.map(({ patch }) => patch.format))
const areaOf = (patches: { patch: Patch }[]) => area(patches.map(({ patch }) => patch.rect))
const inTier = <T extends { tier: SendTier }>(patches: T[], tier: SendTier) =>
  patches.filter((patch) => patch.tier === tier)

/**
 * A streaming surface without video while bandwidth is short, its whole area damaged. The network takes nothing:
 * `send` hands over what's held until `until` holds.
 */
async function lossyStreaming(env: Env, encoder: Surface<FakeEncoder>, host: FakeSurface) {
  await relentless(env, encoder, host)
  assert.equal(encoder.surfaceClass, 'streaming')
  env.link.bandwidthLimited = true
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

test('new damage pre-empts settling, and the settling patches it covers are dropped', async () => {
  const env = setup(0)
  const { encoder, host } = env.surface('a')
  await lossyStreaming(env, encoder, host)
  await sendUntil(env, () => env.sink.patches.some(({ tier }) => tier === 'settle'))
  // settling fills the stream, but the app may still draw (its frame callbacks wait for readyForFrame, which doesn't
  // count settling)
  assert.equal(env.sink.held.length, ITEMS_HELD)
  assert.ok(!encoder.mayEncode)
  assert.ok(encoder.readyForFrame)
  // damage in a corner not settled yet, which comes out lossless: it goes as soon as the stream is ready
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

test("a burst's first patches already go out lossy when bandwidth is short", async () => {
  const env = setup(0)
  env.link.linkBandwidth = 100
  env.link.bandwidthLimited = true
  env.sink.autoDone = false
  const { encoder, host } = env.surface('a')
  await encoder.commit(full(host))
  await settle()
  assert.equal(encoder.surfaceClass, 'streaming')
  assert.equal(env.normalStarted, 0)
  assert.equal(env.streaming.lossyCalls, ITEMS_HELD)
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
  env.link.bandwidthLimited = true
  host.touch()
  await encoder.commit(full(host))
  await settle()
  assert.equal(lease.quality, 'low')
  env.link.bandwidthLimited = false
  host.touch()
  await encoder.commit(full(host))
  await settle()
  assert.equal(lease.quality, 'high')
})
