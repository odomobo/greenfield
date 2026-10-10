/**
 * Patch rendering (see "Patch rendering" in docs/MODULARIZATION.md), per surface: the damage queue, patch planning and
 * order, capture through frames, lossy and settle areas. Its encodes run through the scheduler's patch pump. Knows
 * nothing about video. (In `session` for now: the future @nebula/patch-renderer package's public API.)
 */
export { PatchRenderer, MAX_LOSSY_RECTS, UNCOMPRESSED_BYTES_PER_PIXEL } from './PatchRenderer.js'
export { MAX_PATCH_PIXELS } from './patch-plan.js'
export { area, clip } from './region.js'
