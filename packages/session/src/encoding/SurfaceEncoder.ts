/**
 * Per-surface encoding state machine (see "Encoding policy" in ARCHITECTURE.md). A surface is in the normal or the
 * streaming priority class, as its traffic-policy decision says (relentless surfaces; see @nebula/traffic-policy). Its
 * content goes out as patches of the damaged areas, or, for streaming surfaces when a hardware video encoder is
 * available, as H.264 video of the whole surface. Patches are lossless, except while the decision says the surface is
 * link-bound (a streaming surface while the link is short of bandwidth): those may be JPEG. The areas whose last update
 * was lossy (JPEG patches, video) are tracked, and a surface settles them: whenever it has no damage to send, it sends
 * them again losslessly, in the transport's lowest tier (new damage comes first).
 * A surface encodes one item (a patch or a video frame) at a time, and starts the next only when its stream in the sink
 * is ready for it (at most about a chunk of its data waits to be sent).
 *
 * The surface reports to traffic policy what it measures the surface by: whether it is busy (has damage work unsent),
 * its commits, its predicted backlog (each surface keeps an estimate of its lossless bytes per pixel, so its unsent
 * damage predicts a backlog in bytes), and whether it is settled (a streaming surface is demoted only once it has no
 * damage left and is fully settled). Policy tells it when a burst promoted it. Native code is reached only through the
 * injected host, sink and pool, so this runs (and is tested) without it.
 */
import { isLossyPatchFormat, type Patch } from '@gfld/scene-protocol'
import { PatchPump } from '@nebula/scheduler'
import type { EncoderPool } from '@nebula/video-codec'
import type {
  CapturedPatch,
  EncodedPatch,
  Frame,
  PatchEncode,
  PatchOrder,
  PatchShape,
  PatchSource,
  Rect,
  PeriodFractions,
  SendTier,
  StreamingEncodePool,
  SurfaceClass,
  SurfacePolicy,
  SurfaceTraffic,
  TrafficSource,
  VideoEncoder,
  VideoQuality,
} from '@nebula/session-contracts'
import { MAX_PATCH_PIXELS, MAX_PATCH_RECTS, planPatches } from './patch-plan.js'
import { area, boundingBox, clip, disjoint, intersect, subtract } from './region.js'

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
export type {
  CapturedPatch,
  PatchEncode,
  PatchOrder,
  PatchShape,
  PatchSource,
  StreamingEncodePool,
  VideoEncoder,
  VideoQuality,
}

/** Where encoded frames and patches go: the attached viewer. */
export interface EncodingSink {
  /** true if a viewer is attached; nothing is encoded without one */
  readonly active: boolean
  /** The bytes of the surface's items waiting to be sent, except settling patches. */
  queuedBytes(surface: string): number
  /**
   * Whether the surface's stream is ready for its next item (at most about one chunk of its data waits to be sent; see
   * ViewerTransport.streamReady). `exceptSettling`: its settling patches don't count. A stream found not ready gets
   * `onStreamReady` once it is.
   */
  streamReady(surface: string, exceptSettling?: boolean): boolean
  /** Set by the encoders: a surface's stream that `streamReady` found not ready is ready now. */
  onStreamReady?: (surface: string) => void
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
  /** Encodes a frame as video; the encoder takes the frame over and releases it once it has read it. */
  encodeVideo(encoder: V, frame: Frame): Promise<Uint8Array>
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

export class SurfaceEncoder<V extends VideoEncoder = VideoEncoder> implements PatchSource, TrafficSource {
  /** its traffic-policy decision (class, bottleneck), and where it reports what policy measures it by */
  private readonly traffic: SurfaceTraffic
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
  /** items captured (or video encoding started) and not yet handed to the socket or reported unsent */
  private unsentItems = 0
  /** an item (patch or video frame) of the surface is encoding: the next waits for it (one encode at a time) */
  private encodingNow = false
  /** the video needs a new frame (a key frame, or a delta of the latest content) as soon as its stream is ready */
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
  /** of the unsent items, the settling patches */
  private unsentSettling = 0
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
    this.traffic = context.traffic.addSurface(this)
    context.surfaces.add(this)
  }

  /** its priority class, as traffic policy decided */
  get surfaceClass(): SurfaceClass {
    return this.traffic.surfaceClass
  }

  get destroyed(): boolean {
    return this._destroyed
  }

  get hasQueuedPatches(): boolean {
    return this.queued.length > 0 || this.mayCaptureSettling
  }

  get sendTier(): SendTier {
    return this.traffic.sendTier(this.queued.length === 0)
  }

  get mayCapture(): boolean {
    return !this.encodingNow && this.context.sink.streamReady(this.key)
  }

  /**
   * The app may draw its next frame now (its frame callbacks wait for this, see FramePacing.ts): its stream is ready.
   * Settling patches don't count unless damage is waiting already (new damage comes before settling).
   */
  get readyForFrame(): boolean {
    return this.context.sink.streamReady(this.key, this.queued.length === 0)
  }

  /** the surface streams video now */
  get usesVideo(): boolean {
    return this.lease !== undefined
  }

  /** Queued rectangles, captured or encoding items, or a video frame wanted: anything not handed to the socket yet. */
  get hasUnsentWork(): boolean {
    return this.hasDamageWork || this.unsentSettling > 0 || this.settleQueue.length > 0
  }

