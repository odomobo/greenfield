/**
 * Per-surface encoding state machine (see "Encoding policy" in ARCHITECTURE.md). A surface is in the normal or the
 * streaming priority class (relentless surfaces, see RelentlessMeter). Its content goes out as patches of the damaged
 * areas, or, for streaming surfaces when a hardware video encoder is available, as H.264 video of the whole surface.
 * Patches are lossless, except a streaming surface's while the link is short of bandwidth (the sink says so): those may
 * be JPEG. The areas whose last update was lossy (JPEG patches, video) are tracked, and a surface settles them: whenever
 * it has no damage to send, it sends them again losslessly, in the transport's lowest tier (new damage comes first).
 * Each surface has a few slots for items (patches or video frames) between capture and the socket.
 *
 * Besides the time measure (RelentlessMeter), a normal surface is promoted by a burst: each surface keeps an estimate
 * of its lossless bytes per pixel, so its unsent damage predicts a backlog in bytes, and while the normal surfaces'
 * predicted backlog needs more than BURST_MS at the link's bandwidth (known once the link was limited), the one with
 * the largest is promoted (EncodingContext.checkBurst). A streaming surface is demoted only once it has no damage left
 * and is fully settled. Native code is reached only through the injected host, sink and pool, so this runs (and is
 * tested) without it.
 */
import { isLossyPatchFormat, type Patch } from '@gfld/scene-protocol'
import { EncoderPool } from './EncoderPool.js'
import type {
  EncodedPatch,
  Frame,
  PatchOrder,
  PatchShape,
  Rect,
  SendTier,
  SurfaceClass,
  VideoEncoder,
  VideoQuality,
} from '@nebula/session-contracts'
import { BURST_MS, MAX_PATCH_PIXELS, MAX_PATCH_RECTS, PeriodFractions, planPatches, RelentlessMeter } from './policy.js'
import { area, boundingBox, clip, disjoint, intersect, subtract } from './region.js'

/** Items (patches or video frames) of one surface that may exist between capture and the socket. */
export const SURFACE_SLOTS = 2
/** Patches of normal surfaces encoding at once (on libuv's thread pool). */
export const MAX_NORMAL_ENCODES = 4
/** A surface's lossy area in more pieces than this is tracked as its bounding box (refreshing a little more). */
export const MAX_LOSSY_RECTS = 32
/** A surface's lossless bytes per pixel before any lossless patch of it was measured: uncompressed RGBA. */
export const UNCOMPRESSED_BYTES_PER_PIXEL = 4
/** Weight of the older samples in a surface's lossless bytes per pixel (per patch). */
const BYTES_PER_PIXEL_DECAY = 0.8

export type BufferInfo = {
  bufferId: number
  creationSerial: number
  contentSerial: number
  width: number
  height: number
}

/** Shared types, re-exported for the code that has always imported them from here. */
export type { PatchOrder, PatchShape, VideoEncoder, VideoQuality }

/** Where encoded frames and patches go: the attached viewer. */
export interface EncodingSink {
  /** true if a viewer is attached; nothing is encoded without one */
  readonly active: boolean
  /** the link is short of bandwidth: streaming surfaces go lossy (JPEG patches, lower-quality video) */
  readonly bandwidthLimited: boolean
  /**
   * The link's bandwidth (bytes per ms) as measured when it was last bandwidth-limited; undefined if it never was on
   * this connection (an estimate of a link that was never full is only a lower bound).
   */
  readonly linkBandwidth: number | undefined
  /** The bytes of the surface's items waiting to be sent, except settling patches. */
  queuedBytes(surface: string): number
  /**
   * `done` must be called exactly once: when the frame was handed to the network (true) or not sent (false: the viewer
   * went away). A queued item is never dropped otherwise, also not when the surface is destroyed.
   */
  sendFrame(surface: string, frame: Uint8Array, surfaceClass: SurfaceClass, done: (sent: boolean) => void): void
  /**
   * `done` must be called exactly once: when the patch was handed to the network (true) or not sent (false). `tier`: the
   * surface's class, or settle for a settling patch.
   */
  sendPatch(surface: string, patch: Patch, tier: SendTier, done: (sent: boolean) => void): void
}

