import { test } from 'node:test'
import assert from 'node:assert/strict'
import type {
  Bottleneck,
  BufferInfo,
  EncodingSink,
  Frame,
  RendererOwner,
  SendTier,
  SurfaceClass,
  SurfaceHost,
  TrafficDecision,
  VideoEncoderPool,
  VideoQuality,
} from '@nebula/session-contracts'
import { VideoRenderer } from '../index.js'

/**
 * The video renderer alone: its owner (the surface) is a fake that goes on by pumping it, its traffic-policy decision
 * a fake the tests set.
 */

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

class FakePool implements VideoEncoderPool<FakeEncoder> {
  readonly leased = new Set<FakeEncoder>()
  created: FakeEncoder[] = []

  constructor(readonly size: number) {}

  get available() {
    return this.size - this.leased.size
  }

  acquire() {
    if (this.available <= 0) {
      return undefined
    }
    return this.lease()
  }

  acquireAlways() {
    return this.size === 0 ? undefined : this.lease()
  }

  private lease() {
    const encoder = new FakeEncoder()
    this.created.push(encoder)
    this.leased.add(encoder)
    return encoder
  }

  release(encoder: FakeEncoder) {
    this.leased.delete(encoder)
  }
}

/**
 * Like the transport: the stream is ready while at most one item is held (not sent), so a stream that the network
 * takes nothing of has two frames held: one waiting, and the one encoded while that was all.
 */
class FakeSink implements Pick<EncodingSink, 'active' | 'streamReady' | 'sendFrame'> {
  active = true
  autoDone = true
  frames: { surface: string; frame: Uint8Array; surfaceClass: SurfaceClass }[] = []
  held: ((sent: boolean) => void)[] = []
  /** told when a stream found not ready is ready again */
  onReady?: () => void
  private waiting = false

  sendFrame(surface: string, frame: Uint8Array, surfaceClass: SurfaceClass, done: (sent: boolean) => void) {
    this.frames.push({ surface, frame, surfaceClass })
    if (this.autoDone) {
      done(true)
      return
    }
    const entry = (sent: boolean) => {
      this.held.splice(this.held.indexOf(entry), 1)
      if (this.waiting && this.held.length <= 1) {
        this.waiting = false
        this.onReady?.()
      }
      done(sent)
    }
    this.held.push(entry)
  }

  streamReady() {
    const ready = this.held.length <= 1
    this.waiting ||= !ready
    return ready
  }

  /** the network takes everything held, and everything from now on */
  flowFreely() {
    this.autoDone = true
    for (const done of [...this.held]) {
      done(true)
    }
  }
}

