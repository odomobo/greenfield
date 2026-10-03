/**
 * Per-surface encoding state machine (see "Encoding policy" in ROADMAP.md): fast mode streams the whole surface as
 * video, slow mode sends lossless PNG patches of the damaged areas. Native code is reached only through the injected
 * host, sink and pool, so this runs (and is tested) without it.
 */
import type { Patch } from '@gfld/scene-protocol'
import { EncoderPool } from './EncoderPool.js'
import { DamageMeter, EncodingMode, INITIAL_FAST_MS, MAX_PATCH_PIXELS, nextMode, planPatches } from './policy.js'
import { area, clip, intersect, Rect } from './region.js'

export type BufferInfo = {
  bufferId: number
  creationSerial: number
  contentSerial: number
  width: number
  height: number
}

export interface VideoEncoder {
  requestKeyUnit(): void
  destroy(): void
}

/** Where encoded frames and patches go: the attached viewer. */
export interface EncodingSink {
  /** true if a viewer is attached; nothing is encoded without one */
  readonly active: boolean
  sendFrame(surface: string, frame: Uint8Array): void
  /** `done` must be called exactly once: when the patch was handed to the network (true) or dropped (false) */
  sendPatch(surface: string, patch: Patch, done: (sent: boolean) => void): void
  /** drop everything unsent of the surface, its video restarts with a key frame */
  requireKeyFrame(surface: string): void
  dropPatches(surface: string): void
}

/** The surface's buffer, as the encoder sees it. */
export interface SurfaceHost<V extends VideoEncoder> {
  currentBuffer(): BufferInfo | undefined
  /** RGBA pixels of a rectangle of the current buffer, a synchronous copy. undefined if it can't be read. */
  readPixels(rect: Rect): Uint8Array | undefined
  encodeVideo(encoder: V, buffer: BufferInfo): Promise<Uint8Array>
}

export type Logger = { error(message: string): void }

const resolved = Promise.resolve()

function boundsOf(buffer: BufferInfo): Rect {
  return { x: 0, y: 0, width: buffer.width, height: buffer.height }
}

/**
 * Small surfaces are never streamed as video: one lossless patch of the whole surface is cheap enough (and the video
 * encoder would have to pad it anyway).
 */
function isSmall(buffer: BufferInfo): boolean {
  return buffer.width * buffer.height <= MAX_PATCH_PIXELS
}

type CapturedPatch = {
  rect: Rect
  pixels: Uint8Array
  surfaceSize: { width: number; height: number }
  serial: number
  epoch: number
}

/** What the patch pump needs of a surface. */
export interface PatchSource {
  readonly key: string
  readonly destroyed: boolean
  readonly hasQueuedPatches: boolean
  capturePatch(): CapturedPatch | undefined
  /** false if results captured at this epoch are stale (mode switched, surface destroyed) */
  isCurrent(epoch: number): boolean
}

export class SurfaceEncoder<V extends VideoEncoder = VideoEncoder> implements PatchSource {
  private _mode: EncodingMode = 'fast'
  private readonly meter: DamageMeter
  private readonly createdAt: number
  /** patches queued but not captured yet: they will read the latest pixels when they are */
  private queued: Rect[] = []
  /** bumped on every mode switch, results of encodings started before are dropped */
  private epoch = 0
  private lease?: V
  /** the buffer can't be read as pixels (e.g. an external-only dmabuf), only streamed as video */
  private patchUnsupported = false
  private _destroyed = false
  /** video encodings in flight, they still read their buffer */
  private readonly videoInFlight = new Set<Promise<void>>()

  constructor(
    readonly key: string,
    private readonly host: SurfaceHost<V>,
    private readonly context: EncodingContext<V>,
  ) {
    this.createdAt = context.now()
    this.meter = new DamageMeter(this.createdAt)
    context.surfaces.add(this)
  }

  get mode(): EncodingMode {
    return this._mode
  }

  get destroyed(): boolean {
    return this._destroyed
  }

  get hasQueuedPatches(): boolean {
    return this.queued.length > 0
  }

  /**
   * Resolves when the video encodings in flight now are done. Patches copy their pixels right away, so after this no
   * encoding reads a buffer that was replaced before the call.
   */
  whenIdle(): Promise<void> {
    return this.videoInFlight.size ? Promise.all(this.videoInFlight).then(() => undefined) : resolved
  }

  /** Not-yet-captured patch rectangles, for tests. */
  get queuedPatches(): readonly Rect[] {
    return this.queued
  }

