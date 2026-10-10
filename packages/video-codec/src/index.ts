/**
 * @nebula/video-codec: frames in, H.264 out (see "Video codec" in docs/MODULARIZATION.md). The GStreamer encoder
 * (native, its own addon, reading frames of @nebula/frames and opening its own GPU context on a frame's device), the
 * pool of warm encoder instances, and choosing the encoder (detection).
 */
export { H264Encoder, type H264EncoderType } from './H264Encoder.js'
export { EncoderPool } from './EncoderPool.js'
export {
  detectEncoder,
  ENCODER_OPTIONS,
  type EncoderOption,
  type EncoderProbes,
  resolveEncoder,
  type SessionEncoder,
  systemProbes,
} from './detect.js'
