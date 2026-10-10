/**
 * The shared types between the session's packages (see "Packages and enforced boundaries" in docs/MODULARIZATION.md).
 * Types and tiny pure helpers only, no implementation logic.
 */
import type { Patch, PatchFormat, ViewerAck } from '@gfld/scene-protocol'

/** A rectangle in pixels. */
export type Rect = { x: number; y: number; width: number; height: number }

/** How a large area is split into patches: full-width bands, or tiles. */
export type PatchShape = 'bands' | 'tiles'

/**
 * The order a surface's queued patches (damage, and settling) are captured in: oldest first, or (an experiment, the
 * gateway's --dev-patch-order) at random within batches: each commit's new patches are a batch (and settling's plan
 * one), batches go oldest first, the patches of a batch in random order. So a large repaint fills in as a random mosaic,
 * and no patch waits for more than the patches queued before or with it. Either is correct: queued rectangles are
 * disjoint and read the latest pixels when captured, so only the order the viewer sees a repaint arrive in changes.
 */
export type PatchOrder = 'oldest' | 'random'

/** A surface's priority class: normal, or streaming when it is relentless (see "Encoding policy" in ARCHITECTURE.md). */
export type SurfaceClass = 'normal' | 'streaming'

/**
 * The transport's send tiers (deficit round-robin): the two classes, and below them settling, the lossless resend of a
 * surface's lossy areas.
 */
export type SendTier = SurfaceClass | 'settle'

/** An encoded patch. */
export type EncodedPatch = {
  format: PatchFormat
  /** 3 if the patch was encoded as opaque (RGB, or a JPEG without alpha), else 4 */
  channels: 3 | 4
  data: Uint8Array
}

/** Video has a fixed quality target (and a variable bitrate): higher, or lower while bandwidth is short. */
export type VideoQuality = 'high' | 'low'

/**
 * A frame: a surface's content at a point in time, holding its buffer until released (see "Frames" in
 * docs/MODULARIZATION.md). Created by capture, consumed by the renderers; everything in between passes it through.
 * Native consumers recognize it by its type tag (packages/frames/native/include/nebula_frame.h).
 */
export interface Frame {
  /** in buffer pixels */
  readonly width: number
  readonly height: number
  /** the surface's content serial: increases with every new buffer content */
  readonly contentSerial: number
  /**
   * RGBA pixels of a rectangle of the frame, a copy. `opaque`: all its alpha is 255 (the format has no alpha, or the
   * rectangle is in the surface's opaque region when the frame was taken, or its alpha was scanned). undefined if it
   * can't be read this way (e.g. GPU memory), the rectangle isn't inside the frame, or the frame was released.
   */
  readPixels(rect: Rect): { pixels: Uint8Array; opaque: boolean } | undefined
  /** Drops this handle's hold on the buffer, as soon as it's no longer read. Later calls do nothing. */
  release(): void
}

export interface VideoEncoder {
  requestKeyUnit(): void
  /** the quality of the frames encoded from now on (cheap when it doesn't change) */
  setQuality(quality: VideoQuality): void
  destroy(): void
}

/**
 * What the transport needs of a congestion controller: pacing and an in-flight limit for the data items (patches and
 * frames) sent to one viewer, driven by the viewer's acks (see "Congestion estimation" in docs/MODULARIZATION.md). Pure:
 * the caller passes the time (ms) to every call. Control messages never go through it.
 */
export interface Congestion {
  /** May a data item of this size be handed to the socket now? */
  canSend(bytes: number, now: number): boolean
  /**
   * The earliest time a data item of this size may be sent without waiting for an ack: the pacing time if the window
   * allows it, Infinity if only an ack can allow it.
   */
  nextSendTime(bytes: number, now: number): number
  /** A data item of this size was handed to the socket. */
  onSend(bytes: number, now: number): void
  /** The viewer's ACK report arrived. */
  onAck(ack: ViewerAck, now: number): void
  /** Whether the transport has data items ready to send (they may still be waiting for the controller). */
  setDataWaiting(waiting: boolean): void
  /**
   * The bottleneck bandwidth estimate in bytes per ms; 0 while unknown. Absent in a controller that never holds
   * anything back.
   */
  readonly bandwidthEstimate?: number
}

