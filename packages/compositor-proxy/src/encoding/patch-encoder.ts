/**
 * The lossless patch encoder: the QOI cascade (raw / QOI / QOI + LZ4, see "Encoding policy" in ROADMAP.md), native, in
 * the small nebula-patch-addon (native/patch). It is synchronous and meant for worker threads (patch-worker.ts); every
 * thread loads its own instance of the addon.
 */
import type { PatchFormat } from '@gfld/scene-protocol'

export type EncodedPatch = {
  format: PatchFormat
  /** 3 if the patch was encoded as opaque (RGB), else 4 */
  channels: 3 | 4
  data: Uint8Array
}

type PatchAddon = {
  encodePatch(rgba: Uint8Array, width: number, height: number, opaque: boolean): EncodedPatch
}

let addon: PatchAddon | undefined

/**
 * Encode tightly packed RGBA pixels (8 bit, rows top to bottom). If `opaque` the alpha channel is dropped (the caller
 * guarantees it is 255 everywhere), which makes the patch smaller and cheaper. Throws if the size doesn't match.
 */
export function encodePatch(rgba: Uint8Array, width: number, height: number, opaque: boolean): EncodedPatch {
  addon ??= require('../addons/nebula-patch-addon') as PatchAddon
  return addon.encodePatch(rgba, width, height, opaque)
}
