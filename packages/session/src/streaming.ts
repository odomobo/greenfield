/**
 * The session's streaming wiring: creates the objects of the streaming packages (the video encoder pool, the patch worker
 * pools, traffic policy, frame pacing, the per-surface `Surface`s) and connects them to each other, to the compositor
 * (which only captures; it gets `createSurface` and the frame callback scheduler) and to the viewer host (which gets the
 * `SurfaceContent` and the pacing and traffic policy it feeds). See docs/MODULARIZATION.md.
 */
import { createLogger } from './Logger.js'
import { FramePacing, PatchPump } from '@nebula/scheduler'
import { EncoderPool, H264Encoder, type H264EncoderType } from '@nebula/video-codec'
import { Surface as RenderedSurface } from '@nebula/surface'
import { NORMAL_ENCODE_NICE, NORMAL_ENCODE_WORKERS, PatchWorkerPool } from '@nebula/patch-codec'
import { TrafficPolicy } from '@nebula/traffic-policy'
import type {
  ContextSurface,
  EncodingSink,
  Frame,
  PatchEncode,
  PatchOrder,
  PatchShape,
  RenderLogger,
  StreamingEncodePool,
  SurfaceContext,
  SurfaceHost,
  SurfacePolicy,
  VideoEncoder,
} from '@nebula/session-contracts'
import { ViewerHost, type SurfaceContent } from './viewer/ViewerHost.js'
import { WlrCompositor, type WlrNative } from './wlroots/WlrCompositor.js'
import { Apps } from './wlroots/Apps.js'
import type { SimulatedLink } from '@nebula/transport'

const logger = createLogger('streaming')

/** A pooled video encoder (H264Encoder of @nebula/video-codec in production): encodes frames, releasing them when done. */
export type FrameEncoder = VideoEncoder & { encode(frame: Frame): Promise<Uint8Array> }

const inactiveSink: EncodingSink = {
  active: false,
  queuedBytes: () => 0,
  streamReady: () => true,
  sendFrame: (_surface, _frame, _class, done) => done(false),
  sendPatch: (_surface, _patch, _tier, done) => done(false),
}

/** What the streaming needs from the compositor to resend a surface's content. */
export interface RenderedSurfaces {
  renderedSurface(key: string): RenderedSurface<FrameEncoder> | undefined
  renderedSurfaceKeys(): Iterable<string>
}

export interface StreamingConfig {
  h264Encoder?: H264EncoderType
  videoStreams: number
  patchOrder?: PatchOrder
  patchShape?: PatchShape
  /** creates the pool's video encoders (replaceable in tests) */
  createVideoEncoder?: (type: H264EncoderType) => FrameEncoder
}

export class Streaming {
  readonly framePacing = new FramePacing()
  /** traffic policy: the surfaces' classes and bottlenecks; the viewer connection gives it its link to judge */
  readonly traffic: TrafficPolicy
  private sink: EncodingSink = inactiveSink
  /** what the surfaces send into: the current sink */
  private readonly forwardingSink: EncodingSink
  private readonly encoding: EncodingContext<FrameEncoder>

