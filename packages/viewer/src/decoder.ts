import { EncodedFrame, Patch } from './protocol'

/**
 * A decoded surface frame, ready to draw. The frames stay in the decoder's (GPU) memory: whoever takes this closes
 * both, promptly, the decoder's pool of frames is small.
 */
export type DecodedFrame = {
  /** real image size */
  size: { width: number; height: number }
  /** padded encoder size, the image sits in its bottom right corner */
  encodedSize: { width: number; height: number }
  opaque: VideoFrame
  /** the alpha stream's frame: its luma is the alpha channel of the image */
  alpha?: VideoFrame
}

/** A decoded lossless update of a rectangle of a surface. */
export type DecodedPatch = {
  surfaceSize: { width: number; height: number }
  rect: { x: number; y: number; width: number; height: number }
  bitmap: ImageBitmap
}

const decoderConfig: VideoDecoderConfig = {
  codec: 'avc1.64001f', // h264 High Level 3.1
  optimizeForLatency: true,
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
 * Decodes one H.264 stream, one frame at a time. The frames are handed on as decoded (see DecodedFrame).
 */
class StreamDecoder {
  private decoder?: VideoDecoder
  private pending: { resolve: (frame: VideoFrame) => void; reject: (error: Error) => void }[] = []

  async decode(accessUnit: Uint8Array): Promise<VideoFrame> {
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
    const result = new Promise<VideoFrame>((resolve, reject) => this.pending.push({ resolve, reject }))
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

  private onOutput(frame: VideoFrame) {
    const pending = this.pending.shift()
    if (pending === undefined) {
      // nobody waits for it anymore (the decoder was closed or failed meanwhile)
      frame.close()
      return
    }
    pending.resolve(frame)
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
 * Decodes the frames and patches of one surface, strictly in order.
 */
export class SurfaceDecoder {
  private readonly opaque = new StreamDecoder()
  private readonly alpha = new StreamDecoder()
  private queue: Promise<unknown> = Promise.resolve()

  decode(frame: EncodedFrame): Promise<DecodedFrame> {
    return this.enqueue(() => this.decodeNow(frame))
  }

  decodePatch(patch: Patch): Promise<DecodedPatch> {
    return this.enqueue(async () => {
      // the surface is on patches now, its video stream (if any) is over: the next one starts with a key frame
      this.close()
      const blob = new Blob([patch.png], { type: 'image/png' })
      // the exact pixels: no color space conversion, no premultiplication round trip
      const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
      return { surfaceSize: patch.surfaceSize, rect: patch.rect, bitmap }
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task)
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
    const opaque = this.opaque.decode(frame.opaque)
    const alpha = frame.alpha ? this.alpha.decode(frame.alpha) : Promise.resolve(undefined)
    try {
      return { size: frame.size, encodedSize: frame.encodedSize, opaque: await opaque, alpha: await alpha }
    } catch (e) {
      // start over from the next key frame, and don't leak the half that did decode
      this.close()
      for (const half of [opaque, alpha]) {
        half.then(
          (decoded) => decoded?.close(),
          () => undefined,
        )
      }
      throw e
    }
  }
}
