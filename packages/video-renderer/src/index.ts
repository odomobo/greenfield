/**
 * Video rendering (see "Video rendering" in docs/MODULARIZATION.md), per surface: the video encoder's lease, on-demand
 * frames, key frames and recovery, quality from the traffic-policy decision. Knows nothing about patches. (In `session`
 * for now: the future @nebula/video-renderer package's public API.)
 */
export { VideoRenderer } from './VideoRenderer.js'
