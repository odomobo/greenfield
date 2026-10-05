/**
 * Per-surface encoding state machine (see "Encoding policy" in ROADMAP.md). A surface is in the normal or the
 * streaming priority class (relentless surfaces, see RelentlessMeter). Its content goes out as lossless patches of
 * the damaged areas, or, for streaming surfaces when a hardware video encoder is available, as H.264 video of the whole
 * surface. Each surface has a few slots for items (patches or video frames) between capture and the socket. Native code
 * is reached only through the injected host, sink and pool, so this runs (and is tested) without it.
 */
import type { Patch } from '@gfld/scene-protocol'
import { EncoderPool } from './EncoderPool.js'
import type { EncodedPatch } from './patch-encoder.js'
import { MAX_PATCH_PIXELS, PeriodFractions, planPatches, RelentlessMeter, SurfaceClass } from './policy.js'
import { area, clip, intersect, Rect } from './region.js'

/** Items (patches or video frames) of one surface that may exist between capture and the socket. */
export const SURFACE_SLOTS = 2
/** Patches of normal surfaces encoding at once (on libuv's thread pool). */
export const MAX_NORMAL_ENCODES = 4

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
  /** `done` must be called exactly once: when the frame was handed to the network (true) or dropped (false) */
  sendFrame(surface: string, frame: Uint8Array, surfaceClass: SurfaceClass, done: (sent: boolean) => void): void
  /** `done` must be called exactly once: when the patch was handed to the network (true) or dropped (false) */
  sendPatch(surface: string, patch: Patch, surfaceClass: SurfaceClass, done: (sent: boolean) => void): void
  /** drop everything unsent of the surface, its video restarts with a key frame */
  requireKeyFrame(surface: string): void
  dropPatches(surface: string): void
}

/** The surface's buffer, as the encoder sees it. */
export interface SurfaceHost<V extends VideoEncoder> {
  currentBuffer(): BufferInfo | undefined
  /**
   * RGBA pixels of a rectangle of the current buffer, a synchronous copy. `opaque`: all its alpha is 255 (the format
   * has no alpha, or the rectangle is in the surface's opaque region, or its alpha was scanned). undefined if it can't
   * be read.
   */
  readPixels(rect: Rect): { pixels: Uint8Array; opaque: boolean } | undefined
  encodeVideo(encoder: V, buffer: BufferInfo): Promise<Uint8Array>
}

export type Logger = { error(message: string): void; info?(message: string): void }

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
  opaque: boolean
  surfaceSize: { width: number; height: number }
  serial: number
  epoch: number
  surfaceClass: SurfaceClass
}

/** What the patch pump needs of a surface. */
export interface PatchSource {
  readonly key: string
  readonly destroyed: boolean
  readonly hasQueuedPatches: boolean
  readonly hasFreeSlot: boolean
  readonly surfaceClass: SurfaceClass
  /** Takes a slot, which the pump gives back with `releaseSlot` once the patch is sent or dropped. */
  capturePatch(): CapturedPatch | undefined
  releaseSlot(): void
  /** false if results captured at this epoch are stale (class switched, surface destroyed) */
  isCurrent(epoch: number): boolean
}

export class SurfaceEncoder<V extends VideoEncoder = VideoEncoder> implements PatchSource {
  private readonly meter: RelentlessMeter
  /** the class the surface's encoding follows now (the meter decides it at period ends, `evaluate` applies it) */
  private appliedClass: SurfaceClass = 'normal'
  /** patches queued but not captured yet: they will read the latest pixels when they are */
  private queued: Rect[] = []
  /** bumped whenever queued content is superseded (video start or stop), results of encodings started before are dropped */
  private epoch = 0
  private lease?: V
  /**
   * the buffer can't be read as pixels (e.g. an external-only dmabuf), only streamed as video, small ones too (the
   * encoder pads them). Without a video encoder it can't be shown at all.
   */
  private patchUnsupported = false
  private unsupportedLogged = false
  private _destroyed = false
  /** slots in use: items captured (or video encoding started) and not yet handed to the socket or dropped */
  private slotsUsed = 0
  /** the video needs a new frame (a key frame, or a delta of the latest content) as soon as a slot is free */
  private videoWanted?: 'delta' | 'key'
  /** video encodings in flight, they still read their buffer */
  private readonly videoInFlight = new Set<Promise<void>>()

