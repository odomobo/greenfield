/**
 * The patch encoder: the QOI cascade (raw / QOI / QOI + LZ4, see "Encoding policy" in ARCHITECTURE.md), and JPEG for lossy
 * patches, native, in the small nebula-patch-addon (native/patch). It is synchronous and meant for worker threads
 * (patch-worker.ts); every thread loads its own instance of the addon.
 */
import type { PatchFormat } from '@gfld/scene-protocol'

export type EncodedPatch = {
  format: PatchFormat
  /** 3 if the patch was encoded as opaque (RGB, or a JPEG without alpha), else 4 */
  channels: 3 | 4
  data: Uint8Array
}

type PatchAddon = {
  encodePatch(rgba: Uint8Array, width: number, height: number, opaque: boolean, jpegQuality: number): EncodedPatch
}

/**
 * The JPEG quality of lossy patches (libjpeg's 1-100 scale): medium, still enough to read text (4:4:4, no chroma
 * subsampling).
 */
export const JPEG_QUALITY = 70

let addon: PatchAddon | undefined

/**
 * Encode tightly packed RGBA pixels (8 bit, rows top to bottom). If `opaque` the alpha channel is dropped (the caller
 * guarantees it is 255 everywhere), which makes the patch smaller and cheaper. `lossy`: also encode it as JPEG (with
 * alpha unless opaque) at JPEG_QUALITY and use whichever is smaller, the JPEG or the lossless cascade's result. Throws if
 * the size doesn't match.
 */
export function encodePatch(
  rgba: Uint8Array,
  width: number,
  height: number,
  opaque: boolean,
  lossy = false,
): EncodedPatch {
  addon ??= require('../addons/nebula-patch-addon') as PatchAddon
  return addon.encodePatch(rgba, width, height, opaque, lossy ? JPEG_QUALITY : 0)
}
