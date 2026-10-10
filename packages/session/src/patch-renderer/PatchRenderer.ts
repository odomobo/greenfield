/**
 * A surface's patch renderer (see "Patch rendering" in docs/MODULARIZATION.md): its content goes out as patches of the
 * damaged areas. Damage is planned into patches and queued; a queued patch reads its pixels (from a frame, held only
 * while they are copied) when it's captured, so it always sends the latest content, and new damage over a queued patch
 * merges into it. The scheduler's patch pump captures and encodes the patches when there is room, one at a time (the
 * surface's one encode, see RendererOwner.encoding), only while the surface's stream is ready.
 *
 * Patches are lossless, except while the surface's traffic-policy decision says it is link-bound: those may be JPEG.
 * The areas whose last update was lossy are tracked, and the renderer settles them: whenever it has no damage to send
 * (and its owner lets it), it sends them again losslessly, in the transport's lowest tier (new damage comes first). It
 * also measures the surface's lossless bytes per pixel, which predicts the size of its unsent damage.
 *
 * It knows nothing about video: its owner (the surface) tells it when another renderer takes over the surface
 * (`supersede`) and when the whole surface counts as lossy.
 */
import { isLossyPatchFormat } from '@gfld/scene-protocol'
import type {
  CapturedPatch,
  EncodedPatch,
  FrameSource,
  PatchRendererContext,
  PatchRendererOwner,
  PatchSource,
  Rect,
  SendTier,
  TrafficDecision,
} from '@nebula/session-contracts'
import { MAX_PATCH_PIXELS, MAX_PATCH_RECTS, planPatches } from './patch-plan.js'
import { area, boundingBox, clip, disjoint, intersect, subtract } from './region.js'

/** A surface's lossy area in more pieces than this is tracked as its bounding box (refreshing a little more). */
export const MAX_LOSSY_RECTS = 32
/** A surface's lossless bytes per pixel before any lossless patch of it was measured: uncompressed RGBA. */
export const UNCOMPRESSED_BYTES_PER_PIXEL = 4
/** Weight of the older samples in a surface's lossless bytes per pixel (per patch). */
const BYTES_PER_PIXEL_DECAY = 0.8

export class PatchRenderer implements PatchSource {
  /** patches queued but not captured yet: they will read the latest pixels when they are */
  private queued: Rect[] = []
  /** bumped whenever queued content is superseded, results of encodings started before are dropped */
  private epoch = 0
  /** the buffer can't be read as pixels (e.g. an external-only dmabuf): patches can't show it */
  private _unreadable = false
  private _destroyed = false
  /** patches captured and not yet handed to the socket or reported unsent */
  private unsentItems = 0
  /** a patch is encoding: the surface's next item waits for it (one encode at a time) */
  private encodingNow = false
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
  /** of the unsent patches, the settling ones */
  private unsentSettling = 0
  /** captured patches not handed to the sink yet (encoding) */
  private readonly encodingPatches = new Set<CapturedPatch>()
  /** decayed sums of the surface's lossless patches (sizes encoded, pixels): its lossless bytes per pixel */
  private losslessBytes = 0
  private losslessPixels = 0

  constructor(
    readonly key: string,
    private readonly host: FrameSource,
    /** the surface's traffic-policy decision: its tier, and whether it is link-bound */
    private readonly decision: TrafficDecision,
    private readonly owner: PatchRendererOwner,
    private readonly context: PatchRendererContext,
  ) {}

  get destroyed(): boolean {
    return this._destroyed
  }

  /** The buffer can't be read as pixels (found when a patch was captured): patches can't show the surface. */
  get unreadable(): boolean {
    return this._unreadable
  }

  /** A patch is encoding. */
  get encoding(): boolean {
    return this.encodingNow
  }

  /** Damage is queued (not captured yet); settling patches don't count. */
  get damageQueued(): boolean {
    return this.queued.length > 0
  }

  get hasQueuedPatches(): boolean {
    return this.queued.length > 0 || this.mayCaptureSettling
  }

  get sendTier(): SendTier {
    return this.decision.sendTier(this.queued.length === 0)
  }

  get mayCapture(): boolean {
    return !this.owner.encoding && this.context.sink.streamReady(this.key)
  }

  /** Unsent damage: queued, captured or encoding patches, except settling ones. */
  get hasDamageWork(): boolean {
    return this.queued.length > 0 || this.unsentItems > this.unsentSettling
  }

  /** Settling not done: its patches queued, or captured and not handed to the socket yet. */
  get hasSettlingWork(): boolean {
    return this.unsentSettling > 0 || this.settleQueue.length > 0
  }

  /** The surface's lossless bytes per pixel, as measured on its lossless patches (uncompressed before any). */
  get bytesPerPixel(): number {
    return this.losslessPixels > 0 ? this.losslessBytes / this.losslessPixels : UNCOMPRESSED_BYTES_PER_PIXEL
  }

  /** The predicted size of its damage not handed to the sink yet (queued or encoding), at its lossless bytes per pixel. */
  get unencodedBytes(): number {
    let pixels = area(this.queued)
    for (const captured of this.encodingPatches) {
      if (captured.tier !== 'settle') {
        pixels += captured.rect.width * captured.rect.height
      }
    }
    return pixels * this.bytesPerPixel
  }

  /** Not-yet-captured patch rectangles, for tests. */
  get queuedPatches(): readonly Rect[] {
    return this.queued
  }

  /** The areas whose last update was lossy. */
  get lossyRegion(): readonly Rect[] {
    return this.lossyArea
  }

  /** New patches may be lossy: the surface is link-bound (a streaming surface while the link is short of bandwidth). */
  private get goesLossy(): boolean {
    return this.decision.bottleneck === 'link'
  }