/** The surface's buffer, as the encoder sees it. */
export interface SurfaceHost<V extends VideoEncoder> {
  currentBuffer(): BufferInfo | undefined
  /** A frame of the current buffer, which the caller releases; undefined if it can't be taken. */
  takeFrame(): Frame | undefined
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

export type CapturedPatch = {
  rect: Rect
  pixels: Uint8Array
  opaque: boolean
  surfaceSize: { width: number; height: number }
  serial: number
  epoch: number
  /** the surface's class, or settle: a lossless resend of a lossy area */
  tier: SendTier
  /** may be encoded lossily (JPEG), if that's smaller */
  lossy: boolean
}

/** What the patch pump needs of a surface. */
export interface PatchSource {
  readonly key: string
  readonly destroyed: boolean
  readonly hasQueuedPatches: boolean
  readonly hasFreeSlot: boolean
  /** the tier of its next patch: its class for damage, settle when it settles */
  readonly sendTier: SendTier
  /** Takes a slot, which the pump gives back with `releaseSlot` once the patch is sent or reported unsent. */
  capturePatch(): CapturedPatch | undefined
  /** A captured patch goes to the sink now, encoded (called in capture order). */
  patchSending(captured: CapturedPatch, encoded: EncodedPatch): void
  /** The patch was handed to the socket, or reported unsent (sent or not). */
  releaseSlot(captured?: CapturedPatch): void
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
  /** slots in use: items captured (or video encoding started) and not yet handed to the socket or reported unsent */
  private slotsUsed = 0
  /** the video needs a new frame (a key frame, or a delta of the latest content) as soon as a slot is free */
  private videoWanted?: 'delta' | 'key'
  /** video encodings in flight, they still read their buffer */
  private readonly videoInFlight = new Set<Promise<void>>()
  /**
   * The areas whose last update sent was lossy (disjoint, at most MAX_LOSSY_RECTS): sent again losslessly once the
   * surface no longer goes lossy. Updated in send order, so a later lossless patch always clears what an earlier lossy
   * one marked (and never the other way round).
   */
  private lossyArea: Rect[] = []
  /** the batch each queued rectangle was queued in (see PatchOrder), and the next batch's number */
  private readonly batchOf = new WeakMap<Rect, number>()
  private nextBatch = 0
  /** the lossy areas to send again losslessly, as patches: captured when the surface has no damage to send */
  private settleQueue: Rect[] = []
  /** slots holding settling patches */
  private settleSlots = 0
  /** captured patches not handed to the sink yet (encoding) */
  private readonly encoding = new Set<CapturedPatch>()
  /** decayed sums of the surface's lossless patches (sizes encoded, pixels): its lossless bytes per pixel */
  private losslessBytes = 0
  private losslessPixels = 0

  constructor(
    readonly key: string,
    private readonly host: SurfaceHost<V>,
    private readonly context: EncodingContext<V>,
  ) {
    // demoted only once it has no damage left and is fully settled (video: stopping it sends a crisp image)
    this.meter = new RelentlessMeter(
      context.now(),
      undefined,
      () => !this.hasDamageWork && (this.lease !== undefined || this.lossyArea.length === 0),
    )
    context.surfaces.add(this)
  }

  get surfaceClass(): SurfaceClass {
    return this.appliedClass
  }

  get destroyed(): boolean {
    return this._destroyed
  }

  get hasQueuedPatches(): boolean {
    return this.queued.length > 0 || this.mayCaptureSettling
  }

  get sendTier(): SendTier {
    return this.queued.length > 0 ? this.surfaceClass : 'settle'
  }

  get hasFreeSlot(): boolean {
    return this.slotsUsed < SURFACE_SLOTS
  }

  /**
   * The app may draw its next frame now (its frame callbacks wait for this, see FramePacing.ts): a slot is free, or one
   * holds a settling patch (new damage comes before settling) and no damage is waiting for it already.
   */
  get readyForFrame(): boolean {
    return this.queued.length === 0 ? this.slotsUsed - this.settleSlots < SURFACE_SLOTS : this.hasFreeSlot
  }