  constructor(config: StreamingConfig) {
    const currentSink = () => this.sink
    this.forwardingSink = {
      get active() {
        return currentSink().active
      },
      queuedBytes: (surface) => this.sink.queuedBytes(surface),
      streamReady: (surface, exceptSettling) => this.sink.streamReady(surface, exceptSettling),
      sendFrame: (surface, frame, surfaceClass, done) => this.sink.sendFrame(surface, frame, surfaceClass, done),
      sendPatch: (surface, patch, tier, done) => this.sink.sendPatch(surface, patch, tier, done),
    }
    // without a hardware encoder the pool has size 0 and no video encoder is ever created; one that fails to create is
    // reported once and the pool then behaves the same
    const h264Encoder = config.h264Encoder
    const createVideoEncoder = config.createVideoEncoder ?? ((type: H264EncoderType) => new H264Encoder(type))
    const pool = new EncoderPool<FrameEncoder>(
      () => createVideoEncoder(h264Encoder!),
      h264Encoder ? config.videoStreams : 0,
      (error) =>
        logger.error(`Video encoder ${h264Encoder} is unavailable (${error.message}), sending lossless patches only.`),
    )
    pool.warm()
    const streamingPool = new PatchWorkerPool(logger)
    const normalPool = new PatchWorkerPool(logger, NORMAL_ENCODE_WORKERS, NORMAL_ENCODE_NICE)
    // the link judgment's lines are logged as the transport's: they were before the judgment moved out of it
    this.traffic = new TrafficPolicy({ logger, linkLogger: createLogger('viewer-transport') })
    this.encoding = new EncodingContext(
      this.forwardingSink,
      pool,
      {
        normal: (rgba, width, height, opaque) => normalPool.encode(rgba, width, height, opaque),
        streaming: streamingPool,
      },
      this.traffic,
      logger,
    )
    this.encoding.patchOrder = config.patchOrder ?? 'oldest'
    this.encoding.patchShape = config.patchShape ?? 'bands'
    this.encoding.startTicking()
  }

  /** Creates the rendered side of a new surface (the compositor's `createSurface`). */
  createSurface = (key: string, host: SurfaceHost<FrameEncoder>): RenderedSurface<FrameEncoder> =>
    new RenderedSurface(key, host, this.encoding)

  /** The viewer host's view of the surfaces' content, over the compositor's rendered surfaces. */
  contentOf(surfaces: RenderedSurfaces): SurfaceContent {
    const requestKeyFrame = (key: string) => {
      if (this.sink.active) {
        void surfaces.renderedSurface(key)?.refresh()
      }
    }
    return {
      setFrameSink: (sink) => {
        this.sink = sink
        sink.onStreamReady = (surface) => this.forwardingSink.onStreamReady?.(surface)
      },
      requestKeyFrame,
      requestKeyFramesForAllSurfaces: () => {
        for (const key of surfaces.renderedSurfaceKeys()) {
          requestKeyFrame(key)
        }
      },
    }
  }

  stop(): void {
    this.framePacing.stop()
  }
}

/** State shared by all surfaces of a session. */
class EncodingContext<V extends VideoEncoder = VideoEncoder> implements SurfaceContext<V> {
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

/** Start the session's Wayland side on wlroots, with its app processes, and the streaming of its surfaces. */
export function startWlrootsCompositor(config: {
  h264Encoder?: H264EncoderType
  videoStreams?: number
  /** development only: a simulated slow link to the viewer (see SimulatedLink) */
  link?: SimulatedLink
  /** development only: the order a surface's queued patches are captured in (see PatchOrder) */
  patchOrder?: PatchOrder
  /** development only: how large damage is split into patches (see PatchShape) */
  patchShape?: PatchShape
}): {
  viewerHost: ViewerHost
  compositor: WlrCompositor
  apps: Apps
} {
  // loaded here, not at import: tests use the policy with a fake core
  /* eslint-disable @typescript-eslint/no-var-requires */
  const native = require('./addons/wlr-core-addon') as WlrNative
  const { startPoll } = require('./addons/proxy-poll-addon') as typeof import('./addons/proxy-poll-addon')
  /* eslint-enable @typescript-eslint/no-var-requires */
  const streaming = new Streaming({
    h264Encoder: config.h264Encoder,
    videoStreams: config.videoStreams ?? 4,
    patchOrder: config.patchOrder,
    patchShape: config.patchShape,
  })
  const compositor = new WlrCompositor(
    { framePacing: streaming.framePacing, createSurface: streaming.createSurface },
    native,
    (fd, readable) => {
      startPoll(fd, readable)
    },
  )
  const apps = new Apps(compositor.waylandDisplay)
  apps.x11Display = compositor.x11Display
  compositor.clientListener = apps
  return {
    viewerHost: new ViewerHost(compositor, streaming.contentOf(compositor), {
      link: config.link,
      pacing: streaming.framePacing,
      traffic: streaming.traffic,
    }),
    compositor,
    apps,
  }
}
