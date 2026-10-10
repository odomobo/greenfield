import type { SendTier, SurfaceClass } from '@nebula/session-contracts'

/**
 * The transport's send tiers and their weights (traffic policy's, given to the transport): from the highest priority,
 * the deficit round-robin's order. On its turn a tier may send up to its quantum in bytes (plus what it carried over):
 * normal surfaces get 3 times the share of streaming ones, which get 3 times the share of settling, and the others get
 * all of the link when a tier has nothing waiting.
 */
const QUANTUM_STREAMING_BASE = 16 * 1024
export const SEND_TIERS: readonly { readonly id: SendTier; readonly quantum: number }[] = [
  { id: 'normal', quantum: 3 * QUANTUM_STREAMING_BASE },
  { id: 'streaming', quantum: QUANTUM_STREAMING_BASE },
  { id: 'settle', quantum: Math.round(QUANTUM_STREAMING_BASE / 3) },
]

/**
 * The tier a surface's item goes in: its class for damage; settling (the lossless resend of its lossy areas) always at
 * the lowest priority, so new damage of any surface comes first.
 */
export function sendTierOf(surfaceClass: SurfaceClass, settling: boolean): SendTier {
  return settling ? 'settle' : surfaceClass
}