  /** the surface streams video now */
  get usesVideo(): boolean {
    return this.lease !== undefined
  }

  /** Queued rectangles, captured or encoding items, or a video frame wanted: anything not handed to the socket yet. */
  get hasUnsentWork(): boolean {
    return this.hasDamageWork || this.settleSlots > 0 || this.settleQueue.length > 0
  }

  /** Unsent work except settling: what makes the surface busy (see RelentlessMeter), and what settling waits for. */
  get hasDamageWork(): boolean {
    return this.queued.length > 0 || this.slotsUsed > this.settleSlots || this.videoWanted !== undefined
  }

  /** The surface's lossless bytes per pixel, as measured on its lossless patches (uncompressed before any). */
  get bytesPerPixel(): number {
    return this.losslessPixels > 0 ? this.losslessBytes / this.losslessPixels : UNCOMPRESSED_BYTES_PER_PIXEL
  }

  /** The predicted size of its damage not handed to the sink yet (queued or encoding), at its lossless bytes per pixel. */
  get unencodedBytes(): number {
    let pixels = area(this.queued)
    for (const captured of this.encoding) {
      if (captured.tier !== 'settle') {
        pixels += captured.rect.width * captured.rect.height
      }
    }
    return pixels * this.bytesPerPixel
  }

  /** Its predicted backlog: the damage's bytes waiting in the sink, and those still to be encoded. Settling never counts. */
  get predictedBacklogBytes(): number {
    return this.context.sink.queuedBytes(this.key) + this.unencodedBytes
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

  /** The areas whose last update was lossy, for tests. */
  get lossyRegion(): readonly Rect[] {
    return this.lossyArea
  }

  /** New patches may be lossy: a streaming surface while the link is short of bandwidth. */
  private get goesLossy(): boolean {
    return this.surfaceClass === 'streaming' && this.context.sink.bandwidthLimited
  }

  /** A settling patch is queued and may be captured now. */
  private get mayCaptureSettling(): boolean {
    return this.settleQueue.length > 0 && this.canSettle
  }

  /** It may send its lossy areas again: it has no damage to send (and no video, which is lossy anyway). */
  private get canSettle(): boolean {
    return (
      !this.hasDamageWork &&
      this.lease === undefined &&
      !this.patchUnsupported &&
      !this._destroyed &&
      this.context.sink.active
    )
  }

  /**
   * The surface committed a new buffer with this damage (buffer coordinates). Returns when no encoding still needs the
   * buffer.
   */
  commit(damage: Rect[]): Promise<void> {
    const result = this.commitNow(damage)
    this.startSettling()
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
      this.startSettling()
      this.updateBusy()
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
    // (patches already handed to the sink still go out: the whole surface sent after them paints over them)
    this.queued = []
    this.queuePatches([boundsOf(buffer)], boundsOf(buffer))
    this.updateBusy()
    return resolved
  }

  /** The surface lost its buffer (null attach): nothing to read anymore. */
  bufferDetached(): void {
    this.queued = []
    this.settleQueue = []
    this.videoWanted = undefined
    this.updateBusy()
  }

  destroy(): void {
    if (this._destroyed) {
      return
    }
    this._destroyed = true
    this.epoch++
    this.queued = []
    this.settleQueue = []
    this.encoding.clear()
    this.videoWanted = undefined
    this.releaseLease()
    // (what's queued in the sink still goes out: the viewer ignores the items of surfaces it has forgotten)
    this.context.surfaces.delete(this)
  }

  /**
   * Take the next queued patch and read its pixels now, using a slot: damage first, else (with no damage left to
   * send) a settling patch. From here on its content is fixed, new damage over it is queued again. Called by the patch
   * pump when there is room to encode.
   */
  capturePatch(): CapturedPatch | undefined {
    if (!this.hasFreeSlot) {
      return undefined
    }
    while (this.queued.length) {
      const captured = this.capture(this.takeNext(this.queued), false)
      if (captured !== null) {
        return captured
      }
    }
    while (this.mayCaptureSettling) {
      const captured = this.capture(this.takeNext(this.settleQueue), true)
      if (captured !== null) {
        return captured
      }
    }
    return undefined
  }

  /**
   * Take the next rectangle of a queue (non-empty), in the context's patch order. Random: one of the oldest batch's.
   * Taking rectangles keeps the others in order, so its batch is the queue's first run of the same batch number.
   */
  private takeNext(queue: Rect[]): Rect {
    if (this.context.patchOrder === 'random') {
      const oldest = this.batchOf.get(queue[0])
      let count = 1
      while (count < queue.length && this.batchOf.get(queue[count]) === oldest) {
        count++
      }
      return queue.splice(Math.floor(Math.random() * count), 1)[0]
    }
    return queue.shift()!
  }

  /** Read a patch's pixels: undefined if it can't be (and none can), null if the rectangle is gone. */
  private capture(queued: Rect, settle: boolean): CapturedPatch | undefined | null {
    const buffer = this.host.currentBuffer()
    if (buffer === undefined) {
      this.queued = []
      this.settleQueue = []
      return undefined
    }
    const rect = intersect(queued, boundsOf(buffer))
    if (rect === undefined) {
      return null
    }
    // the frame is held only while its pixels are copied
    const frame = this.host.takeFrame()
    const read = frame?.readPixels(rect)
    frame?.release()
    if (read === undefined) {
      // can't read this buffer's pixels: stream it as video if there is an encoder, else it can't be shown
      this.patchUnsupported = true
      this.queued = []
      this.settleQueue = []
      if (this.startVideo() === undefined) {
        this.logUnsupported()
      }
      this.updateBusy()
      return undefined
    }
    this.slotsUsed++
    if (settle) {
      this.settleSlots++
    }
    const captured: CapturedPatch = {
      rect,
      pixels: read.pixels,
      opaque: read.opaque,
      surfaceSize: { width: buffer.width, height: buffer.height },
      serial: buffer.contentSerial,
      epoch: this.epoch,
      tier: settle ? 'settle' : this.surfaceClass,
      // settling is lossless, whatever the link
      lossy: !settle && this.goesLossy,
    }
    this.encoding.add(captured)
    return captured
  }

  patchSending(captured: CapturedPatch, encoded: EncodedPatch): void {
    this.encoding.delete(captured)
    const rect = captured.rect
    if (isLossyPatchFormat(encoded.format)) {
      this.markLossy([rect])
      return
    }
    if (this.lossyArea.length) {
      this.lossyArea = subtract(this.lossyArea, [rect])
    }
    this.losslessBytes = this.losslessBytes * BYTES_PER_PIXEL_DECAY + encoded.data.length
    this.losslessPixels = this.losslessPixels * BYTES_PER_PIXEL_DECAY + rect.width * rect.height
  }

  /** An item was handed to the socket or reported unsent (or discarded): its slot is free again. */
  releaseSlot(captured?: CapturedPatch): void {
    if (captured) {
      this.encoding.delete(captured)
      if (captured.tier === 'settle' && this.settleSlots > 0) {
        this.settleSlots--
      }
    }
    if (this.slotsUsed > 0) {
      this.slotsUsed--
    }
    void this.pumpVideo()
    this.startSettling()
    if (this.hasQueuedPatches && !this._destroyed) {
      this.context.pump.schedule(this)
    }
    this.updateBusy()
  }

  private markLossy(region: Rect[]) {
    let lossy = disjoint([...this.lossyArea, ...region])
    if (lossy.length > MAX_LOSSY_RECTS) {
      const box = boundingBox(lossy)
      lossy = box ? [box] : []
    }
    this.lossyArea = lossy
  }

  /**
   * Settle: once the surface has no damage to send (none queued, none in its slots), plan its lossy areas as patches,
   * sent again losslessly at the lowest tier, whatever the link. The areas stay lossy until those are sent (new damage
   * may make them lossy again, then they are planned again once the queue is done).
   */
  private startSettling() {
    if (this.lossyArea.length === 0 || this.settleQueue.length > 0 || !this.canSettle) {
      return
    }
    for (const captured of this.encoding) {
      if (captured.tier === 'settle') {
        // its area is still marked lossy: wait until it's sent
        return
      }
    }
    const buffer = this.host.currentBuffer()
    if (buffer === undefined) {
      return
    }
    this.settleQueue = this.plan(this.lossyArea, [], boundsOf(buffer))
    if (this.settleQueue.length) {
      this.context.logger.info?.(
        `Surface ${this.key}: sending its ${area(this.lossyArea)} lossy pixels again, losslessly (settling).`,
      )
      this.context.pump.schedule(this)
    }
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

  /** Tell the meter whether the surface has damage to send now (settling doesn't count). */
  private updateBusy() {
    const busy = this.hasDamageWork
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
   * Promote the surface now: a burst (see EncodingContext.checkBurst). `backlogMs`: the normal surfaces' predicted
   * backlog that made it, for the log.
   */
  promoteBurst(backlogMs: number): void {
    const buffer = this.host.currentBuffer()
    if (buffer === undefined || this._destroyed || this.appliedClass === 'streaming') {
      return
    }
    this.meter.promote()
    this.appliedClass = 'streaming'
    this.context.logger.info?.(
      `Surface ${this.key} is now streaming (a burst: the normal surfaces' predicted backlog is ${Math.round(backlogMs)} ms).`,
    )
    if (this.lease === undefined && this.videoEligible(buffer) && this.context.pool.available > 0) {
      void this.startVideo()
    }
  }

  /**
   * Start streaming video, from a key frame (patches already handed to the sink go out first, the key frame paints
   * over them). Undefined if there is no encoder to start it with.
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
    this.settleQueue = []
    this.encoding.clear()
    const buffer = this.host.currentBuffer()
    if (buffer) {
      // video is lossy all over
      this.lossyArea = [boundsOf(buffer)]
    }
    return this.requestVideo(true)
  }

  /** Stop the video: a crisp lossless image of the whole surface replaces it (unless the surface still goes lossy). */
  private stopVideo(buffer: BufferInfo) {
    this.releaseLease()
    this.videoWanted = undefined
    this.epoch++
    this.queued = []
    this.settleQueue = []
    this.encoding.clear()
    if (this.context.sink.active) {
      // the whole surface is about to be sent, a lossy part of it marks itself again
      this.lossyArea = []
      this.queuePatches([boundsOf(buffer)], boundsOf(buffer))
    }
    this.updateBusy()
  }

  private requestVideo(keyFrame: boolean): Promise<void> {
    if (keyFrame) {
      // the encoder's next frame is a key frame (video starts, or the viewer's decoder failed and asked for one)
      this.videoWanted = 'key'
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
    lease.setQuality(sink.bandwidthLimited ? 'low' : 'high')
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
    if (this.settleQueue.length) {
      // the damage replaces the settling patches it covers
      this.settleQueue = subtract(this.settleQueue, clip(damage, bounds))
    }
    const patches = this.plan(damage, this.queued, bounds)
    if (patches.length) {
      const batch = this.nextBatch++
      for (const patch of patches) {
        this.batchOf.set(patch, batch)
      }
      this.queued.push(...patches)
      // (before the pump captures any of it: a burst's first patches already go out lossy)
      this.context.checkBurst()
      this.context.pump.schedule(this)
    }
  }

  private plan(damage: Rect[], queued: Rect[], bounds: Rect): Rect[] {
    return planPatches(damage, queued, bounds, MAX_PATCH_PIXELS, MAX_PATCH_RECTS, this.context.patchShape)
  }

  private releaseLease() {
    if (this.lease) {
      this.context.pool.release(this.lease)
      this.lease = undefined
    }
  }
}

export type PatchEncode = (
  rgba: Uint8Array,
  width: number,
  height: number,
  opaque: boolean,
  lossy?: boolean,
) => Promise<EncodedPatch>

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
  private readonly ready: Record<SendTier, Set<PatchSource>> = {
    normal: new Set(),
    streaming: new Set(),
    settle: new Set(),
  }
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
    this.ready[surface.sendTier].add(surface)
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
        // settling shares the low priority pool with the streaming class, after it
        this.pumpClass('streaming')
        this.pumpClass('settle')
        this.pumpClass('normal')
      } while (this.again)
    } finally {
      this.pumping = false
    }
  }

