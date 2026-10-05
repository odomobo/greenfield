/**
 * The Web Worker that decodes patches (wasm QOI + LZ4, see patch-decoder.ts) off the main thread: a decoded bitmap is
 * posted back (transferred), ready to draw. Requests are answered in the order they came in.
 */
import type { PatchFormat } from '@gfld/scene-protocol'
import { PatchDecoder } from './patch-decoder'

export type PatchDecodeRequest = {
  id: number
  format: PatchFormat
  channels: number
  width: number
  height: number
  data: Uint8Array
}
export type PatchDecodeReply = { id: number; bitmap: ImageBitmap } | { id: number; error: string }

const decoder = PatchDecoder.create()
// the exact pixels, as for the PNGs this replaced: no color space conversion, no premultiplication round trip
const options: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }
const scope = self as unknown as Worker

scope.onmessage = async (event: MessageEvent<PatchDecodeRequest>) => {
  const { id, format, channels, width, height, data } = event.data
  try {
    const rgba = (await decoder).decode(format, channels, width, height, data)
    // createImageBitmap takes its copy of the pixels when it is called, the decoder's memory is free for the next patch
    const bitmap = await createImageBitmap(new ImageData(rgba, width, height), options)
    scope.postMessage({ id, bitmap } satisfies PatchDecodeReply, [bitmap])
  } catch (e) {
    scope.postMessage({ id, error: e instanceof Error ? e.message : String(e) } satisfies PatchDecodeReply)
  }
}
