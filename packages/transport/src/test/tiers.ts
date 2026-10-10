import type { TierConfig } from '../index.js'

/** The send tiers the tests use: the session's (normal, streaming, settle; weights 9 : 3 : 1, see session's qos/send-tiers.ts). */
const BASE = 16 * 1024
export const TIERS: readonly TierConfig[] = [
  { id: 'normal', quantum: 3 * BASE },
  { id: 'streaming', quantum: BASE },
  { id: 'settle', quantum: Math.round(BASE / 3) },
]
