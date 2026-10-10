/**
 * A surface, as rendering sees it (see "The surface package" in docs/MODULARIZATION.md and "Encoding policy" in
 * ARCHITECTURE.md). It is in the normal or the streaming priority class, as its traffic-policy decision says (relentless
 * surfaces; see @nebula/traffic-policy). Its content goes out as patches of the damaged areas (its patch renderer), or,
 * for streaming surfaces when a hardware video encoder is free and the surface isn't small, as H.264 video of the whole
 * surface (its video renderer). A buffer that can't be read as pixels is always streamed as video, if there is an
 * encoder. The surface owns its renderers, creating each when it's first needed, and performs the switch: video start
 * drops the queued patches and makes the whole surface lossy; video stop sends a crisp lossless image of the whole
 * surface (unless it goes lossy again).
 * A surface encodes one item (a patch or a video frame) at a time, and starts the next only when its stream in the sink
 * is ready for it (at most about a chunk of its data waits to be sent).
 *
 * The surface reports to traffic policy what it measures the surface by: whether it is busy (has damage work unsent),
 * its commits, its predicted backlog (its patch renderer measures the surface's lossless bytes per pixel, so its unsent
 * damage predicts a backlog in bytes), and whether it is settled (a streaming surface is demoted only once it has no
 * damage left and is fully settled). Policy tells it when a burst promoted it. Native code is reached only through the
 * injected host and context, so this runs (and is tested) without it.
 */
import type {
  BufferInfo,
  ContextSurface,
  PatchRendererOwner,
  PeriodFractions,
  Rect,
  SurfaceClass,
  SurfaceContext,
  SurfaceHost,
  SurfaceTraffic,
  TrafficSource,
  VideoEncoder,
} from '@nebula/session-contracts'
import { MAX_PATCH_PIXELS, PatchRenderer, UNCOMPRESSED_BYTES_PER_PIXEL, area, clip } from '../patch-renderer/index.js'
import { VideoRenderer } from '../video-renderer/index.js'

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

export class Surface<V extends VideoEncoder = VideoEncoder> implements TrafficSource, ContextSurface {
  /** its traffic-policy decision (class, bottleneck), and where it reports what policy measures it by */
  private readonly traffic: SurfaceTraffic
  /** created when patches are first needed, kept for the surface's life (its lossy areas, its bytes per pixel) */
  private patches?: PatchRenderer
  /** created when video first starts; dropped once stopped and drained, created again on the next start */
  private video?: VideoRenderer<V>
  private unsupportedLogged = false
  private _destroyed = false
  /** what the renderers see of the surface */
  private readonly owner: PatchRendererOwner

  constructor(
    readonly key: string,
    private readonly host: SurfaceHost<V>,
    private readonly context: SurfaceContext<V>,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const surface = this
    this.owner = {
      get encoding() {
        return surface.encoding
      },
      next: () => this.next(),
      get maySettle() {
        // no video, and none left to send (it was lossy anyway)
        return !surface.video?.active && !surface.video?.hasDamageWork
      },
      // burst promotion: before the pump captures any of it, so a burst's first patches already go out lossy
      patchesQueued: () => this.context.traffic.checkBurst(),
      unreadable: () => {
        // stream it as video if there is an encoder, else it can't be shown
        if (this.startVideo() === undefined) {
          this.logUnsupported()
        }
        this.updateBusy()
      },
    }
    this.traffic = context.traffic.addSurface(this)
    context.addSurface(this)
  }

  /** its priority class, as traffic policy decided */
  get surfaceClass(): SurfaceClass {
    return this.traffic.surfaceClass
  }

  get destroyed(): boolean {
    return this._destroyed
  }

  /** An item of the surface (a patch or a video frame) is encoding: the next waits for it. */
  private get encoding(): boolean {
    return (this.patches?.encoding ?? false) || (this.video?.encoding ?? false)
  }

  /** It may start its next encode: nothing of it is encoding (one encode at a time) and its stream is ready. */
  get mayEncode(): boolean {
    return !this.encoding && this.context.sink.streamReady(this.key)
  }

  /** Patches are queued and may be captured (damage, or settling). */
  get hasQueuedPatches(): boolean {
    return this.patches?.hasQueuedPatches ?? false
  }

  /**
   * The app may draw its next frame now (its frame callbacks wait for this, see FramePacing.ts): its stream is ready.
   * Settling patches don't count unless damage is waiting already (new damage comes before settling).
   */
  get readyForFrame(): boolean {
    return this.context.sink.streamReady(this.key, !this.patches?.damageQueued)
  }

  /** the surface streams video now */
  get usesVideo(): boolean {
    return this.video?.active ?? false
  }

  /** Queued rectangles, captured or encoding items, or a video frame wanted: anything not handed to the socket yet. */
  get hasUnsentWork(): boolean {
    return this.hasDamageWork || (this.patches?.hasSettlingWork ?? false)
  }

  /** Unsent work except settling: what makes the surface busy (for traffic policy), and what settling waits for. */
  get hasDamageWork(): boolean {
    return (this.patches?.hasDamageWork ?? false) || (this.video?.hasDamageWork ?? false)
  }

  /** The surface's lossless bytes per pixel, as measured on its lossless patches (uncompressed before any). */
  get bytesPerPixel(): number {
    return this.patches?.bytesPerPixel ?? UNCOMPRESSED_BYTES_PER_PIXEL
  }