class FakeHost implements SurfaceHost<FakeEncoder> {
  buffer?: BufferInfo
  encodes: { encoder: FakeEncoder; resolve: (frame: Uint8Array) => void }[] = []
  /** resolve video encodings right away */
  autoEncode = true
  videoEncodes = 0
  /** frames taken and not released yet */
  heldFrames = 0

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
    let released = false
    return {
      width: buffer.width,
      height: buffer.height,
      contentSerial: buffer.contentSerial,
      readPixels: () => undefined,
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

class FakeDecision implements TrafficDecision {
  surfaceClass: SurfaceClass = 'streaming'
  bottleneck: Bottleneck = 'cpu'
  videoQuality: VideoQuality = 'high'

  sendTier(settling: boolean): SendTier {
    return settling ? 'settle' : this.surfaceClass
  }
}

function setup(poolSize = 1) {
  const sink = new FakeSink()
  const pool = new FakePool(poolSize)
  const host = new FakeHost(1000, 1000)
  const decision = new FakeDecision()
  const errors: string[] = []
  const owner: RendererOwner & { nexts: number } = {
    nexts: 0,
    get encoding() {
      return video.encoding
    },
    next() {
      this.nexts++
      void video.pump()
    },
  }
  const video: VideoRenderer<FakeEncoder> = new VideoRenderer('a', host, decision, owner, {
    sink,
    pool,
    logger: { error: (message) => errors.push(message) },
  })
  sink.onReady = () => owner.next()
  return { sink, pool, host, decision, owner, video, errors }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

const keyUnits = (pool: FakePool) => pool.created.reduce((sum, { keyUnits }) => sum + keyUnits, 0)

test('starting leases an encoder; stopping gives it back; without a free one it does not start', async () => {
  const env = setup(1)
  assert.ok(!env.video.active)
  assert.ok(env.video.start(false))
  assert.ok(env.video.active)
  assert.equal(env.pool.available, 0)
  env.video.stop()
  assert.ok(!env.video.active)
  assert.equal(env.pool.available, 1)
  assert.ok(env.video.drained)

  env.pool.acquire()
  assert.ok(!env.video.start(false), 'none free')
  assert.ok(!env.video.active)
  assert.ok(env.video.start(true), 'always: one beyond the pool')
  assert.ok(env.video.active)
})

test('the first frame after a start is a key frame, of the current content, sent in the decision class', async () => {
  const env = setup()
  env.video.start(false)
  await env.video.request(true)
  assert.equal(keyUnits(env.pool), 1)
  assert.equal(env.host.videoEncodes, 1)
  assert.deepEqual(env.sink.frames, [{ surface: 'a', frame: new Uint8Array([1]), surfaceClass: 'streaming' }])
  // new content: a delta, no key frame
  env.host.touch()
  await env.video.request(false)
  assert.equal(keyUnits(env.pool), 1)
  assert.equal(env.sink.frames.length, 2)
  // the viewer's decoder failed: a key frame again
  await env.video.request(true)
  assert.equal(keyUnits(env.pool), 2)
  assert.equal(env.sink.frames.length, 3)
})

test('each video frame is encoded from a frame of the buffer, held only while it is encoded', async () => {
  const env = setup()
  env.video.start(false)
  await env.video.request(true)
  assert.equal(env.host.heldFrames, 0)
  env.host.autoEncode = false
  env.host.touch()
  void env.video.request(false)
  assert.equal(env.host.encodes.length, 1)
  assert.equal(env.host.heldFrames, 1, 'the frame being encoded')
  env.host.encodes[0].resolve(new Uint8Array([1]))
  await settle()
  assert.equal(env.host.heldFrames, 0)
})

test('a video frame wanted while the stream is not ready is encoded once it is', async () => {
  const env = setup()
  env.sink.autoDone = false
  env.video.start(false)
  // fill the stream with frames the network doesn't take
  await env.video.request(true)
  env.host.touch()
  await env.video.request(false)
  assert.equal(env.sink.held.length, 2)
  const encodes = env.host.videoEncodes
  env.host.touch()
  await env.video.request(false)
  assert.equal(env.host.videoEncodes, encodes, 'not ready, no encode')
  assert.ok(env.video.hasDamageWork)
  env.sink.held[0](true)
  await settle()
  assert.equal(env.host.videoEncodes, encodes + 1, 'the latest content is encoded once the stream is ready')
})

test('video: one frame encodes at a time; frames wanted meanwhile become one frame of the latest content', async () => {
  const env = setup()
  env.video.start(false)
  await env.video.request(true)
  env.host.autoEncode = false
  const encodes = env.host.videoEncodes
  env.host.touch()
  void env.video.request(false)
  assert.equal(env.host.videoEncodes, encodes + 1)
  env.host.touch()
  void env.video.request(false)
  env.host.touch()
  void env.video.request(false)
  assert.equal(env.host.videoEncodes, encodes + 1, 'the stream is ready, but the encode in flight comes first')
  const frames = env.sink.frames.length
  env.host.encodes.shift()!.resolve(new Uint8Array([1]))
  await settle()
  assert.equal(env.sink.frames.length, frames + 1)
  assert.equal(env.host.videoEncodes, encodes + 2, 'then one frame of the latest content')
})

test("nothing is encoded while the owner says one of the surface's items is encoding", async () => {
  const env = setup()
  let otherEncoding = true
  Object.defineProperty(env.owner, 'encoding', { get: () => otherEncoding || env.video.encoding })
  env.video.start(false)
  await env.video.request(true)
  assert.equal(env.host.videoEncodes, 0)
  assert.ok(env.video.hasDamageWork, 'still wanted')
  otherEncoding = false
  await env.video.pump()
  assert.equal(env.host.videoEncodes, 1)
})

test('video that finishes encoding after the surface was destroyed is dropped, and its encode is over', async () => {
  const env = setup()
  env.video.start(false)
  await env.video.request(true)
  env.host.autoEncode = false
  env.host.touch()
  void env.video.request(false)
  const framesBefore = env.sink.frames.length
  assert.equal(env.host.encodes.length, 1)
  assert.ok(env.video.encoding)
  env.video.destroy()
  assert.equal(env.pool.available, 1)
  env.host.encodes[0].resolve(new Uint8Array([1]))
  await settle()
  assert.equal(env.sink.frames.length, framesBefore, 'the stale frame is not sent')
  assert.ok(!env.video.encoding)
  assert.ok(!env.video.hasDamageWork)
})

test('a frame encoding when the video stops is dropped; the renderer is drained once it is done', async () => {
  const env = setup()
  env.video.start(false)
  await env.video.request(true)
  env.host.autoEncode = false
  env.host.touch()
  void env.video.request(false)
  env.video.stop()
  assert.ok(!env.video.drained, 'a frame is still encoding')
  env.host.encodes[0].resolve(new Uint8Array([1]))
  await settle()
  assert.equal(env.sink.frames.length, 1, 'only the first frame was sent')
  assert.ok(env.video.drained)
})

test('video is encoded at the quality of the decision', async () => {
  const env = setup()
  env.video.start(false)
  const lease = env.pool.created[0]
  env.decision.videoQuality = 'low'
  await env.video.request(true)
  assert.equal(lease.quality, 'low')
  env.decision.videoQuality = 'high'
  env.host.touch()
  await env.video.request(false)
  assert.equal(lease.quality, 'high')
})

test('without a viewer or a buffer nothing is wanted anymore', async () => {
  const env = setup()
  env.video.start(false)
  env.sink.active = false
  await env.video.request(true)
  assert.equal(env.host.videoEncodes, 0)
  assert.ok(!env.video.hasDamageWork)
  env.sink.active = true
  env.host.buffer = undefined
  await env.video.request(false)
  assert.equal(env.host.videoEncodes, 0)
  assert.ok(!env.video.hasDamageWork)
})
