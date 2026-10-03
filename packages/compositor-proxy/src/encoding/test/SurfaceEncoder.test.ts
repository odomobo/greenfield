import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Patch } from '@gfld/scene-protocol'
import { EncoderPool } from '../EncoderPool.js'
import { INITIAL_FAST_MS } from '../policy.js'
import { area, Rect } from '../region.js'
import { BufferInfo, EncodingContext, EncodingSink, SurfaceEncoder, SurfaceHost } from '../SurfaceEncoder.js'

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

class FakeSink implements EncodingSink {
  active = true
  /** call patches' done right away (as if the network took them immediately) */
  autoDone = true
  frames: { surface: string; frame: Uint8Array }[] = []
  patches: { surface: string; patch: Patch; done: (sent: boolean) => void }[] = []
  keyFramesRequired: string[] = []
  patchesDropped: string[] = []

  sendFrame(surface: string, frame: Uint8Array) {
    this.frames.push({ surface, frame })
  }

  sendPatch(surface: string, patch: Patch, done: (sent: boolean) => void) {
    this.patches.push({ surface, patch, done })
    if (this.autoDone) {
      done(true)
    }
  }

  requireKeyFrame(surface: string) {
    this.keyFramesRequired.push(surface)
  }

  dropPatches(surface: string) {
    this.patchesDropped.push(surface)
  }
}

class FakeSurface implements SurfaceHost<FakeEncoder> {
  buffer?: BufferInfo
  readable = true
  reads: Rect[] = []
  encodes: { encoder: FakeEncoder; resolve: (frame: Uint8Array) => void }[] = []
  /** resolve video encodings right away */
  autoEncode = true

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
    return new Promise<Uint8Array>((resolve) => {
      const frame = new Uint8Array([buffer.contentSerial])
      if (this.autoEncode) {
        resolve(frame)
      } else {
        this.encodes.push({ encoder, resolve })
      }
    })
  }
}