  constructor(
    readonly key: string,
    private readonly host: SurfaceHost<V>,
    private readonly context: EncodingContext<V>,
  ) {
    this.meter = new RelentlessMeter(context.now())
    context.surfaces.add(this)
  }

  get surfaceClass(): SurfaceClass {
    return this.appliedClass
  }

  get destroyed(): boolean {
    return this._destroyed
  }

  get hasQueuedPatches(): boolean {
    return this.queued.length > 0
  }

  get hasFreeSlot(): boolean {
    return this.slotsUsed < SURFACE_SLOTS
  }

  /** the surface streams video now */
  get usesVideo(): boolean {
    return this.lease !== undefined
  }

  /** Queued rectangles, captured or encoding items, or a video frame wanted: anything not handed to the socket yet. */
  get hasUnsentWork(): boolean {
    return this.queued.length > 0 || this.slotsUsed > 0 || this.videoWanted !== undefined
  }

  /** the surface is backlogged (see RelentlessMeter) */
  get backlogged(): boolean {
    return this.meter.backlogged
  }

  /** the busy and backlogged shares of the last completed period, for tests and logging */
  get lastPeriod(): PeriodFractions | undefined {
    return this.meter.lastPeriod
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
    const result = this.commitNow(damage)
    this.updateBusy()
    return result
  }

  private commitNow(damage: Rect[]): Promise<void> {
    const buffer = this.host.currentBuffer()
    if (buffer === undefined || this._destroyed) {
      return resolved
    }
    const bounds = boundsOf(buffer)
    if (area(clip(damage, bounds)) === 0) {
      // nothing changed, nothing to send
      return resolved
    }
    if (!this.context.sink.active) {
      return resolved
    }
    const now = this.context.now()
    // backlogged if the last period was busy enough (the new work makes the surface busy, so it counts from now)
    this.meter.markBackloggedStart(now)
    const switched = this.evaluate(now, buffer)
    if (switched) {
      // a class switch that sends the whole surface covers this damage
      return switched
    }

    if (this.videoEligible(buffer)) {
      if (this.lease !== undefined) {
        return this.requestVideo(false)
      }
      const started = this.startVideo()
      if (started) {
        return started
      }
    } else if (this.lease !== undefined) {
      // no longer eligible (e.g. the surface became small): a crisp image of the whole surface replaces the video
      this.stopVideo(buffer)
      return resolved
    }
    if (this.patchUnsupported) {
      this.logUnsupported()
      return resolved
    }
    this.queuePatches(damage, bounds)
    return resolved
  }

  /**
   * Re-evaluate the class without a commit, so a surface that went quiet is demoted (and, with video, settles to a crisp
   * image).
   */
  tick(): void {
    const buffer = this.host.currentBuffer()
    if (buffer && !this._destroyed) {
      this.updateBusy()
      void this.evaluate(this.context.now(), buffer)
    }
  }

  /**
   * Send the whole surface again: a viewer attached, or its decoder needs a key frame. Returns when no encoding still
   * needs the buffer.
   */
  refresh(): Promise<void> {
    const result = this.refreshNow()
    this.updateBusy()
    return result
  }

