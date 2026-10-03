declare namespace nativeEncoder {
  export type FrameEncoder = unknown

  /**
   * wlClient may be null for an encoder shared between clients (the encoder pool): then encodeFrame gets the client.
   */
  export function createFrameEncoder(
    encoderType: 'nvh264' | 'x264' | 'vaapih264',
    wlClient: unknown | null,
    drmContext: unknown,
    frameEncoded: (sample: Buffer) => void,
  ): FrameEncoder

  export function destroyFrameEncoder(encoder: FrameEncoder)

  export function encodeFrame(
    frameEncoder: unknown,
    bufferId: number,
    bufferContentSerial: number,
    bufferCreationSerial: number,
    wlClient?: unknown,
  ): void

  export function requestKeyUnit(encoder: FrameEncoder): void

  /**
   * A rectangle of a client buffer as tightly packed RGBA rows (top to bottom), or undefined if it can't be read
   * (out of bounds, unsupported format, ...). A synchronous copy: the buffer may be released right after.
   */
  export function readPixels(
    wlClient: unknown,
    drmContext: unknown,
    bufferId: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Buffer | undefined

  /** [width, height] of a client buffer, or undefined if it's not a buffer. */
  export function bufferSize(wlClient: unknown, bufferId: number): [number, number] | undefined
}

export = nativeEncoder
