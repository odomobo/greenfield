/**
 * Decodes a patch's pixels (the formats of the scene protocol's PatchFormat) to RGBA. Pure: no DOM, no Worker, so it is
 * unit tested in Node. Raw patches are expanded in JavaScript; QOI and LZ4 run in the wasm module built from
 * wasm/*.c (see scripts/build-wasm.mjs).
 *
 * The module's memory is fixed: [stack, data][in: IN_SIZE][scratch: IN_SIZE][out: OUT_SIZE]. `in` takes the patch's
 * bytes, `scratch` the QOI stream of a QOI + LZ4 patch, `out` the RGBA result. A patch can have at most
 * MAX_DECODE_PIXELS pixels (the server's patches have at most 64k).
 */
import { PatchFormat } from '@gfld/scene-protocol'
import { PATCH_DECODER_WASM_BASE64 } from './wasm-bytes.js'

export const MAX_DECODE_PIXELS = 1 << 20
const OUT_SIZE = MAX_DECODE_PIXELS * 4
// a QOI stream is at most 5 bytes per pixel (RGBA ops) plus its 14 byte header and 8 byte end marker
const IN_SIZE = MAX_DECODE_PIXELS * 5 + 64

type Exports = {
  memory: WebAssembly.Memory
  __heap_base: WebAssembly.Global
  qoi_decode_into(bytes: number, size: number, pixels: number, capacity: number): number
  lz4_decompress(source: number, size: number, destination: number, capacity: number): number
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export class PatchDecoder {
  private constructor(
    private readonly wasm: Exports,
    private readonly inOffset: number,
  ) {}

  static async create(): Promise<PatchDecoder> {
    const { instance } = await WebAssembly.instantiate(base64ToBytes(PATCH_DECODER_WASM_BASE64))
    const wasm = instance.exports as unknown as Exports
    const inOffset = (Number(wasm.__heap_base.value) + 15) & ~15
    if (inOffset + 2 * IN_SIZE + OUT_SIZE > wasm.memory.buffer.byteLength) {
      throw new Error('The patch decoder has too little memory.')
    }
    return new PatchDecoder(wasm, inOffset)
  }

  /**
   * RGBA pixels of the patch (straight alpha, 255 for 3 channel patches). The result may be a view of the module's
   * memory: it is only valid until the next call.
   */
  decode(format: PatchFormat, channels: number, width: number, height: number, data: Uint8Array): Uint8ClampedArray {
    if (!(width > 0 && height > 0 && width * height <= MAX_DECODE_PIXELS) || (channels !== 3 && channels !== 4)) {
      throw new Error(`Bad patch size ${width}x${height}x${channels}.`)
    }
    const count = width * height
    switch (format) {
      case PatchFormat.RAW: {
        if (data.byteLength !== count * channels) {
          throw new Error('A raw patch has the wrong size.')
        }
        if (channels === 4) {
          return new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
        }
        const rgba = new Uint8ClampedArray(count * 4)
        for (let i = 0, from = 0, to = 0; i < count; i++, from += 3, to += 4) {
          rgba[to] = data[from]
          rgba[to + 1] = data[from + 1]
          rgba[to + 2] = data[from + 2]
          rgba[to + 3] = 255
        }
        return rgba
      }
      case PatchFormat.QOI:
      case PatchFormat.QOI_LZ4: {
        if (data.byteLength > IN_SIZE) {
          throw new Error('A patch is too big.')
        }
        const memory = new Uint8Array(this.wasm.memory.buffer)
        const input = this.inOffset
        const scratch = input + IN_SIZE
        const output = scratch + IN_SIZE
        memory.set(data, input)
        let qoi = input
        let qoiSize = data.byteLength
        if (format === PatchFormat.QOI_LZ4) {
          qoiSize = this.wasm.lz4_decompress(input, data.byteLength, scratch, IN_SIZE)
          if (qoiSize <= 0) {
            throw new Error('A patch has invalid LZ4 data.')
          }
          qoi = scratch
        }
        const size = this.wasm.qoi_decode_into(qoi, qoiSize, output, OUT_SIZE)
        if (size !== ((width << 16) | height) >>> 0) {
          throw new Error('A patch has invalid QOI data, or other dimensions than its rectangle.')
        }
        return new Uint8ClampedArray(this.wasm.memory.buffer, output, count * 4)
      }
      default:
        throw new Error(`Unknown patch format ${format}.`)
    }
  }
}
