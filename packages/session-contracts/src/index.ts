/**
 * The shared types between the session's packages (see "Packages and enforced boundaries" in docs/MODULARIZATION.md).
 * Types and tiny pure helpers only, no implementation logic.
 */
import type { PatchFormat } from '@gfld/scene-protocol'

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

export interface VideoEncoder {
  requestKeyUnit(): void
  /** the quality of the frames encoded from now on (cheap when it doesn't change) */
  setQuality(quality: VideoQuality): void
  destroy(): void
}
