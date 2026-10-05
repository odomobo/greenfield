/**
 * The Web Worker that decodes patches off the main thread (wasm QOI + LZ4, see patch-decoder.ts; JPEG by the browser):
 * a decoded bitmap is posted back (transferred), ready to draw. A JPEG with alpha comes back as two bitmaps, the color
 * and the alpha (its red channel), which the main thread combines (AlphaCompositor). Requests are answered in the order
 * they came in.
 */
import { PatchFormat, splitJpegAlpha } from '@gfld/scene-protocol'
import { PatchDecoder } from './patch-decoder'

export type PatchDecodeRequest = {
  id: number
  format: PatchFormat
  channels: number
  width: number
  height: number
  data: Uint8Array
}
export type PatchDecodeReply = { id: number; bitmap: ImageBitmap; alpha?: ImageBitmap } | { id: number; error: string }

const decoder = PatchDecoder.create()
// the exact pixels, as for the PNGs this replaced: no color space conversion, no premultiplication round trip
const options: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }
const scope = self as unknown as Worker

const jpeg = async (data: Uint8Array, width: number, height: number) => {
  const bitmap = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }), options)
  if (bitmap.width !== width || bitmap.height !== height) {
    bitmap.close()
    throw new Error(`A JPEG patch of ${bitmap.width}x${bitmap.height} for a ${width}x${height} rectangle.`)
  }
  return bitmap
}

scope.onmessage = async (event: MessageEvent<PatchDecodeRequest>) => {
  const { id, format, channels, width, height, data } = event.data
  try {
    if (format === PatchFormat.JPEG) {
      const bitmap = await jpeg(data, width, height)
      scope.postMessage({ id, bitmap } satisfies PatchDecodeReply, [bitmap])
      return
    }
    if (format === PatchFormat.JPEG_ALPHA) {
      const parts = splitJpegAlpha(data)
      const [bitmap, alpha] = await Promise.all([jpeg(parts.color, width, height), jpeg(parts.alpha, width, height)])
      scope.postMessage({ id, bitmap, alpha } satisfies PatchDecodeReply, [bitmap, alpha])
      return
    }
    const rgba = (await decoder).decode(format, channels, width, height, data)
    // createImageBitmap takes its copy of the pixels when it is called, the decoder's memory is free for the next patch
    const bitmap = await createImageBitmap(new ImageData(rgba, width, height), options)
    scope.postMessage({ id, bitmap } satisfies PatchDecodeReply, [bitmap])
  } catch (e) {
    scope.postMessage({ id, error: e instanceof Error ? e.message : String(e) } satisfies PatchDecodeReply)
  }
}