/** A patch captured from a surface, to be encoded. */
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

/** What the patch pump (scheduler) needs of a surface. */
export interface PatchSource {
  readonly key: string
  readonly destroyed: boolean
  readonly hasQueuedPatches: boolean
  /** it may capture its next patch: nothing of it is encoding (one encode at a time) and its stream is ready */
  readonly mayCapture: boolean
  /** the tier of its next patch: its class for damage, settle when it settles */
  readonly sendTier: SendTier
  /**
   * Starts the surface's one encode: the pump calls `encodeDone` once the patch was handed to the sink (or dropped), and
   * `itemDone` once it was sent or reported unsent.
   */
  capturePatch(): CapturedPatch | undefined
  /** A captured patch goes to the sink now, encoded. */
  patchSending(captured: CapturedPatch, encoded: EncodedPatch): void
  /** The patch's encode is over: it was handed to the sink (after `patchSending`), or dropped. */
  encodeDone(captured: CapturedPatch): void
  /** The patch was handed to the socket, or reported unsent (sent or not), or dropped. */
  itemDone(captured?: CapturedPatch): void
  /** false if results captured at this epoch are stale (class switched, surface destroyed) */
  isCurrent(epoch: number): boolean
}

/** Where the patch pump sends encoded patches: the attached viewer. */
export interface PatchSink {
  /** true if a viewer is attached; nothing is encoded without one */
  readonly active: boolean
  /**
   * `done` must be called exactly once: when the patch was handed to the network (true) or not sent (false). `tier`: the
   * surface's class, or settle for a settling patch.
   */
  sendPatch(surface: string, patch: Patch, tier: SendTier, done: (sent: boolean) => void): void
}

/** Encodes a patch's pixels (a session-wide resource: the patch codec's worker pools). */
export type PatchEncode = (
  rgba: Uint8Array,
  width: number,
  height: number,
  opaque: boolean,
  lossy?: boolean,
) => Promise<EncodedPatch>

/** A pool of worker threads that encodes patches: the low priority one is the streaming class's. */
export interface StreamingEncodePool {
  encode: PatchEncode
  /** whether another patch may be captured for it: a worker is free, or about to be */
  readonly canAccept: boolean
  /** set by the pump: called when `canAccept` may have changed */
  onCapacity?: () => void
}

/**
 * Frame callback scheduling: what the compositor needs of frame pacing. The callback goes on a later tick of the frame
 * clock once `ready()` (the surface is ready for a new frame) is true, or after the longest hold anyway if `mayForce()`
 * (the surface isn't streamed as video); throttled without a pacing viewer. It gets the frame time (ms).
 */
export interface FrameCallbackScheduler {
  schedule(ready: () => boolean, callback: (time: number) => void, mayForce?: () => boolean): void
}

/** What the viewer's connection reports to frame pacing. */
export interface ViewerPacing {
  /** A viewer attached or detached. */
  setViewerAttached(attached: boolean): void
  /** The viewer reported its display's refresh interval (ms; 0: unknown). */
  onViewerFeedback(refreshInterval: number): void
}

// Traffic policy (see "Traffic policy" in docs/MODULARIZATION.md) ----------------------------------------------------

/**
 * A surface's bottleneck: CPU-bound until the link becomes the limit. Link-bound means going lossy (spending CPU to
 * save bandwidth): JPEG patches where they're smaller.
 */
export type Bottleneck = 'cpu' | 'link'

/**
 * Traffic policy's decision for one surface. Live: read it whenever it's needed, it follows the surface's measures and
 * the link (reading it is also what lets the link judgment close its periods on time).
 */
export interface TrafficDecision {
  /**
   * Priority: streaming while the surface is relentless (or a burst promoted it), else normal. A streaming surface's
   * patches encode on the low-priority pool and its items go in the streaming tier.
   */
  readonly surfaceClass: SurfaceClass
  /** Link-bound: its new damage may be encoded lossily. Only a streaming surface is, while the link is short. */
  readonly bottleneck: Bottleneck
  /** The quality its video is encoded at: lower while the link is short. */
  readonly videoQuality: VideoQuality
  /** The send tier of its items: its class for damage, the lowest (settle) for settling, the lossless resend. */
  sendTier(settling: boolean): SendTier
}