  /** A settling patch is queued and may be captured now. */
  private get mayCaptureSettling(): boolean {
    return this.settleQueue.length > 0 && this.canSettle
  }

  /** It may send its lossy areas again: it has no damage to send (and the rest of the surface lets it). */
  private get canSettle(): boolean {
    return (
      !this.hasDamageWork && this.owner.maySettle && !this._unreadable && !this._destroyed && this.context.sink.active
    )
  }

  /** Queue the damage (buffer coordinates, within `bounds`, the buffer's) as patches. */
  queue(damage: Rect[], bounds: Rect): void {
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
      this.owner.patchesQueued()
      this.context.pump.schedule(this)
    }
  }

  /**
   * Send the whole surface again (`bounds`, the buffer's). Patches already handed to the sink still go out: the whole
   * surface sent after them paints over them.
   */
  refresh(bounds: Rect): void {
    this.queued = []
    this.queue([bounds], bounds)
  }

  /**
   * Another renderer takes over the surface, or hands it back: what's queued is dropped, and the results of encodings
   * started before are.
   */
  supersede(): void {
    this.epoch++
    this.queued = []
    this.settleQueue = []
    this.encodingPatches.clear()
  }

  /** The whole surface (`bounds`) counts as lossy now (another renderer sent it lossily). */
  markAllLossy(bounds: Rect): void {
    this.lossyArea = [bounds]
  }

  /** Nothing counts as lossy anymore (the whole surface is about to be sent again: a lossy part marks itself again). */
  clearLossy(): void {
    this.lossyArea = []
  }

  /** The surface lost its buffer (null attach): nothing to read anymore. */
  bufferDetached(): void {
    this.queued = []
    this.settleQueue = []
  }

  destroy(): void {
    this._destroyed = true
    this.epoch++
    this.queued = []
    this.settleQueue = []
    this.encodingPatches.clear()
  }

  /** Have the pump capture the next patch when there is room, if there is one. */
  schedule(): void {
    if (this.hasQueuedPatches && !this._destroyed) {
      this.context.pump.schedule(this)
    }
  }

  /**
   * Take the next queued patch and read its pixels now, starting the surface's one encode: damage first, else (with no
   * damage left to send) a settling patch. From here on its content is fixed, new damage over it is queued again.
   * Called by the patch pump when there is room to encode, and only while the surface may capture (see mayCapture).
   */
  capturePatch(): CapturedPatch | undefined {
    if (!this.mayCapture) {
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
    const rect = intersect(queued, { x: 0, y: 0, width: buffer.width, height: buffer.height })
    if (rect === undefined) {
      return null
    }
    // the frame is held only while its pixels are copied
    const frame = this.host.takeFrame()
    const read = frame?.readPixels(rect)
    frame?.release()
    if (read === undefined) {
      // can't read this buffer's pixels: the surface may stream it as video instead
      this._unreadable = true
      this.queued = []
      this.settleQueue = []
      this.owner.unreadable()
      return undefined
    }
    this.unsentItems++
    if (settle) {
      this.unsentSettling++
    }
    this.encodingNow = true
    const captured: CapturedPatch = {
      rect,
      pixels: read.pixels,
      opaque: read.opaque,
      surfaceSize: { width: buffer.width, height: buffer.height },
      serial: buffer.contentSerial,
      epoch: this.epoch,
      tier: this.decision.sendTier(settle),
      // settling is lossless, whatever the link
      lossy: !settle && this.goesLossy,
    }
    this.encodingPatches.add(captured)
    return captured
  }

  patchSending(captured: CapturedPatch, encoded: EncodedPatch): void {
    this.encodingPatches.delete(captured)
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

  encodeDone(captured: CapturedPatch): void {
    this.encodingNow = false
    this.encodingPatches.delete(captured)
    this.owner.next()
  }

  /** A patch was handed to the socket or reported unsent (or discarded). */
  itemDone(captured?: CapturedPatch): void {
    if (captured) {
      this.encodingPatches.delete(captured)
      if (captured.tier === 'settle' && this.unsentSettling > 0) {
        this.unsentSettling--
      }
    }
    if (this.unsentItems > 0) {
      this.unsentItems--
    }
    this.owner.next()
  }

  isCurrent(epoch: number): boolean {
    return !this._destroyed && epoch === this.epoch
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
   * Settle: once the surface has no damage to send (none queued, encoding or unsent), plan its lossy areas as patches,
   * sent again losslessly at the lowest tier, whatever the link. The areas stay lossy until those are sent (new damage
   * may make them lossy again, then they are planned again once the queue is done).
   */
  settle(): void {
    if (this.lossyArea.length === 0 || this.settleQueue.length > 0 || !this.canSettle) {
      return
    }
    for (const captured of this.encodingPatches) {
      if (captured.tier === 'settle') {
        // its area is still marked lossy: wait until it's sent
        return
      }
    }
    const buffer = this.host.currentBuffer()
    if (buffer === undefined) {
      return
    }
    this.settleQueue = this.plan(this.lossyArea, [], { x: 0, y: 0, width: buffer.width, height: buffer.height })
    if (this.settleQueue.length) {
      this.context.logger.info?.(
        `Surface ${this.key}: sending its ${area(this.lossyArea)} lossy pixels again, losslessly (settling).`,
      )
      this.context.pump.schedule(this)
    }
  }

  private plan(damage: Rect[], queued: Rect[], bounds: Rect): Rect[] {
    return planPatches(damage, queued, bounds, MAX_PATCH_PIXELS, MAX_PATCH_RECTS, this.context.patchShape)
  }
}
