import { EncodedFrame } from './protocol'

/**
 * A decoded surface frame, ready to upload as textures.
 */
export type DecodedFrame =
  | {
      kind: 'yuv'
      /** real image size */
      size: { width: number; height: number }
      /** padded encoder size, the image sits in its bottom right corner */
      encodedSize: { width: number; height: number }
      /** I420 planes of the full coded frame */
      opaque: YUVPlanes
      /** luma plane of the alpha stream */
      alpha?: YUVPlanes
    }
  | { kind: 'bitmap'; size: { width: number; height: number }; bitmap: ImageBitmap }

export type YUVPlanes = { codedWidth: number; codedHeight: number; y: Uint8Array; u: Uint8Array; v: Uint8Array }

// Software decoding: hardware decoders return frames in formats/offsets we don't handle yet.
const decoderConfig: VideoDecoderConfig = {
  codec: 'avc1.64001f', // h264 High Level 3.1
  optimizeForLatency: true,
  hardwareAcceleration: 'prefer-software',
}

function isKeyFrame(accessUnit: Uint8Array): boolean {
  for (let i = 0; i + 3 < accessUnit.length; i++) {
    if (accessUnit[i] === 0 && accessUnit[i + 1] === 0 && accessUnit[i + 2] === 1 && (accessUnit[i + 3] & 0x1f) === 5) {
      return true
    }
  }
  return false
}

/**
 * Decodes one H.264 stream into I420 planes, one frame at a time.
 */
class StreamDecoder {
  private decoder?: VideoDecoder
  private pending: { resolve: (planes: YUVPlanes) => void; reject: (error: Error) => void }[] = []

  async decode(accessUnit: Uint8Array): Promise<YUVPlanes> {
    const key = isKeyFrame(accessUnit)
    if (this.decoder === undefined || this.decoder.state === 'closed') {
      if (!key) {
        throw new KeyFrameNeeded()
      }
      this.decoder = new VideoDecoder({
        output: (frame) => this.onOutput(frame),
        error: (error) => this.onError(error),
      })
      this.decoder.configure(decoderConfig)
    }
    const result = new Promise<YUVPlanes>((resolve, reject) => this.pending.push({ resolve, reject }))
    this.decoder.decode(new EncodedVideoChunk({ timestamp: 0, type: key ? 'key' : 'delta', data: accessUnit }))
    return result
  }

  close() {
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.close()
    }
    this.decoder = undefined
    for (const pending of this.pending) {
      pending.reject(new Error('Decoder closed.'))
    }
    this.pending = []
  }

  private async onOutput(frame: VideoFrame) {
    const pending = this.pending.shift()
    try {
      if (frame.format !== 'I420') {
        throw new Error(`Unsupported decoded frame format ${frame.format}`)
      }
      // Copy the full coded area. Without a rect, copyTo only copies the visible area.
      const codedWidth = frame.codedWidth
      const codedHeight = frame.codedHeight
      const options: VideoFrameCopyToOptions = { rect: { x: 0, y: 0, width: codedWidth, height: codedHeight } }
      const buffer = new Uint8Array(frame.allocationSize(options))
      const layout = await frame.copyTo(buffer, options)
      const lumaSize = codedWidth * codedHeight
      const chromaSize = (codedWidth >> 1) * (codedHeight >> 1)
      pending?.resolve({
        codedWidth,
        codedHeight,
        y: buffer.subarray(layout[0].offset, layout[0].offset + lumaSize),
        u: buffer.subarray(layout[1].offset, layout[1].offset + chromaSize),
        v: buffer.subarray(layout[2].offset, layout[2].offset + chromaSize),
      })
    } catch (e: any) {
      pending?.reject(e)
    } finally {
      frame.close()
    }
  }

  private onError(error: DOMException) {
    const pending = this.pending
    this.pending = []
    this.decoder = undefined
    for (const p of pending) {
      p.reject(new Error(error.message))
    }
  }
}

export class KeyFrameNeeded extends Error {
  constructor() {
    super('A key frame is needed to start decoding.')
  }
}

/**
 * Decodes the frames of one surface, strictly in order.
 */
export class SurfaceDecoder {
  private readonly opaque = new StreamDecoder()
  private readonly alpha = new StreamDecoder()
  private queue: Promise<unknown> = Promise.resolve()

  decode(frame: EncodedFrame): Promise<DecodedFrame> {
    const result = this.queue.then(() => this.decodeNow(frame))
    this.queue = result.catch(() => {
      /* errors are reported to the caller */
    })
    return result
  }

  close() {
    this.opaque.close()
    this.alpha.close()
  }

  private async decodeNow(frame: EncodedFrame): Promise<DecodedFrame> {
    if (frame.mimeType === 'image/png') {
      const blob = new Blob([frame.opaque], { type: 'image/png' })
      const bitmap = await createImageBitmap(
        blob,
        frame.encodedSize.width - frame.size.width,
        frame.encodedSize.height - frame.size.height,
        frame.size.width,
        frame.size.height,
      )
      return { kind: 'bitmap', size: frame.size, bitmap }
    }

    try {
      const [opaque, alpha] = await Promise.all([
        this.opaque.decode(frame.opaque),
        frame.alpha ? this.alpha.decode(frame.alpha) : Promise.resolve(undefined),
      ])
      return { kind: 'yuv', size: frame.size, encodedSize: frame.encodedSize, opaque, alpha }
    } catch (e) {
      // start over from the next key frame
      this.close()
      throw e
    }
  }
}