/** The measures of a surface's last completed period, as shares of the period. */
export type PeriodFractions = { busy: number; backlogged: number }

/** What traffic policy needs of a surface: its encoder reports it (and is told when a burst promoted it). */
export interface TrafficSource {
  readonly key: string
  /** It has content to send (a buffer, and it isn't destroyed): only then can a burst promote it. */
  readonly hasContent: boolean
  /**
   * It is settled: no damage left to send, and nothing lossy left to send again (or it streams video, which a crisp
   * image replaces when it stops). Only then may it be demoted.
   */
  readonly settled: boolean
  /**
   * The predicted size of its unsent damage (handed to the sink or not), at its lossless bytes per pixel. Settling never
   * counts.
   */
  readonly predictedBacklogBytes: number
  /** Of that, the part not handed to the sink yet (queued or encoding). */
  readonly unencodedBytes: number
  /** A burst promoted it: its decision's class is streaming now. */
  onPromoted(): void
}

/** A surface's traffic: its decision, and the reports traffic policy measures it by. */
export interface SurfaceTraffic extends TrafficDecision {
  /** Whether the surface has damage work unsent now (busy); reported whenever that may have changed. */
  setBusy(busy: boolean): void
  /** A commit with new damage arrived: measured, then the class re-evaluated. true if the class changed. */
  committed(): boolean
  /** Re-evaluate the class now (closing the periods that ended). true if it changed. */
  evaluate(): boolean
  /** It is backlogged now. */
  readonly backlogged: boolean
  /** The measures of its last completed period, for tests and logging. */
  readonly lastPeriod: PeriodFractions | undefined
  /** The surface is gone. */
  remove(): void
}

/** Traffic policy as the surfaces see it: a session-wide resource. */
export interface SurfacePolicy {
  addSurface(source: TrafficSource): SurfaceTraffic
  /**
   * Burst promotion: run whenever damage is queued (before it's captured) and on every tick. Promotes surfaces (telling
   * them) while the normal surfaces' predicted backlog is too much for the link.
   */
  checkBurst(): void
  /** Judge the link now, so its periods close on time even when no surface asks. */
  judgeLink(): void
}

/** What traffic policy reads of a viewer connection's link: the transport's link stats. */
export interface LinkStats {
  /** The bytes of all surfaces' items not sent yet, except those in `exceptTier`. */
  totalUnsentBytes(exceptTier?: SendTier): number
  /** Whether any surface's items wait in the tier. */
  tierWaiting(tier: SendTier): boolean
  /**
   * Set by traffic policy: called after every attempt to send data, with whether data waits because the congestion
   * controller or the socket holds it back, and the time (ms).
   */
  onDataHeld: (held: boolean, now: number) => void
}

/** What traffic policy reads of the congestion estimate. */
export type CongestionEstimate = Pick<Congestion, 'bandwidthEstimate'>

/** Traffic policy as a viewer connection sees it: the link it judges is the current connection's. */
export interface LinkPolicy {
  /** A viewer connected: judge its link from now on. */
  connect(link: LinkStats, estimate: CongestionEstimate): void
  /** The viewer is gone: no link to judge (it isn't short, its bandwidth is unknown). */
  disconnect(): void
}

// Rendering: the surface and its renderers (see "The surface package" in docs/MODULARIZATION.md) ---------------------

/** A surface's current buffer, as rendering sees it. */
export type BufferInfo = {
  bufferId: number
  creationSerial: number
  contentSerial: number
  width: number
  height: number
}

/** Capture's side of a surface, as its patch renderer sees it: its current buffer and frames of it. */
export interface FrameSource {
  currentBuffer(): BufferInfo | undefined
  /** A frame of the current buffer, which the caller releases; undefined if it can't be taken. */
  takeFrame(): Frame | undefined
}

/** Capture's side of a surface: given by capture to the surface, which passes it on to its renderers. */
export interface SurfaceHost<V extends VideoEncoder> extends FrameSource {
  /** Encodes a frame as video; the encoder takes the frame over and releases it once it has read it. */
  encodeVideo(encoder: V, frame: Frame): Promise<Uint8Array>
}