function setup(poolSize = 2) {
  let now = 1000
  const sink = new FakeSink()
  const pool = new EncoderPool(() => new FakeEncoder(), poolSize)
  const context = new EncodingContext<FakeEncoder>(
    sink,
    pool,
    async (rgba) => new Uint8Array([rgba.length & 0xff]),
    { error: () => undefined },
    () => now,
  )
  return {
    sink,
    pool,
    context,
    advance(ms: number) {
      now += ms
    },
    surface(key: string, width = 1000, height = 1000) {
      const host = new FakeSurface(width, height)
      return { host, encoder: new SurfaceEncoder(key, host, context) }
    },
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

/** A busy surface: full repaints every 16 ms for half a second. */
async function busy(env: ReturnType<typeof setup>, encoder: SurfaceEncoder<FakeEncoder>, host: FakeSurface) {
  for (let i = 0; i < 30; i++) {
    env.advance(16)
    host.buffer = { ...host.buffer!, contentSerial: host.buffer!.contentSerial + 1 }
    await encoder.commit([r(0, 0, host.buffer!.width, host.buffer!.height)])
  }
  await settle()
}

test('a new surface starts as video with a key frame', async () => {
  const env = setup()
  const { encoder } = env.surface('a')
  assert.equal(encoder.mode, 'fast')
  await encoder.commit([r(0, 0, 1000, 1000)])
  await settle()
  assert.deepEqual(env.sink.keyFramesRequired, ['a'])
  assert.equal(env.sink.frames.length, 1)
  assert.equal(env.sink.patches.length, 0)
  assert.equal(env.pool.available, 1, 'one encoder lent out')
})

test('a quiet surface settles to a full lossless image after its first moments', async () => {
  const env = setup()
  const { encoder } = env.surface('a')
  await encoder.commit([r(0, 0, 1000, 1000)])
  env.advance(INITIAL_FAST_MS / 2)
  env.context.tick()
  assert.equal(encoder.mode, 'fast', 'not before INITIAL_FAST_MS')
  env.advance(INITIAL_FAST_MS)
  env.context.tick()
  assert.equal(encoder.mode, 'slow')
  assert.equal(env.pool.available, 2, 'the encoder went back to the pool')
  await settle()
  await settle()
  const covered = env.sink.patches.map(({ patch }) => patch.rect)
  assert.equal(area(covered), 1000 * 1000, 'the whole surface as patches')
  assert.ok(covered.every((rect) => rect.width * rect.height <= 64 * 1024))
})

test('a single large update does not make a quiet surface busy, sustained ones do', async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  await encoder.commit([r(0, 0, 1000, 1000)])
  env.advance(2000)
  env.context.tick()
  assert.equal(encoder.mode, 'slow')

  await encoder.commit([r(0, 0, 1000, 1000)])
  assert.equal(encoder.mode, 'slow', 'one full repaint is the ignored largest damage')

  env.sink.patchesDropped.length = 0
  await busy(env, encoder, host)
  assert.equal(encoder.mode, 'fast')
  assert.deepEqual(env.sink.patchesDropped, ['a'], 'unsent patches dropped')
  assert.equal(encoder.queuedPatches.length, 0)
  assert.ok(env.sink.frames.length > 0)
  assert.ok(env.sink.keyFramesRequired.length >= 2, 'video restarts with a key frame')
})

test('new damage over a queued patch is not queued again, over a captured one it is', async () => {
  const env = setup()
  const { encoder } = env.surface('a')
  await encoder.commit([r(0, 0, 1000, 1000)])
  env.sink.autoDone = false // patches stay in flight, the pump stops after a few
  env.advance(2000)
  env.context.tick()
  await settle()
  const queued = encoder.queuedPatches.length
  assert.ok(queued > 0)
  assert.equal(env.context.pump.patchesInFlight, 3)
  const captured = env.sink.patches.map(({ patch }) => patch.rect)
  const queuedRect = encoder.queuedPatches[encoder.queuedPatches.length - 1]

  await encoder.commit([r(queuedRect.x + 1, queuedRect.y + 1, 10, 10)])
  assert.equal(encoder.queuedPatches.length, queued, 'a queued patch will pick up the latest pixels')

  await encoder.commit([r(captured[0].x + 1, captured[0].y + 1, 10, 10)])
  assert.equal(encoder.queuedPatches.length, queued + 1, 'a captured patch may be stale, queue again')
  assert.deepEqual(encoder.queuedPatches[queued], r(captured[0].x + 1, captured[0].y + 1, 10, 10))

  // the network takes them: the pump continues
  for (const { done } of env.sink.patches.splice(0)) {
    done(true)
  }
  await settle()
  assert.equal(env.context.pump.patchesInFlight, 3)
})

test('without a free encoder a busy surface stays on patches', async () => {
  const env = setup(1)
  const a = env.surface('a')
  await a.encoder.commit([r(0, 0, 1000, 1000)])
  assert.equal(env.pool.available, 0)

  const b = env.surface('b')
  await b.encoder.commit([r(0, 0, 1000, 1000)])
  assert.equal(b.encoder.mode, 'slow', 'starts on patches when the pool is empty')
  await busy(env, b.encoder, b.host)
  assert.equal(b.encoder.mode, 'slow', 'stays on patches')

  a.encoder.destroy()
  assert.equal(env.pool.available, 1)
  await busy(env, b.encoder, b.host)
  assert.equal(b.encoder.mode, 'fast', 'takes the freed encoder')
})

test('video finished after switching to patches is dropped', async () => {
  const env = setup()
  const { encoder, host } = env.surface('a')
  host.autoEncode = false
  void encoder.commit([r(0, 0, 1000, 1000)])
  assert.equal(host.encodes.length, 1)
  env.advance(2000)
  env.context.tick()
  assert.equal(encoder.mode, 'slow')
  host.encodes[0].resolve(new Uint8Array([1]))
  await settle()
  assert.equal(env.sink.frames.length, 0)
})

test('small surfaces are never video', async () => {
  const env = setup()
  const { encoder } = env.surface('cursor', 64, 64)
  await encoder.commit([r(0, 0, 64, 64)])
  await settle()
  assert.equal(env.pool.available, 2)
  assert.deepEqual(env.sink.keyFramesRequired, [])
  assert.deepEqual(
    env.sink.patches.map(({ patch }) => patch.rect),
    [r(0, 0, 64, 64)],
  )
  await encoder.commit([r(1, 2, 3, 4)])
  await settle()
  assert.deepEqual(env.sink.patches[1].patch.rect, r(1, 2, 3, 4), 'only the damage')
})

test('empty damage sends nothing', async () => {
  const env = setup()
  const { encoder } = env.surface('a')
  await encoder.commit([])
  await encoder.commit([r(2000, 2000, 10, 10)])
  await settle()
  assert.equal(env.sink.frames.length + env.sink.patches.length, 0)
})

test('a buffer that cannot be read is streamed as video, even beyond the pool', async () => {
  const env = setup(1)
  const a = env.surface('a')
  await a.encoder.commit([r(0, 0, 1000, 1000)])
  const b = env.surface('b')
  b.host.readable = false
  await b.encoder.commit([r(0, 0, 1000, 1000)])
  await settle()
  assert.equal(b.encoder.mode, 'fast')
  assert.ok(env.sink.frames.some((frame) => frame.surface === 'b'))
  env.advance(5000)
  env.context.tick()
  assert.equal(b.encoder.mode, 'fast', 'stays video')
})

test('refresh resends the whole surface in its current mode', async () => {
  const env = setup()
  const { encoder } = env.surface('a')
  await encoder.commit([r(0, 0, 1000, 1000)])
  await encoder.refresh()
  await settle()
  assert.equal(env.sink.frames.length, 2)
  assert.equal(env.pool.available, 1)

  env.advance(2000)
  env.context.tick()
  await settle()
  env.sink.patches.length = 0
  await encoder.refresh()
  await settle()
  await settle()
  assert.equal(area(env.sink.patches.map(({ patch }) => patch.rect)), 1000 * 1000)
})
