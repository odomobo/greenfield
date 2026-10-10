/**
 * A surface's video renderer (see "Video rendering" in docs/MODULARIZATION.md): while it runs, the whole surface goes
 * out as H.264 video, encoded by a video encoder leased from the session's pool. Frames are made on demand: when a frame
 * is wanted (new content, or a key frame), nothing of the surface is encoding and its stream is ready, it takes a frame
 * of the surface's buffer, which the encoder holds only while it reads it. Frames wanted meanwhile become one frame of
 * the latest content. The first frame after a start is a key frame, and so is the next one after a viewer's decoder
 * asked for one (recovery). The quality follows the surface's traffic-policy decision.
 *
 * It knows nothing about patches: its owner (the surface) starts and stops it.
 */
import type {
  RendererOwner,
  SurfaceHost,
  TrafficDecision,
  VideoEncoder,
  VideoRendererContext,
} from '@nebula/session-contracts'

const resolved = Promise.resolve()

export class VideoRenderer<V extends VideoEncoder = VideoEncoder> {
  /** bumped on every start and stop, results of encodings started before are dropped */
  private epoch = 0
  private lease?: V
  private _destroyed = false
  /** frames encoding or encoded and not yet handed to the socket or reported unsent */
  private unsentFrames = 0
  /** a frame is encoding: the surface's next item waits for it (one encode at a time) */
  private encodingNow = false
  /** a new frame is wanted (a key frame, or a delta of the latest content) as soon as the stream is ready */
  private wanted?: 'delta' | 'key'
  /** encodings in flight, they still read their buffer */
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    readonly key: string,
    private readonly host: SurfaceHost<V>,
    /** the surface's traffic-policy decision: its class, and the video quality */
    private readonly decision: TrafficDecision,
    private readonly owner: RendererOwner,
    private readonly context: VideoRendererContext<V>,
  ) {}

  /** It runs: it has an encoder. */
  get active(): boolean {
    return this.lease !== undefined
  }

  /** A frame is encoding. */
  get encoding(): boolean {
    return this.encodingNow
  }

  /** A frame is wanted, encoding or not sent yet. */
  get hasDamageWork(): boolean {
    return this.unsentFrames > 0 || this.wanted !== undefined
  }

  /** Stopped, and nothing of it is left: no frame encoding, unsent or wanted. */
  get drained(): boolean {
    return this.lease === undefined && !this.encodingNow && !this.hasDamageWork
  }

  /** Resolves when the encodings in flight now are done. */
  whenIdle(): Promise<void> {
    return this.inFlight.size ? Promise.all(this.inFlight).then(() => undefined) : resolved
  }

  /**
   * Start (or start again): lease an encoder (`always`: even beyond the pool's size, for a surface that can't be sent
   * any other way). false if there is none to lease. The caller then asks for a key frame.
   */
  start(always: boolean): boolean {
    if (this.lease === undefined) {
      const pool = this.context.pool
      this.lease = always ? pool.acquireAlways() : pool.acquire()
      if (this.lease === undefined) {
        return false
      }
    }
    this.epoch++
    return true
  }

  /** Stop: the encoder goes back to the pool, a frame encoding now is dropped when done. */
  stop(): void {
    this.releaseLease()
    this.wanted = undefined
    this.epoch++
  }

  /** The surface lost its buffer (null attach): no frame is wanted anymore. */
  bufferDetached(): void {
    this.wanted = undefined
  }

  destroy(): void {
    this._destroyed = true
    this.epoch++
    this.wanted = undefined
    this.releaseLease()
  }

  /**
   * Want a frame: a key frame (video starts, or the viewer's decoder failed and asked for one), else a delta of the
   * latest content. Returns the encoding if it started now.
   */
  request(keyFrame: boolean): Promise<void> {
    if (keyFrame) {
      // the encoder's next frame is a key frame
      this.wanted = 'key'
      this.lease?.requestKeyUnit()
    } else {
      this.wanted ??= 'delta'
    }
    return this.pump()
  }

  /**
   * Encode the frame that is wanted, if nothing of the surface is encoding and its stream is ready (else when both are:
   * the owner calls this again).
   */
  pump(): Promise<void> {
    const lease = this.lease
    const sink = this.context.sink
    if (this.wanted === undefined || lease === undefined || this._destroyed) {
      return resolved
    }
    const buffer = this.host.currentBuffer()
    if (!sink.active || buffer === undefined) {
      this.wanted = undefined
      return resolved
    }
    if (this.owner.encoding || !sink.streamReady(this.key)) {
      return resolved
    }
    this.wanted = undefined
    // held only while it's encoded: the encoder releases it
    const frame = this.host.takeFrame()
    if (frame === undefined) {
      this.context.logger.error(`Video encoding of ${this.key} failed: no frame of its buffer can be taken.`)
      return resolved
    }
    this.unsentFrames++
    this.encodingNow = true
    lease.setQuality(this.decision.videoQuality)
    const epoch = this.epoch
    const surfaceClass = this.decision.surfaceClass
    let released = false
    const release = () => {
      if (!released) {
        released = true
        if (this.unsentFrames > 0) {
          this.unsentFrames--
        }
        this.owner.next()
      }
    }
    const finished = () => {
      this.encodingNow = false
      this.owner.next()
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
    this.inFlight.add(encoding)
    return encoding.finally(() => this.inFlight.delete(encoding))
  }

  private isCurrent(epoch: number): boolean {
    return !this._destroyed && epoch === this.epoch
  }

  private releaseLease() {
    if (this.lease) {
      this.context.pool.release(this.lease)
      this.lease = undefined
    }
  }
}