/** Where rendered items (patches and video frames) go: the attached viewer. */
export interface EncodingSink extends PatchSink {
  /** The bytes of the surface's items waiting to be sent, except settling patches. */
  queuedBytes(surface: string): number
  /**
   * Whether the surface's stream is ready for its next item (at most about one chunk of its data waits to be sent; see
   * ViewerTransport.streamReady). `exceptSettling`: its settling patches don't count. A stream found not ready gets
   * `onStreamReady` once it is.
   */
  streamReady(surface: string, exceptSettling?: boolean): boolean
  /** Set by the encoding context: a surface's stream that `streamReady` found not ready is ready now. */
  onStreamReady?: (surface: string) => void
  /**
   * `done` must be called exactly once: when the frame was handed to the network (true) or not sent (false: the viewer
   * went away). A queued item is never dropped otherwise, also not when the surface is destroyed.
   */
  sendFrame(surface: string, frame: Uint8Array, surfaceClass: SurfaceClass, done: (sent: boolean) => void): void
}

/** Where rendering logs. */
export type RenderLogger = { error(message: string): void; info?(message: string): void }

/** The video encoders as the surfaces see them: a session-wide pool, lending one to a surface at a time. */
export interface VideoEncoderPool<V extends VideoEncoder> {
  /** How many surfaces can be streamed as video at most; 0 if there is no video encoder. */
  readonly size: number
  /** How many more surfaces can get an encoder. */
  readonly available: number
  /** An encoder, or undefined if all are in use (or there are none). */
  acquire(): V | undefined
  /** An encoder even if all are in use (undefined only if there is no video encoder). */
  acquireAlways(): V | undefined
  release(encoder: V): void
}

/** The patch pump (scheduler) as a patch renderer sees it: it encodes the renderer's patches when there is room. */
export interface PatchScheduler {
  schedule(source: PatchSource): void
}

/** What a renderer needs of the surface that owns it. */
export interface RendererOwner {
  /**
   * An item of the surface, of either renderer, is encoding: the next waits for it (one encode at a time per surface,
   * patches and video alike).
   */
  readonly encoding: boolean
  /**
   * Something the surface's next item may have waited for happened (an encode ended, an item was handed to the socket
   * or reported unsent): the surface goes on.
   */
  next(): void
}

/** What a patch renderer needs of the surface that owns it. */
export interface PatchRendererOwner extends RendererOwner {
  /**
   * As far as the rest of the surface goes, its lossy areas may be sent again now: nothing else renders the surface,
   * and nothing else of it has damage unsent.
   */
  readonly maySettle: boolean
  /** New damage was queued as patches, before any of it is captured. */
  patchesQueued(): void
  /** The surface's buffer can't be read as pixels: patches can't show it (the renderer dropped its queue). */
  unreadable(): void
}

/** The session-wide resources a patch renderer uses. */
export interface PatchRendererContext {
  readonly sink: Pick<EncodingSink, 'active' | 'streamReady'>
  readonly pump: PatchScheduler
  /** development only: the order a surface's queued patches are captured in */
  readonly patchOrder: PatchOrder
  /** development only: how large damage is split into patches */
  readonly patchShape: PatchShape
  readonly logger: RenderLogger
}

/** The session-wide resources a video renderer uses. */
export interface VideoRendererContext<V extends VideoEncoder> {
  readonly sink: Pick<EncodingSink, 'active' | 'streamReady' | 'sendFrame'>
  readonly pool: VideoEncoderPool<V>
  readonly logger: RenderLogger
}

/** What the session's encoding context needs of a surface: its ticks, and its stream's readiness. */
export interface ContextSurface {
  readonly key: string
  /** Re-evaluate the class without a commit (regularly). */
  tick(): void
  /** The surface's stream in the sink is ready for its next item (after the sink found it wasn't). */
  onStreamReady(): void
}

/** The session-wide resources a surface uses (and passes on to its renderers). */
export interface SurfaceContext<V extends VideoEncoder> extends PatchRendererContext, VideoRendererContext<V> {
  readonly sink: EncodingSink
  /** traffic policy: the surfaces' classes and bottlenecks */
  readonly traffic: SurfacePolicy
  /** The surface was created: it gets the ticks and its stream's readiness from now on. */
  addSurface(surface: ContextSurface): void
  /** The surface is gone. */
  removeSurface(surface: ContextSurface): void
}
