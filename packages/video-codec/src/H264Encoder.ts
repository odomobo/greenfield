/**
 * A GStreamer H.264 encoder instance (native/src/gst_frame_encoder.c, in the nebula-video-codec-addon): frames in, H.264
 * out. The encoded frames are blobs in the layout the viewer parses (`parseEncodedFrame` of @gfld/scene-protocol): the
 * frame's content serial, size and coded size, the opaque stream's access unit and the alpha stream's.
 */
import type { Frame, VideoEncoder, VideoQuality } from '@nebula/session-contracts'

/** The hardware encoders, and `x264`: software, for tests on machines without a GPU (--dev-software-encoder). */
export type H264EncoderType = 'nvh264' | 'vaapih264' | 'x264'

type NativeEncoder = { readonly __nativeEncoder: unique symbol }

/** The addon's functions (native/src/video_codec_addon.c). */
type VideoCodecAddon = {
  createEncoder(type: H264EncoderType, frameEncoded: (encoded: Buffer | undefined) => void): NativeEncoder
  destroyEncoder(encoder: NativeEncoder): void
  requestKeyUnit(encoder: NativeEncoder): void
  /** The quality (a constant QP) of the frames from the next one on, which starts with a key frame if it changed. */
  setQuality(encoder: NativeEncoder, high: boolean): void
  /** Encodes the frame; the encoder holds its own reference to it until GStreamer is done reading it. */
  encode(encoder: NativeEncoder, frame: Frame): void
}

let addon: VideoCodecAddon | undefined

/** Loaded on first use: importing the package (encoder detection, the pool) doesn't start GStreamer. */
function videoCodecAddon(): VideoCodecAddon {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  addon ??= require('./addons/nebula-video-codec-addon.node') as VideoCodecAddon
  return addon
}

export class H264Encoder implements VideoEncoder {
  private readonly native: NativeEncoder
  private quality: VideoQuality = 'high'
  private readonly queue: { resolve: (frame: Buffer) => void; reject: (error: Error) => void }[] = []

  constructor(type: H264EncoderType) {
    const native = videoCodecAddon()
    this.native = native.createEncoder(type, (frame) => {
      const task = this.queue.shift()
      if (frame) {
        task?.resolve(frame)
      } else {
        task?.reject(new Error('Buffer encoding failed.'))
      }
    })
  }

  /**
   * Encodes the frame, and takes it over: the handle is released right away, and the buffer when the encoder is done
   * reading it.
   */
  encode(frame: Frame): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const task = { resolve, reject }
      this.queue.push(task)
      try {
        videoCodecAddon().encode(this.native, frame)
      } catch (e: any) {
        this.queue.splice(this.queue.indexOf(task), 1)
        reject(e)
      } finally {
        frame.release()
      }
    })
  }

  requestKeyUnit(): void {
    videoCodecAddon().requestKeyUnit(this.native)
  }

  setQuality(quality: VideoQuality): void {
    if (quality !== this.quality) {
      this.quality = quality
      videoCodecAddon().setQuality(this.native, quality === 'high')
    }
  }

  destroy(): void {
    videoCodecAddon().destroyEncoder(this.native)
  }
}