  /** The predicted size of its damage not handed to the sink yet (queued or encoding), at its lossless bytes per pixel. */
  get unencodedBytes(): number {
    return this.patches?.unencodedBytes ?? 0
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
    return !this.hasDamageWork && (this.usesVideo || this.lossyRegion.length === 0)
  }

  /**
   * Resolves when the video encodings in flight now are done. Patches copy their pixels right away, so after this no
   * encoding reads a buffer that was replaced before the call.
   */
  whenIdle(): Promise<void> {
    return this.video?.whenIdle() ?? resolved
  }

  /** Not-yet-captured patch rectangles, for tests. */
  get queuedPatches(): readonly Rect[] {
    return this.patches?.queuedPatches ?? []
  }

  /** The areas whose last update was lossy, for tests. */
  get lossyRegion(): readonly Rect[] {
    return this.patches?.lossyRegion ?? []
  }

  /** its patch renderer, created now if it hasn't been */
  private get patchRenderer(): PatchRenderer {
    return (this.patches ??= new PatchRenderer(this.key, this.host, this.traffic, this.owner, this.context))
  }

  /** The buffer can't be read as pixels (its patch renderer found): only video can show it. */
  private get unreadable(): boolean {
    return this.patches?.unreadable ?? false
  }

  /**
   * The surface committed a new buffer with this damage (buffer coordinates). Returns when no encoding still needs the
   * buffer.
   */
  commit(damage: Rect[]): Promise<void> {
    const result = this.commitNow(damage)
    this.patches?.settle()
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
      if (this.video?.active) {
        return this.video.request(false)
      }
      const started = this.startVideo()
      if (started) {
        return started
      }
    } else if (this.video?.active) {
      // no longer eligible (e.g. the surface became small): a crisp image of the whole surface replaces the video
      this.stopVideo(buffer)
      return resolved
    }
    if (this.unreadable) {
      this.logUnsupported()
      return resolved
    }
    this.patchRenderer.queue(damage, bounds)
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
      this.patches?.settle()
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
      if (this.video?.active) {
        return this.video.request(true)
      }
      const started = this.startVideo()
      if (started) {
        return started
      }
    }
    if (this.unreadable) {
      this.logUnsupported()
      return resolved
    }
    this.patchRenderer.refresh(boundsOf(buffer))
    this.updateBusy()
    return resolved
  }

  /** The surface lost its buffer (null attach): nothing to read anymore. */
  bufferDetached(): void {
    this.patches?.bufferDetached()
    this.video?.bufferDetached()
    this.updateBusy()
  }

  destroy(): void {
    if (this._destroyed) {
      return
    }
    this._destroyed = true
    this.patches?.destroy()
    this.video?.destroy()
    // (what's queued in the sink still goes out: the viewer ignores the items of surfaces it has forgotten)
    this.traffic.remove()
    this.context.removeSurface(this)
  }

  /** The surface's stream in the sink is ready for its next item (after the sink found it wasn't). */
  onStreamReady(): void {
    this.next()
  }

  /** Something the next item waited for happened (an encode ended, an item went out, the stream is ready): go on. */
  private next() {
    void this.video?.pump()
    this.patches?.settle()
    this.patches?.schedule()
    this.dropDrainedVideo()
    this.updateBusy()
  }

  /** Whether the surface should be streamed as video now (an encoder exists and it's streaming, or it can't be read). */
  private videoEligible(buffer: BufferInfo): boolean {
    if (this.context.pool.size === 0) {
      return false
    }
    return this.unreadable || (this.surfaceClass === 'streaming' && !isSmall(buffer))
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
      if (!this.usesVideo && this.videoEligible(buffer) && this.context.pool.available > 0) {
        return this.startVideo()
      }
      return undefined
    }
    if (this.usesVideo && !this.unreadable) {
      this.stopVideo(buffer)
      return resolved
    }
    return undefined
  }

  /** Traffic policy promoted the surface: a burst. It streams video if an encoder is free. */
  onPromoted(): void {
    const buffer = this.host.currentBuffer()
    if (buffer && !this.usesVideo && this.videoEligible(buffer) && this.context.pool.available > 0) {
      void this.startVideo()
    }
  }

  /**
   * Start streaming video, from a key frame (patches already handed to the sink go out first, the key frame paints
   * over them; those not captured yet are dropped). Undefined if there is no encoder to start it with.
   */
  private startVideo(): Promise<void> | undefined {
    const video = (this.video ??= new VideoRenderer(this.key, this.host, this.traffic, this.owner, this.context))
    if (!video.start(this.unreadable)) {
      this.dropDrainedVideo()
      return undefined
    }
    this.patches?.supersede()
    const buffer = this.host.currentBuffer()
    if (buffer) {
      // video is lossy all over
      this.patchRenderer.markAllLossy(boundsOf(buffer))
    }
    return video.request(true)
  }

  /** Stop the video: a crisp lossless image of the whole surface replaces it (unless the surface still goes lossy). */
  private stopVideo(buffer: BufferInfo) {
    this.video?.stop()
    this.patches?.supersede()
    if (this.context.sink.active) {
      // the whole surface is about to be sent, a lossy part of it marks itself again
      const patches = this.patchRenderer
      patches.clearLossy()
      patches.queue([boundsOf(buffer)], boundsOf(buffer))
    }
    this.dropDrainedVideo()
    this.updateBusy()
  }

  /** A stopped video renderer is let go once nothing of it is left (no frame encoding, unsent or wanted). */
  private dropDrainedVideo() {
    if (this.video?.drained) {
      this.video = undefined
    }
  }
}
