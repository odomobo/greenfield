/**
 * The session-wide side of encoding: the resources the surfaces (packages/session/src/surface) and their renderers share
 * (the sink, the video encoder pool, the patch pump of @nebula/scheduler, traffic policy) and the tick that re-evaluates
 * the surfaces' classes. Session wiring.
 */
import { PatchPump } from '@nebula/scheduler'
import type { EncoderPool } from '@nebula/video-codec'
import type {
  ContextSurface,
  EncodingSink,
  PatchEncode,
  PatchOrder,
  PatchShape,
  RenderLogger,
  StreamingEncodePool,
  SurfaceContext,
  SurfacePolicy,
  VideoEncoder,
} from '@nebula/session-contracts'

/** State shared by all surfaces of a session. */
export class EncodingContext<V extends VideoEncoder = VideoEncoder> implements SurfaceContext<V> {
  readonly surfaces = new Set<ContextSurface>()
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
    readonly logger: RenderLogger,
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

  addSurface(surface: ContextSurface): void {
    this.surfaces.add(surface)
  }

  removeSurface(surface: ContextSurface): void {
    this.surfaces.delete(surface)
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