  private refreshNow(): Promise<void> {
    const buffer = this.host.currentBuffer()
    if (buffer === undefined || this._destroyed || !this.context.sink.active) {
      return resolved
    }
    if (this.videoEligible(buffer)) {
      if (this.lease !== undefined) {
        return this.requestVideo(true)
      }
      const started = this.startVideo()
      if (started) {
        return started
      }
    }
    if (this.patchUnsupported) {
      this.logUnsupported()
      return resolved
    }
    this.queued = []
    this.context.sink.dropPatches(this.key)
    this.queuePatches([boundsOf(buffer)], boundsOf(buffer))
    this.updateBusy()
    return resolved
  }

  /** The surface lost its buffer (null attach): nothing to read anymore. */
  bufferDetached(): void {
    this.queued = []
    this.videoWanted = undefined
    this.context.sink.dropPatches(this.key)
    this.updateBusy()
  }

  destroy(): void {
    if (this._destroyed) {
      return
    }
    this._destroyed = true
    this.epoch++
    this.queued = []
    this.videoWanted = undefined
    this.releaseLease()
    this.context.surfaces.delete(this)
  }

  /**
   * Take the next queued patch and read its pixels now, using a slot. From here on its content is fixed, new damage
   * over it is queued again. Called by the patch pump when there is room to encode.
   */
  capturePatch(): CapturedPatch | undefined {
    if (!this.hasFreeSlot) {
      return undefined
    }
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
      const read = this.host.readPixels(rect)
      if (read === undefined) {
        // can't read this buffer's pixels: stream it as video if there is an encoder, else it can't be shown
        this.patchUnsupported = true
        this.queued = []
        if (this.startVideo() === undefined) {
          this.logUnsupported()
        }
        this.updateBusy()
        return undefined
      }
      this.slotsUsed++
      return {
        rect,
        pixels: read.pixels,
        opaque: read.opaque,
        surfaceSize: { width: buffer.width, height: buffer.height },
        serial: buffer.contentSerial,
        epoch: this.epoch,
        surfaceClass: this.surfaceClass,
      }
    }
    return undefined
  }

  /** An item was handed to the socket or dropped: its slot is free again. */
  releaseSlot(): void {
    if (this.slotsUsed > 0) {
      this.slotsUsed--
    }
    if (this.queued.length && !this._destroyed) {
      this.context.pump.schedule(this)
    }
    void this.pumpVideo()
    this.updateBusy()
  }

  isCurrent(epoch: number): boolean {
    return !this._destroyed && epoch === this.epoch
  }

  /** Whether the surface should be streamed as video now (an encoder exists and it's streaming, or it can't be read). */
  private videoEligible(buffer: BufferInfo): boolean {
    if (this.context.pool.size === 0) {
      return false
    }
    return this.patchUnsupported || (this.surfaceClass === 'streaming' && !isSmall(buffer))
  }

  private logUnsupported() {
    if (!this.unsupportedLogged) {
      this.unsupportedLogged = true
      this.context.logger.error(
        `The buffer of ${this.key} can't be read as pixels and there is no video encoder, so it isn't shown.`,
      )
    }
  }

  /** Tell the meter whether the surface has unsent work now. */
  private updateBusy() {
    const busy = this.hasUnsentWork
    if (busy && !this.meter.busy) {
      this.meter.markBusyStart(this.context.now())
    } else if (!busy && this.meter.busy) {
      this.meter.markBusyEnd(this.context.now())
    }
  }

  /**
   * Switch classes if the measure says so. Returns the switch's encoding if it sent the surface's whole content (video
   * start, crisp render); undefined if only the priority changed (or nothing).
   */
  private evaluate(now: number, buffer: BufferInfo): Promise<void> | undefined {
    const after = this.meter.evaluate(now)
    if (after === this.appliedClass) {
      return undefined
    }
    this.appliedClass = after
    const last = this.meter.lastPeriod
    this.context.logger.info?.(
      `Surface ${this.key} is now ${after} (last period: busy ${Math.round((last?.busy ?? 0) * 100)}%, backlogged ${Math.round((last?.backlogged ?? 0) * 100)}%).`,
    )
    if (after === 'streaming') {
      // video only if an encoder is free; otherwise it stays on patches, with low priority
      if (this.lease === undefined && this.videoEligible(buffer) && this.context.pool.available > 0) {
        return this.startVideo()
      }
      return undefined
    }
    if (this.lease !== undefined && !this.patchUnsupported) {
      this.stopVideo(buffer)
      return resolved
    }
    return undefined
  }

  /**
   * Start streaming video: unsent patches are superseded by the key frame. Undefined if there is no encoder to start
   * it with.
   */
  private startVideo(): Promise<void> | undefined {
    if (this.lease === undefined) {
      this.lease = this.patchUnsupported ? this.context.pool.acquireAlways() : this.context.pool.acquire()
      if (this.lease === undefined) {
        return undefined
      }
    }
    this.epoch++
    this.queued = []
    this.context.sink.dropPatches(this.key)
    return this.requestVideo(true)
  }

  /** Stop the video: a crisp lossless image of the whole surface replaces it. */
  private stopVideo(buffer: BufferInfo) {
    this.releaseLease()
    this.videoWanted = undefined
    this.epoch++
    this.queued = []
    if (this.context.sink.active) {
      this.queuePatches([boundsOf(buffer)], boundsOf(buffer))
    }
    this.updateBusy()
  }

  private requestVideo(keyFrame: boolean): Promise<void> {
    if (keyFrame) {
      this.videoWanted = 'key'
      this.context.sink.requireKeyFrame(this.key)
      this.lease?.requestKeyUnit()
    } else {
      this.videoWanted ??= 'delta'
    }
    return this.pumpVideo()
  }

  /** Encode the video frame that is wanted, if a slot is free (else when one is: see releaseSlot). */
  private pumpVideo(): Promise<void> {
    const lease = this.lease
    const sink = this.context.sink
    if (this.videoWanted === undefined || lease === undefined || this._destroyed) {
      return resolved
    }
    const buffer = this.host.currentBuffer()
    if (!sink.active || buffer === undefined) {
      this.videoWanted = undefined
      return resolved
    }
    if (!this.hasFreeSlot) {
      return resolved
    }
    this.videoWanted = undefined
    this.slotsUsed++
    const epoch = this.epoch
    const surfaceClass = this.surfaceClass
    let released = false
    const release = () => {
      if (!released) {
        released = true
        this.releaseSlot()
      }
    }
    const encoding: Promise<void> = this.host.encodeVideo(lease, buffer).then(
      (frame) => {
        if (this.isCurrent(epoch) && sink.active) {
          sink.sendFrame(this.key, frame, surfaceClass, release)
        } else {
          release()
        }
      },
      (error: Error) => {
        this.context.logger.error(`Video encoding of ${this.key} failed: ${error.message}`)
        release()
      },
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

export type PatchEncode = (rgba: Uint8Array, width: number, height: number, opaque: boolean) => Promise<EncodedPatch>

/** A pool of worker threads that encodes patches (PatchWorkerPool): the low priority one is the streaming class's. */
export interface StreamingEncodePool {
  encode: PatchEncode
  /** whether another patch may be captured for it: a worker is free, or about to be */
  readonly canAccept: boolean
  /** set by the pump: called when `canAccept` may have changed */
  onCapacity?: () => void
}

/**
 * Encodes queued patches when there is room: a free slot in the surface, and an encoder free in the surface's class's
 * pool. Patches wait in their surface's queue (where new damage merges into them) instead of in a send buffer.
 */
export class PatchPump {
  private readonly ready: Record<SurfaceClass, Set<PatchSource>> = { normal: new Set(), streaming: new Set() }
  private normalEncodes = 0
  private pumping = false
  private again = false
  /**
   * Per surface, the last captured patch's send. Encodings finish in any order, but a surface's patches must be sent
   * in capture order: a newer patch can overlap an older one, and the older one must not be drawn over it.
   */
  private readonly sendTails = new Map<PatchSource, Promise<void>>()

  constructor(
    private readonly sink: EncodingSink,
    private readonly encodeNormal: PatchEncode,
    private readonly streaming: StreamingEncodePool,
    private readonly logger: Logger,
    private readonly maxNormalEncodes = MAX_NORMAL_ENCODES,
  ) {
    streaming.onCapacity = () => this.pump()
  }

  /** normal patches encoding right now */
  get normalEncoding(): number {
    return this.normalEncodes
  }

  schedule(surface: PatchSource): void {
    this.ready[surface.surfaceClass].add(surface)
    this.pump()
  }

  pump(): void {
    if (this.pumping) {
      // a pump is running up the stack (a synchronous callback): it goes round again
      this.again = true
      return
    }
    this.pumping = true
    try {
      do {
        this.again = false
        this.pumpClass('streaming')
        this.pumpClass('normal')
      } while (this.again)
    } finally {
      this.pumping = false
    }
  }

  private hasCapacity(surfaceClass: SurfaceClass): boolean {
    return surfaceClass === 'streaming' ? this.streaming.canAccept : this.normalEncodes < this.maxNormalEncodes
  }

  private pumpClass(surfaceClass: SurfaceClass) {
    const set = this.ready[surfaceClass]
    while (this.sink.active && this.hasCapacity(surfaceClass)) {
      const next = set.values().next()
      if (next.done) {
        return
      }
      const surface = next.value
      set.delete(surface)
      if (surface.destroyed || !surface.hasQueuedPatches) {
        continue
      }
      if (surface.surfaceClass !== surfaceClass) {
        // its class changed since it was scheduled
        this.ready[surface.surfaceClass].add(surface)
        this.again = true
        continue
      }
      if (!surface.hasFreeSlot) {
        // scheduled again when one of its items is sent
        continue
      }
      const captured = surface.capturePatch()
      if (surface.hasQueuedPatches) {
        // back of the line, for fairness between surfaces
        set.add(surface)
      }
      if (captured === undefined) {
        continue
      }
      this.encode(surface, captured)
    }
  }

  private encode(surface: PatchSource, captured: ReturnType<PatchSource['capturePatch']> & object) {
    const surfaceClass = captured.surfaceClass
    let released = false
    const done = () => {
      if (!released) {
        released = true
        surface.releaseSlot()
      }
    }
    let encoding: Promise<EncodedPatch>
    if (surfaceClass === 'normal') {
      this.normalEncodes++
      encoding = this.encodeNormal(captured.pixels, captured.rect.width, captured.rect.height, captured.opaque)
      const finished = () => {
        this.normalEncodes--
        this.pump()
      }
      encoding.then(finished, finished)
    } else {
      encoding = this.streaming.encode(captured.pixels, captured.rect.width, captured.rect.height, captured.opaque)
    }
    const previous = this.sendTails.get(surface) ?? resolved
    const tail = previous
      .then(() => encoding)
      .then(
        (encoded) => {
          if (!surface.isCurrent(captured.epoch) || !this.sink.active) {
            done()
            return
          }
          this.sink.sendPatch(
            surface.key,
            { contentSerial: captured.serial, surfaceSize: captured.surfaceSize, rect: captured.rect, ...encoded },
            surfaceClass,
            done,
          )
        },
        (error: Error) => {
          this.logger.error(`Patch encoding of ${surface.key} failed: ${error.message}`)
          done()
        },
      )
    this.sendTails.set(surface, tail)
    void tail.then(() => {
      if (this.sendTails.get(surface) === tail) {
        this.sendTails.delete(surface)
      }
    })
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
    encoders: { normal: PatchEncode; streaming: StreamingEncodePool },
    readonly logger: Logger,
    readonly now: () => number = () => performance.now(),
  ) {
    this.pump = new PatchPump(sink, encoders.normal, encoders.streaming, logger)
  }

  /** Re-evaluate the surfaces' classes regularly, a surface that stops committing must still be demoted. */
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
