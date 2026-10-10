/**
 * Traffic policy: how the link and the CPU are shared between surfaces (see "Traffic policy" in
 * docs/MODULARIZATION.md). Priority (relentless or not, burst promotion, settling's tier), bottleneck (CPU- or
 * link-bound: the link judgment), and the send tiers with their weights. Its decisions reach the rest of the session
 * through the contracts (`SurfacePolicy`, `LinkPolicy`, `TrafficDecision`).
 */
export { TrafficPolicy } from './TrafficPolicy.js'
export { BURST_MS, CLASS_PERIOD_MS, DEMOTE_FRACTION, PROMOTE_FRACTION, RelentlessMeter } from './priority.js'
export {
  BANDWIDTH_PERIOD_MS,
  BandwidthMonitor,
  LIMITED_HELD_FRACTION,
  LIMITED_PERIODS,
  MIN_LIMITED_MS,
  RECOVERED_HELD_FRACTION,
} from './bandwidth.js'
export { LinkJudgment } from './link-judgment.js'
export type { LinkJudge, PolicyLogger } from './link-judgment.js'
export type { LimitedReason } from './bandwidth.js'
export { SEND_TIERS, sendTierOf } from './tiers.js'