  /**
   * The surface committed a new buffer with this damage (buffer coordinates). Returns when no encoding still needs the
   * buffer.
   */
  commit(damage: Rect[]): Promise<void> {
    const buffer = this.host.currentBuffer()
    if (buffer === undefined || this._destroyed) {
      return resolved
    }
    const bounds = boundsOf(buffer)
    const changed = area(clip(damage, bounds))
    if (changed === 0) {
      // nothing changed, nothing to send
      return resolved
    }
    const now = this.context.now()
    this.meter.record(now, changed)
    const switched = this.evaluate(now, buffer)
    if (switched) {
      // a switch sends the whole surface
      return switched
    }
    if (!this.context.sink.active) {
      return resolved
    }
    if (this._mode === 'fast' && this.usesVideo(buffer)) {
      return this.sendVideo(buffer, false)
    }
    // slow mode, or a small surface (never video)
    this.releaseLease()
    this.queuePatches(damage, bounds)
    return resolved
  }

  /** Re-evaluate the mode without a commit, so a surface that went quiet switches to crisp patches. */
  tick(): void {
    const buffer = this.host.currentBuffer()
    if (buffer && !this._destroyed && this._mode === 'fast') {
      this.evaluate(this.context.now(), buffer)
    }
  }

  /**
   * Send the whole surface again: a viewer attached, or its decoder needs a key frame. Returns when no encoding still
   * needs the buffer.
   */
  refresh(): Promise<void> {
    const buffer = this.host.currentBuffer()
    if (buffer === undefined || this._destroyed || !this.context.sink.active) {
      return resolved
    }
    if (this._mode === 'fast' && this.usesVideo(buffer)) {
      return this.sendVideo(buffer, true)
    }
    this.queued = []
    this.context.sink.dropPatches(this.key)
    this.queuePatches([boundsOf(buffer)], boundsOf(buffer))
    return resolved
  }

  /** The surface lost its buffer (null attach): nothing to read anymore. */
  bufferDetached(): void {
    this.queued = []
    this.context.sink.dropPatches(this.key)
  }

  destroy(): void {
    if (this._destroyed) {
      return
    }
    this._destroyed = true
    this.epoch++
    this.queued = []
    this.releaseLease()
    this.context.surfaces.delete(this)
  }

  /**
   * Take the next queued patch and read its pixels now. From here on its content is fixed, new damage over it is
   * queued again. Called by the patch pump when there is room to send.
   */
  capturePatch(): CapturedPatch | undefined {
    while (this.queued.length) {
      const buffer = this.host.currentBuffer()
      if (buffer === undefined) {
        this.queued = []
        return undefined
      }
      const rect = intersect(this.queued.shift()!, boundsOf(buffer))
      if (rect === undefined) {
        continue
      }
      const pixels = this.host.readPixels(rect)
      if (pixels === undefined) {
        // can't read this buffer's pixels: stream it as video instead
        this.patchUnsupported = true
        this.queued = []
        if (this._mode === 'slow') {
          this.switchTo('fast', buffer)
        } else {
          this.sendVideo(buffer, true)
        }
        return undefined
      }
      return {
        rect,
        pixels,
        surfaceSize: { width: buffer.width, height: buffer.height },
        serial: buffer.contentSerial,
        epoch: this.epoch,
      }
    }
    return undefined
  }

  isCurrent(epoch: number): boolean {
    return !this._destroyed && epoch === this.epoch
  }

  private usesVideo(buffer: BufferInfo): boolean {
    return this.patchUnsupported || !isSmall(buffer)
  }

  /** Switch modes if the measure says so. Returns the switch's encoding (if it switched). */
  private evaluate(now: number, buffer: BufferInfo): Promise<void> | undefined {
    if (this.patchUnsupported) {
      return undefined
    }
    const next = nextMode(this._mode, this.meter.pixelsPerSecond(now))
    if (next === this._mode) {
      return undefined
    }
    if (next === 'slow' && now - this.createdAt < INITIAL_FAST_MS) {
      return undefined
    }
    if (next === 'fast' && this.usesVideo(buffer) && this.lease === undefined && this.context.pool.available === 0) {
      // all video encoders are taken, stay on patches
      return undefined
    }
    return this.switchTo(next, buffer)
  }

  private switchTo(mode: EncodingMode, buffer: BufferInfo): Promise<void> {
    this._mode = mode
    this.epoch++
    this.queued = []
    const sink = this.context.sink
    if (mode === 'fast') {
      // unsent patches are superseded by the video key frame
      sink.dropPatches(this.key)
      return sink.active ? this.sendVideo(buffer, true) : resolved
    }
    this.releaseLease()
    // a crisp image of the whole surface replaces the video
    if (sink.active) {
      this.queuePatches([boundsOf(buffer)], boundsOf(buffer))
    }
    return resolved
  }

