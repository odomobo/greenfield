import { EncodedFrame, Patch } from './protocol'

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

/** A decoded lossless update of a rectangle of a surface. */
export type DecodedPatch = {
  surfaceSize: { width: number; height: number }
  rect: { x: number; y: number; width: number; height: number }
  bitmap: ImageBitmap
}

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

type DecoderOwner = { onOutput(frame: VideoFrame): void; onError(error: DOMException): void }

/** A configured VideoDecoder whose output goes to whichever stream currently uses it. */
type PooledDecoder = { decoder: VideoDecoder; owner?: DecoderOwner }

/**
 * Warm video decoders, as many as the server streams video at once (two per stream: opaque and alpha). A stream takes
 * one when its key frame arrives and gives it back when the surface switches to patches. More are made if needed, the
 * server's encoder pool is the real limit.
 */
export class VideoDecoderPool {
  private readonly free: PooledDecoder[] = []
  private target = 0

  /** Keep this many decoders ready. */
  warm(count: number): void {
    this.target = count
    while (this.free.length < this.target) {
      this.free.push(this.create())
    }
  }

  acquire(owner: DecoderOwner): PooledDecoder {
    let pooled = this.free.pop()
    while (pooled && pooled.decoder.state === 'closed') {
      pooled = this.free.pop()
    }
    pooled ??= this.create()
    pooled.owner = owner
    return pooled
  }

  /** Give a decoder back. Only when nothing is being decoded with it, or a later owner could get stale output. */
  release(pooled: PooledDecoder): void {
    pooled.owner = undefined
    if (pooled.decoder.state === 'closed') {
      return
    }
    if (this.free.length < this.target) {
      this.free.push(pooled)
    } else {
      pooled.decoder.close()
    }
  }

  private create(): PooledDecoder {
    const pooled: PooledDecoder = {
      decoder: new VideoDecoder({
        output: (frame) => (pooled.owner ? pooled.owner.onOutput(frame) : frame.close()),
        error: (error) => pooled.owner?.onError(error),
      }),
    }
    pooled.decoder.configure(decoderConfig)
    return pooled
  }
}

/**
 * Decodes one H.264 stream into I420 planes, one frame at a time.
 */
class StreamDecoder implements DecoderOwner {
  private lease?: PooledDecoder
  private pending: { resolve: (planes: YUVPlanes) => void; reject: (error: Error) => void }[] = []

  constructor(private readonly pool: VideoDecoderPool) {}

  async decode(accessUnit: Uint8Array): Promise<YUVPlanes> {
    const key = isKeyFrame(accessUnit)
    if (this.lease === undefined || this.lease.decoder.state === 'closed') {
      if (!key) {
        throw new KeyFrameNeeded()
      }
      this.lease = this.pool.acquire(this)
    }
    const result = new Promise<YUVPlanes>((resolve, reject) => this.pending.push({ resolve, reject }))
    this.lease.decoder.decode(new EncodedVideoChunk({ timestamp: 0, type: key ? 'key' : 'delta', data: accessUnit }))
    return result
  }

  /** The stream ended (the surface switched to patches): give the decoder back, the next stream starts with a key. */
  release() {
    if (this.lease && this.pending.length === 0) {
      this.pool.release(this.lease)
      this.lease = undefined
    }
  }

  close() {
    if (this.lease) {
      if (this.pending.length) {
        // output for this stream may still come, don't hand the decoder to someone else
        this.lease.owner = undefined
        if (this.lease.decoder.state !== 'closed') {
          this.lease.decoder.close()
        }
      } else {
        this.pool.release(this.lease)
      }
    }
    this.lease = undefined
    for (const pending of this.pending) {
      pending.reject(new Error('Decoder closed.'))
    }
    this.pending = []
  }

  async onOutput(frame: VideoFrame) {
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

  onError(error: DOMException) {
    const pending = this.pending
    this.pending = []
    // a decoder that failed is closed, it doesn't go back to the pool
    if (this.lease) {
      this.lease.owner = undefined
    }
    this.lease = undefined
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
  private readonly opaque: StreamDecoder
  private readonly alpha: StreamDecoder
  private queue: Promise<unknown> = Promise.resolve()

  constructor(pool: VideoDecoderPool) {
    this.opaque = new StreamDecoder(pool)
    this.alpha = new StreamDecoder(pool)
  }

  decode(frame: EncodedFrame): Promise<DecodedFrame> {
    return this.enqueue(() => this.decodeNow(frame))
  }

  decodePatch(patch: Patch): Promise<DecodedPatch> {
    return this.enqueue(async () => {
      // the surface is on patches now, its video stream (if any) is over
      this.opaque.release()
      this.alpha.release()
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