  /** Unsent work except settling: what makes the surface busy (for traffic policy), and what settling waits for. */
  get hasDamageWork(): boolean {
    return this.queued.length > 0 || this.unsentItems > this.unsentSettling || this.videoWanted !== undefined
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

  /** the surface is backlogged (as traffic policy measures it) */
  get backlogged(): boolean {
    return this.traffic.backlogged
  }

  /** the busy and backlogged shares of the last completed period, for tests and logging */
  get lastPeriod(): PeriodFractions | undefined {
    return this.traffic.lastPeriod
  }

  /** It has a buffer and isn't destroyed: a burst can promote it. */
  get hasContent(): boolean {
    return this.host.currentBuffer() !== undefined && !this._destroyed
  }

  /** No damage left and fully settled (video: stopping it sends a crisp image): it may be demoted. */
  get settled(): boolean {
    return !this.hasDamageWork && (this.lease !== undefined || this.lossyArea.length === 0)
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

  /** New patches may be lossy: the surface is link-bound (a streaming surface while the link is short of bandwidth). */
  private get goesLossy(): boolean {
    return this.traffic.bottleneck === 'link'
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
    // measured by traffic policy, which may switch its class
    const switched = this.applyClass(this.traffic.committed(), buffer)
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
      void this.applyClass(this.traffic.evaluate(), buffer)
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
    this.traffic.remove()
    this.context.surfaces.delete(this)
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
      tier: this.traffic.sendTier(settle),
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

  encodeDone(captured: CapturedPatch): void {
    this.encodingNow = false
    this.encoding.delete(captured)
    this.next()
  }

  /** An item was handed to the socket or reported unsent (or discarded). */
  itemDone(captured?: CapturedPatch): void {
    if (captured) {
      this.encoding.delete(captured)
      if (captured.tier === 'settle' && this.unsentSettling > 0) {
        this.unsentSettling--
      }
    }
    if (this.unsentItems > 0) {
      this.unsentItems--
    }
    this.next()
  }

  /** The surface's stream in the sink is ready for its next item (after the sink found it wasn't). */
  onStreamReady(): void {
    this.next()
  }

  /** Something the next item waited for happened (an encode ended, an item went out, the stream is ready): go on. */
  private next() {
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
   * Settle: once the surface has no damage to send (none queued, encoding or unsent), plan its lossy areas as patches,
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

  /** Tell traffic policy whether the surface has damage to send now (settling doesn't count). */
  private updateBusy() {
    this.traffic.setBusy(this.hasDamageWork)
  }

  /**
   * Follow a class switch (`switched`: traffic policy just changed the class). Returns the switch's encoding if it sent
   * the surface's whole content (video start, crisp render); undefined if only the priority changed (or nothing).
   */
  private applyClass(switched: boolean, buffer: BufferInfo): Promise<void> | undefined {
    if (!switched) {
      return undefined
    }
    if (this.surfaceClass === 'streaming') {
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

  /** Traffic policy promoted the surface: a burst. It streams video if an encoder is free. */
  onPromoted(): void {
    const buffer = this.host.currentBuffer()
    if (buffer && this.lease === undefined && this.videoEligible(buffer) && this.context.pool.available > 0) {
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

  /**
   * Encode the video frame that is wanted, if nothing of the surface is encoding and its stream is ready (else when
   * both are: see next).
   */
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
    if (this.encodingNow || !sink.streamReady(this.key)) {
      return resolved
    }
    this.videoWanted = undefined
    // held only while it's encoded: the encoder releases it
    const frame = this.host.takeFrame()
    if (frame === undefined) {
      this.context.logger.error(`Video encoding of ${this.key} failed: no frame of its buffer can be taken.`)
      return resolved
    }
    this.unsentItems++
    this.encodingNow = true
    lease.setQuality(this.traffic.videoQuality)
    const epoch = this.epoch
    const surfaceClass = this.surfaceClass
    let released = false
    const release = () => {
      if (!released) {
        released = true
        this.itemDone()
      }
    }
    const finished = () => {
      this.encodingNow = false
      this.next()
    }
    const encoding: Promise<void> = this.host.encodeVideo(lease, frame).then(
      (frame) => {
        if (this.isCurrent(epoch) && sink.active) {
          sink.sendFrame(this.key, frame, surfaceClass, release)
        } else {
          release()
        }
        finished()
      },
      (error: Error) => {
        this.context.logger.error(`Video encoding of ${this.key} failed: ${error.message}`)
        release()
        finished()
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
      this.context.traffic.checkBurst()
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

/** State shared by all surfaces of a session. */
export class EncodingContext<V extends VideoEncoder = VideoEncoder> {
  readonly surfaces = new Set<SurfaceEncoder<V>>()
  readonly pump: PatchPump
  private ticker?: ReturnType<typeof setInterval>
  /** development only: the order surfaces capture their queued patches in */
  patchOrder: PatchOrder = 'oldest'
  /** development only: how large damage is split into patches */
  patchShape: PatchShape = 'bands'

  constructor(
    readonly sink: EncodingSink,
    readonly pool: EncoderPool<V>,
    encoders: { normal: PatchEncode; streaming: StreamingEncodePool },
    /** traffic policy: the surfaces' classes and bottlenecks (session-wide) */
    readonly traffic: SurfacePolicy,
    readonly logger: Logger,
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

  /**
   * Re-evaluate the surfaces' classes (traffic policy's) regularly, a surface that stops committing must still be
   * demoted.
   */
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
    // (lets traffic policy judge the link on time, when no surface asks)
    this.traffic.judgeLink()
    for (const surface of this.surfaces) {
      surface.tick()
    }
    this.traffic.checkBurst()
  }
}