  private sendVideo(buffer: BufferInfo, keyFrame: boolean): Promise<void> {
    if (!this.usesVideo(buffer)) {
      this.releaseLease()
      this.queuePatches([boundsOf(buffer)], boundsOf(buffer))
      return resolved
    }
    if (this.lease === undefined) {
      this.lease = this.patchUnsupported ? this.context.pool.acquireAlways() : this.context.pool.acquire()
      if (this.lease === undefined) {
        // all video encoders are taken
        return this.switchTo('slow', buffer)
      }
      keyFrame = true
    }
    const sink = this.context.sink
    if (keyFrame) {
      sink.requireKeyFrame(this.key)
      this.lease.requestKeyUnit()
    }
    const epoch = this.epoch
    const encoding: Promise<void> = this.host.encodeVideo(this.lease, buffer).then(
      (frame) => {
        if (this.isCurrent(epoch) && sink.active) {
          sink.sendFrame(this.key, frame)
        }
      },
      (error: Error) => this.context.logger.error(`Video encoding of ${this.key} failed: ${error.message}`),
    )
    this.videoInFlight.add(encoding)
    return encoding.finally(() => this.videoInFlight.delete(encoding))
  }

  private queuePatches(damage: Rect[], bounds: Rect) {
    const patches = planPatches(damage, this.queued, bounds)
    if (patches.length) {
      this.queued.push(...patches)
      this.context.pump.schedule(this)
    }
  }

  private releaseLease() {
    if (this.lease) {
      this.context.pool.release(this.lease)
      this.lease = undefined
    }
  }
}

/**
 * Encodes queued patches when there is room to send them. Only a few are captured ahead of the network, so patches
 * wait in their surface's queue (where new damage merges with them) instead of in a send buffer.
 */
export class PatchPump {
  private readonly ready = new Set<PatchSource>()
  private inFlight = 0

  constructor(
    private readonly sink: EncodingSink,
    private readonly encodePng: (rgba: Uint8Array, width: number, height: number) => Promise<Uint8Array>,
    private readonly logger: Logger,
    private readonly maxInFlight = 3,
  ) {}

  /** patches captured and not yet handed to the network */
  get patchesInFlight(): number {
    return this.inFlight
  }

  schedule(surface: PatchSource): void {
    this.ready.add(surface)
    this.pump()
  }

  pump(): void {
    while (this.inFlight < this.maxInFlight && this.sink.active) {
      const next = this.ready.values().next()
      if (next.done) {
        return
      }
      const surface = next.value
      this.ready.delete(surface)
      if (surface.destroyed || !surface.hasQueuedPatches) {
        continue
      }
      const captured = surface.capturePatch()
      if (surface.hasQueuedPatches) {
        // back of the line, for fairness between surfaces
        this.ready.add(surface)
      }
      if (captured === undefined) {
        continue
      }
      this.inFlight++
      let finished = false
      const done = () => {
        if (!finished) {
          finished = true
          this.inFlight--
          this.pump()
        }
      }
      this.encodePng(captured.pixels, captured.rect.width, captured.rect.height).then(
        (png) => {
          if (!surface.isCurrent(captured.epoch) || !this.sink.active) {
            done()
            return
          }
          this.sink.sendPatch(
            surface.key,
            { contentSerial: captured.serial, surfaceSize: captured.surfaceSize, rect: captured.rect, png },
            done,
          )
        },
        (error: Error) => {
          this.logger.error(`Patch encoding of ${surface.key} failed: ${error.message}`)
          done()
        },
      )
    }
  }
}

/** State shared by all surfaces of a session. */
export class EncodingContext<V extends VideoEncoder = VideoEncoder> {
  readonly surfaces = new Set<SurfaceEncoder<V>>()
  readonly pump: PatchPump
  private ticker?: ReturnType<typeof setInterval>

  constructor(
    readonly sink: EncodingSink,
    readonly pool: EncoderPool<V>,
    encodePng: (rgba: Uint8Array, width: number, height: number) => Promise<Uint8Array>,
    readonly logger: Logger,
    readonly now: () => number = () => performance.now(),
  ) {
    this.pump = new PatchPump(sink, encodePng, logger)
  }

  /** Re-evaluate fast surfaces regularly, a surface that stops committing must still settle to patches. */
  startTicking(intervalMs = 200): void {
    if (this.ticker === undefined) {
      this.ticker = setInterval(() => this.tick(), intervalMs)
      this.ticker.unref?.()
    }
  }

  stopTicking(): void {
    if (this.ticker !== undefined) {
      clearInterval(this.ticker)
      this.ticker = undefined
    }
  }

  tick(): void {
    for (const surface of this.surfaces) {
      surface.tick()
    }
  }
}