  private hasCapacity(tier: SendTier): boolean {
    return tier === 'normal' ? this.normalEncodes < this.maxNormalEncodes : this.streaming.canAccept
  }

  private pumpClass(tier: SendTier) {
    const set = this.ready[tier]
    while (this.sink.active && this.hasCapacity(tier)) {
      const next = set.values().next()
      if (next.done) {
        return
      }
      const surface = next.value
      set.delete(surface)
      if (surface.destroyed || !surface.hasQueuedPatches) {
        continue
      }
      if (surface.sendTier !== tier) {
        // its class changed since it was scheduled, or it has damage again (or none left)
        this.ready[surface.sendTier].add(surface)
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
        this.ready[surface.sendTier].add(surface)
        this.again ||= surface.sendTier !== tier
      }
      if (captured === undefined) {
        continue
      }
      this.encode(surface, captured)
    }
  }

  private encode(surface: PatchSource, captured: ReturnType<PatchSource['capturePatch']> & object) {
    const tier = captured.tier
    let released = false
    const done = () => {
      if (!released) {
        released = true
        surface.releaseSlot(captured)
      }
    }
    let encoding: Promise<EncodedPatch>
    if (tier === 'normal') {
      this.normalEncodes++
      encoding = this.encodeNormal(captured.pixels, captured.rect.width, captured.rect.height, captured.opaque)
      const finished = () => {
        this.normalEncodes--
        this.pump()
      }
      encoding.then(finished, finished)
    } else {
      encoding = this.streaming.encode(
        captured.pixels,
        captured.rect.width,
        captured.rect.height,
        captured.opaque,
        captured.lossy,
      )
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
          surface.patchSending(captured, encoded)
          this.sink.sendPatch(
            surface.key,
            { contentSerial: captured.serial, surfaceSize: captured.surfaceSize, rect: captured.rect, ...encoded },
            tier,
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
  private checkingBurst = false
  /** development only: the order surfaces capture their queued patches in */
  patchOrder: PatchOrder = 'oldest'
  /** development only: how large damage is split into patches */
  patchShape: PatchShape = 'bands'

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
    // (reading it also lets the sink judge its bandwidth on time, when no surface asks)
    void this.sink.bandwidthLimited
    for (const surface of this.surfaces) {
      surface.tick()
    }
    this.checkBurst()
  }

  /** The surfaces' predicted backlog not handed to the sink yet (the sink adds what waits in it). */
  get unencodedBytes(): number {
    let bytes = 0
    for (const surface of this.surfaces) {
      bytes += surface.unencodedBytes
    }
    return bytes
  }

  /**
   * Burst promotion: while the normal surfaces' predicted backlog would take the link more than BURST_MS (at its
   * bandwidth as measured when it was last limited; never before it was), promote the one with the largest. Streaming
   * surfaces don't count: they don't push others out of the normal class.
   */
  checkBurst(): void {
    const bandwidth = this.sink.linkBandwidth
    if (bandwidth === undefined || bandwidth <= 0 || !this.sink.active || this.checkingBurst) {
      return
    }
    this.checkingBurst = true
    try {
      for (;;) {
        let total = 0
        let largest: SurfaceEncoder<V> | undefined
        let largestBytes = 0
        for (const surface of this.surfaces) {
          if (surface.surfaceClass !== 'normal' || surface.destroyed) {
            continue
          }
          const bytes = surface.predictedBacklogBytes
          total += bytes
          if (bytes > largestBytes) {
            largest = surface
            largestBytes = bytes
          }
        }
        if (largest === undefined || total <= BURST_MS * bandwidth) {
          return
        }
        largest.promoteBurst(total / bandwidth)
        if (largest.surfaceClass === 'normal') {
          // couldn't be promoted (no buffer)
          return
        }
      }
    } finally {
      this.checkingBurst = false
    }
  }
}
