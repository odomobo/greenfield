import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Patch, PatchFormat } from '@gfld/scene-protocol'
import type {
  Bottleneck,
  BufferInfo,
  EncodedPatch,
  EncodingSink,
  Frame,
  FrameSource,
  PatchOrder,
  PatchRendererContext,
  PatchRendererOwner,
  PatchShape,
  Rect,
  SendTier,
  StreamingEncodePool,
  SurfaceClass,
  TrafficDecision,
  VideoQuality,
} from '@nebula/session-contracts'
import { MAX_NORMAL_ENCODES, PatchPump } from '@nebula/scheduler'
import { PatchRenderer } from '../index.js'
import { area } from '../region.js'

/**
 * The patch renderer alone: its owner (the surface) is a fake that only goes on when told (see FakeOwner), its
 * traffic-policy decision a fake the tests set, the patch pump the scheduler's.
 */

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

type Held = {
  surface: string
  done: (sent: boolean) => void
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

class FakeSink implements Pick<EncodingSink, 'active' | 'streamReady' | 'sendPatch' | 'onStreamReady'> {
  active = true
  /** call items' done right away (as if the network took them immediately) */
  autoDone = true
  patches: { surface: string; patch: Patch; tier: SendTier }[] = []
  /** items handed over and not yet "sent" (autoDone off) */
  held: Held[] = []
  /** an item's size for readiness, against a chunk of FAKE_CHUNK bytes */
  sizeOf: (data: Uint8Array) => number = () => FAKE_CHUNK
  onStreamReady?: (surface: string) => void
  /** surfaces found not ready, told when they are */
  private readonly waiting = new Set<string>()

  sendPatch(surface: string, patch: Patch, tier: SendTier, done: (sent: boolean) => void) {
    this.patches.push({ surface, patch, tier })
    this.take({ surface, done, size: this.sizeOf(patch.data), settle: tier === 'settle' })
  }

  streamReady(surface: string, exceptSettling = false) {
    const ready = this.heldSize(surface, exceptSettling) <= FAKE_CHUNK
    if (!ready) {
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
        for (const surface of [...this.waiting]) {
          if (this.heldSize(surface, false) <= FAKE_CHUNK) {
            this.waiting.delete(surface)
            this.onStreamReady?.(surface)
          }
        }
        done(sent)
      },
    }
    this.held.push(entry)
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

class FakeHost implements FrameSource {
  buffer?: BufferInfo
  readable = true
  opaque = false
  reads: Rect[] = []
  /** frames taken and not released yet */
  heldFrames = 0
  framesTaken = 0

  constructor(width: number, height: number) {
    this.buffer = { bufferId: 1, creationSerial: 1, contentSerial: 1, width, height }
  }

  currentBuffer() {
    return this.buffer
  }

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

  /** a new buffer: the client committed */
  touch() {
    this.buffer = { ...this.buffer!, contentSerial: this.buffer!.contentSerial + 1 }
  }
}

/** The surface's traffic-policy decision, as the tests set it. */
class FakeDecision implements TrafficDecision {
  surfaceClass: SurfaceClass = 'normal'
  bottleneck: Bottleneck = 'cpu'
  videoQuality: VideoQuality = 'high'

  sendTier(settling: boolean): SendTier {
    return settling ? 'settle' : this.surfaceClass
  }
}

/** The surface as its patch renderer sees it, without another renderer: going on means settling and scheduling. */
class FakeOwner implements PatchRendererOwner {
  renderer!: PatchRenderer
  maySettle = true
  queued = 0
  unreadableCalls = 0

  get encoding() {
    return this.renderer.encoding
  }

  next() {
    this.renderer.settle()
    this.renderer.schedule()
  }

  patchesQueued() {
    this.queued++
  }

  unreadable() {
    this.unreadableCalls++
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

function setup() {
  const sink = new FakeSink()
  const infos: string[] = []
  const streaming = new FakeStreamingPool()
  const normalCalls: { resolve: () => void }[] = []
  let holdNormal = false
  let normalStarted = 0
  const opaqueSeen: boolean[] = []
  const logger = { error: (message: string) => assert.fail(message), info: (message: string) => infos.push(message) }
  const pump = new PatchPump(
    sink,
    (rgba, _width, _height, opaque) => {
      normalStarted++
      opaqueSeen.push(opaque)
      if (holdNormal) {
        return new Promise<EncodedPatch>((resolve) =>
          normalCalls.push({ resolve: () => resolve(fakeEncoded(new Uint8Array([rgba.length & 0xff]))) }),
        )
      }
      return Promise.resolve(fakeEncoded(new Uint8Array([rgba.length & 0xff])))
    },
    streaming,
    logger,
  )
  const context: PatchRendererContext & { patchOrder: PatchOrder; patchShape: PatchShape } = {
    sink,
    pump,
    patchOrder: 'oldest',
    patchShape: 'bands',
    logger,
  }
  const owners = new Map<string, FakeOwner>()
  sink.onStreamReady = (key) => owners.get(key)?.next()
  return {
    sink,
    pump,
    context,
    streaming,
    infos,
    normalCalls,
    opaqueSeen,
    get normalStarted() {
      return normalStarted
    },
    holdNormal(hold: boolean) {
      holdNormal = hold
    },
    renderer(key: string, width = 1000, height = 1000) {
      const host = new FakeHost(width, height)
      const decision = new FakeDecision()
      const owner = new FakeOwner()
      const renderer = new PatchRenderer(key, host, decision, owner, context)
      owner.renderer = renderer
      owners.set(key, owner)
      /** as the surface does on a commit: queue the damage, then settle if there is nothing else to send */
      const commit = (damage: Rect[]) => {
        const buffer = host.buffer!
        renderer.queue(damage, r(0, 0, buffer.width, buffer.height))
        renderer.settle()
      }
      return { renderer, host, decision, owner, commit }
    },
  }
}

type Env = ReturnType<typeof setup>
type Rendered = ReturnType<Env['renderer']>

const settle = () => new Promise((resolve) => setImmediate(resolve))

const full = (host: FakeHost) => [r(0, 0, host.buffer!.width, host.buffer!.height)]

const unsent = (renderer: PatchRenderer) => renderer.hasDamageWork || renderer.hasSettlingWork

const formatsOf = (patches: { patch: Patch }[]) => new Set(patches.map(({ patch }) => patch.format))
const areaOf = (patches: { patch: Patch }[]) => area(patches.map(({ patch }) => patch.rect))
const inTier = <T extends { tier: SendTier }>(patches: T[], tier: SendTier) =>
  patches.filter((patch) => patch.tier === tier)

/** A streaming surface while it's link-bound, its whole area damaged. The network takes nothing. */
async function lossyStreaming(env: Env, { decision, host, commit }: Rendered) {
  decision.surfaceClass = 'streaming'
  decision.bottleneck = 'link'
  env.sink.autoDone = false
  host.touch()
  commit(full(host))
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

test("a patch reads its pixels from a frame, released right after the read (not held while it's encoded)", async () => {
  const env = setup()
  const { host, commit } = env.renderer('a')
  env.sink.autoDone = false
  commit(full(host))
  assert.ok(host.framesTaken > 0)
  assert.equal(host.framesTaken, host.reads.length)
  assert.equal(host.heldFrames, 0)
  await settle()
  assert.equal(host.heldFrames, 0)
})

test("the opaque flag the host reports for a patch's pixels goes to the encoder", async () => {
  const env = setup()
  const { host, commit } = env.renderer('a')
  host.opaque = true
  commit(full(host))
  await settle()
  assert.ok(env.opaqueSeen.length > 0)
  assert.ok(env.opaqueSeen.every((opaque) => opaque))
  env.opaqueSeen.length = 0
  host.opaque = false
  host.touch()
  commit(full(host))
  await settle()
  assert.ok(env.opaqueSeen.length > 0)
  assert.ok(env.opaqueSeen.every((opaque) => !opaque))
})

test('queued damage is reported to the owner (for burst promotion) before any of it is captured', async () => {
  const env = setup()
  const { owner, host, commit } = env.renderer('a')
  let readsWhenQueued = -1
  owner.patchesQueued = () => {
    readsWhenQueued = host.reads.length
  }
  commit(full(host))
  assert.equal(readsWhenQueued, 0)
})

test('only the damage is sent, as patches of the whole buffer at most', async () => {
  const env = setup()
  const { host, commit } = env.renderer('a')
  commit([r(1, 2, 3, 4)])
  await settle()
  assert.deepEqual(
    env.sink.patches.map(({ patch }) => patch.rect),
    [r(1, 2, 3, 4)],
  )
  env.sink.patches.length = 0
  commit(full(host))
  await settle()
  await settle()
  assert.equal(areaOf(env.sink.patches), 1000 * 1000)
  assert.ok(env.sink.patches.every(({ patch }) => patch.rect.width * patch.rect.height <= 64 * 1024))
})

test('several small items are encoded until about a chunk of the surface waits', async () => {
  const env = setup()
  const { renderer, host, commit } = env.renderer('a')
  env.sink.autoDone = false
  // a tenth of a chunk each: ten fit in a chunk, so an eleventh is encoded while ten wait
  env.sink.sizeOf = () => FAKE_CHUNK / 10
  commit(full(host))
  for (let i = 0; i < 40; i++) {
    await settle()
  }
  assert.equal(env.sink.held.length, 11)
  assert.ok(!renderer.mayCapture)
  assert.ok(renderer.hasQueuedPatches)
})

test('a large item holds the next back until the stream is ready again', async () => {
  const env = setup()
  const { renderer, host, commit } = env.renderer('a', 300, 200)
  env.sink.autoDone = false
  // the first item is three chunks
  let first = true
  env.sink.sizeOf = () => {
    const size = first ? 3 * FAKE_CHUNK : 1
    first = false
    return size
  }
  commit([r(0, 0, 10, 10)])
  await settle()
  commit([r(20, 20, 10, 10)])
  await settle()
  await settle()
  assert.equal(env.sink.held.length, 1, 'the next waits')
  assert.equal(renderer.queuedPatches.length, 1)
  assert.equal(host.reads.length, 1)
  env.sink.held.shift()!.done(true)
  await settle()
  await settle()
  assert.equal(host.reads.length, 2, 'captured once the stream is ready')
})

test("nothing is captured while the owner says one of the surface's items is encoding", async () => {
  const env = setup()
  const { renderer, owner, host, commit } = env.renderer('a')
  let otherEncoding = true
  Object.defineProperty(owner, 'encoding', { get: () => otherEncoding || renderer.encoding })
  commit(full(host))
  await settle()
  assert.equal(host.reads.length, 0)
  assert.ok(!renderer.mayCapture)
  otherEncoding = false
  owner.next()
  await settle()
  assert.ok(host.reads.length > 0)
})

test('an item reported unsent counts as gone too', async () => {
  const env = setup()
  const { renderer, host, commit } = env.renderer('a')
  env.sink.autoDone = false
  commit(full(host))
  await settle()
  await settle()
  assert.ok(!renderer.mayCapture)
  assert.ok(renderer.hasQueuedPatches)
  const handedOver = env.sink.patches.length
  env.sink.dropHeld()
  await settle()
  await settle()
  assert.equal(env.sink.held.length, ITEMS_HELD, 'the next queued patches follow')
  assert.equal(env.sink.patches.length, handedOver + ITEMS_HELD)
})

test('at most MAX_NORMAL_ENCODES normal patches are encoded at once; streaming ones wait for their workers', async () => {
  const env = setup()
  env.holdNormal(true)
  const renderers = Array.from({ length: 6 }, (_, i) => env.renderer(`s${i}`))
  for (const { host, commit } of renderers) {
    commit(full(host))
  }
  assert.equal(env.normalStarted, MAX_NORMAL_ENCODES)
  assert.equal(env.pump.normalEncoding, MAX_NORMAL_ENCODES)
  env.normalCalls.shift()!.resolve()
  await settle()
  assert.equal(env.normalStarted, MAX_NORMAL_ENCODES + 1, 'a finished encode makes room for the next')
  assert.equal(env.streaming.calls, 0)
})

test('a streaming surface captures only while a streaming worker can take its patch', async () => {
  const env = setup()
  const { renderer, host, decision, commit } = env.renderer('a')
  decision.surfaceClass = 'streaming'
  commit(full(host))
  await settle()
  await settle()
  assert.ok(env.streaming.calls > 0, 'streaming patches are encoded by the streaming workers')
  assert.ok(env.sink.patches.every(({ tier }) => tier === 'streaming'))
  assert.equal(env.normalStarted, 0)

  env.streaming.canAccept = false
  const reads = host.reads.length
  host.touch()
  commit(full(host))
  await settle()
  assert.equal(host.reads.length, reads, 'nothing is captured while the workers are busy')
  assert.ok(renderer.hasQueuedPatches)

  env.streaming.setCapacity(true)
  await settle()
  assert.ok(host.reads.length > reads)
})

test('new damage over a queued patch is not queued again, over a captured one it is', async () => {
  const env = setup()
  const { renderer, host, commit } = env.renderer('a')
  env.sink.autoDone = false // patches stay unsent, the surface's stream isn't ready
  commit(full(host))
  await settle()
  await settle()
  const queued = renderer.queuedPatches.length
  assert.ok(queued > 0)
  const captured = env.sink.patches.map(({ patch }) => patch.rect)
  assert.equal(captured.length, ITEMS_HELD)
  const queuedRect = renderer.queuedPatches[renderer.queuedPatches.length - 1]

  commit([r(queuedRect.x + 1, queuedRect.y + 1, 10, 10)])
  assert.equal(renderer.queuedPatches.length, queued, 'a queued patch will pick up the latest pixels')

  commit([r(captured[0].x + 1, captured[0].y + 1, 10, 10)])
  assert.equal(renderer.queuedPatches.length, queued + 1, 'a captured patch may be stale, queue again')
  assert.deepEqual(renderer.queuedPatches[queued], r(captured[0].x + 1, captured[0].y + 1, 10, 10))
})

test('superseded: the queue is dropped, and a patch encoding meanwhile is not sent', async () => {
  const env = setup()
  env.holdNormal(true)
  const { renderer, host, commit } = env.renderer('a')
  commit(full(host))
  assert.equal(env.normalCalls.length, 1)
  assert.ok(renderer.queuedPatches.length > 0)
  renderer.supersede()
  assert.equal(renderer.queuedPatches.length, 0)
  env.normalCalls.shift()!.resolve()
  await settle()
  assert.equal(env.sink.patches.length, 0)
  assert.ok(!renderer.encoding)
  assert.ok(!renderer.hasDamageWork)
})

test('a buffer that cannot be read: the queue is dropped and the owner told', async () => {
  const env = setup()
  const { renderer, owner, host, commit } = env.renderer('a')
  host.readable = false
  commit(full(host))
  await settle()
  assert.ok(renderer.unreadable)
  assert.equal(owner.unreadableCalls, 1)
  assert.equal(renderer.queuedPatches.length, 0)
  assert.equal(env.sink.patches.length, 0)
  assert.equal(host.heldFrames, 0)
})

test("while link-bound a surface's damage may be lossy, while CPU-bound it never is", async () => {
  const env = setup()
  const a = env.renderer('a')
  await lossyStreaming(env, a)
  await sendUntil(env, () => !a.renderer.hasDamageWork)
  const damage = inTier(env.sink.patches, 'streaming')
  assert.deepEqual(formatsOf(damage), new Set([PatchFormat.JPEG_ALPHA]))
  assert.equal(areaOf(damage), 1000 * 1000)
  const b = env.renderer('b', 100, 100)
  env.sink.flowFreely()
  env.sink.patches.length = 0
  b.commit(full(b.host))
  await settle()
  const ofB = env.sink.patches.filter(({ surface }) => surface === 'b')
  assert.ok(ofB.length > 0)
  assert.deepEqual(formatsOf(ofB), new Set([PatchFormat.QOI]))
  assert.deepEqual(b.renderer.lossyRegion, [])
})

test('once its damage is sent, a surface settles: its lossy areas go again losslessly, in the settle tier, while still link-bound', async () => {
  const env = setup()
  const a = env.renderer('a')
  await lossyStreaming(env, a)
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
  assert.deepEqual(a.renderer.lossyRegion, [])
  assert.equal(a.decision.bottleneck, 'link')
  // nothing more to settle
  const sent = env.sink.patches.length
  a.renderer.settle()
  await settle()
  assert.equal(env.sink.patches.length, sent)
})

test('settling waits while the owner holds it back', async () => {
  const env = setup()
  const a = env.renderer('a')
  a.owner.maySettle = false
  await lossyStreaming(env, a)
  await sendUntil(env, () => !unsent(a.renderer))
  assert.ok(!env.sink.patches.some(({ tier }) => tier === 'settle'))
  assert.equal(areaOf(env.sink.patches), 1000 * 1000)
  a.owner.maySettle = true
  a.renderer.settle()
  await sendUntil(env, () => !unsent(a.renderer))
  assert.equal(areaOf(inTier(env.sink.patches, 'settle')), 1000 * 1000)
  assert.deepEqual(a.renderer.lossyRegion, [])
})

test('the whole surface marked lossy is settled; cleared, it is not', async () => {
  const env = setup()
  const a = env.renderer('a')
  a.renderer.markAllLossy(r(0, 0, 1000, 1000))
  a.renderer.clearLossy()
  a.renderer.settle()
  await settle()
  assert.equal(env.sink.patches.length, 0)
  a.renderer.markAllLossy(r(0, 0, 1000, 1000))
  a.renderer.settle()
  await sendUntil(env, () => !unsent(a.renderer))
  assert.equal(areaOf(inTier(env.sink.patches, 'settle')), 1000 * 1000)
  assert.deepEqual(a.renderer.lossyRegion, [])
})

test('damage that goes lossy again during settling is settled once the queue is done', async () => {
  const env = setup()
  const a = env.renderer('a')
  await lossyStreaming(env, a)
  await sendUntil(env, () => env.sink.patches.some(({ tier }) => tier === 'settle'))
  a.host.touch()
  a.commit([r(990, 990, 10, 10)])
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
  assert.deepEqual(a.renderer.lossyRegion, [])
})

test('random patch order: every queued rectangle is still sent once, just not oldest first', async () => {
  const env = setup()
  env.context.patchOrder = 'random'
  env.holdNormal(true)
  const { renderer, host, commit } = env.renderer('a', 1000, 1000)
  commit(full(host))
  // (one is encoding already)
  const planned = renderer.queuedPatches.length + env.normalCalls.length
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
  const env = setup()
  env.context.patchOrder = 'random'
  env.holdNormal(true)
  const { host, commit } = env.renderer('a', 1000, 1000)
  // two commits while a patch encodes: the top half, then the bottom half
  commit([r(0, 0, 1000, 500)])
  host.touch()
  commit([r(0, 500, 1000, 500)])
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
  const env = setup()
  const small = env.renderer('a', 100, 100)
  assert.equal(small.renderer.bytesPerPixel, 4)
  // the fake normal encoder: 1 byte for 10000 pixels
  small.commit(full(small.host))
  await settle()
  assert.equal(small.renderer.bytesPerPixel, 1 / 10_000)
  const big = env.renderer('b')
  await lossyStreaming(env, big)
  const measured = big.renderer.bytesPerPixel
  // JPEG patches don't count
  const before = env.sink.patches.length
  env.sink.sendHeld()
  await settle()
  await settle()
  const handed = env.sink.patches.slice(before)
  assert.equal(handed.length, ITEMS_HELD)
  assert.deepEqual(formatsOf(handed), new Set([PatchFormat.JPEG_ALPHA]))
  assert.equal(big.renderer.bytesPerPixel, measured)
  // a patch that could have been lossy but came out lossless (the smaller) does
  await sendUntil(env, () => !unsent(big.renderer))
  env.streaming.jpegWins = false
  big.host.touch()
  const settled = big.renderer.bytesPerPixel
  big.commit([r(0, 0, 10, 10)])
  await sendUntil(env, () => !unsent(big.renderer))
  assert.equal(env.sink.patches.at(-1)!.patch.format, PatchFormat.QOI)
  assert.notEqual(big.renderer.bytesPerPixel, settled)
})

test('its unencoded bytes: the damage queued or encoding, at its bytes per pixel; settling never counts', async () => {
  const env = setup()
  env.holdNormal(true)
  const { renderer, host, commit } = env.renderer('a', 100, 100)
  assert.equal(renderer.unencodedBytes, 0)
  commit(full(host))
  // the whole surface, one patch encoding
  assert.equal(renderer.unencodedBytes, 100 * 100 * 4)
  env.normalCalls.shift()!.resolve()
  await settle()
  assert.equal(renderer.unencodedBytes, 0)
  renderer.markAllLossy(r(0, 0, 100, 100))
  renderer.settle()
  assert.ok(renderer.hasSettlingWork)
  assert.equal(renderer.unencodedBytes, 0)
})
