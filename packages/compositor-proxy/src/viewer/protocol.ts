/**
 * Wire format between the session (server) and the viewer (browser). Mirrored in packages/viewer/src/protocol.ts.
 *
 * Every WebSocket message is a binary envelope:
 *   u8  protocol version (PROTOCOL_VERSION)
 *   u8  kind (EnvelopeKind)
 *   ... payload
 *
 * CONTROL payload: UTF-8 JSON object with a `type` field.
 * FRAME payload (server -> viewer only):
 *   u16le surface key length, surface key (UTF-8, "<clientId>/<surfaceId>"), encoded frame blob as produced by the
 *   proxy encoder (u32 bufferId, u32 bufferCreationSerial, u32 contentSerial, u16 encoding type, ...).
 */
export const PROTOCOL_VERSION = 1

export const enum EnvelopeKind {
  CONTROL = 1,
  FRAME = 2,
}

/** Close code sent to a viewer when another viewer attached to the same session. */
export const CLOSE_TAKEN_OVER = 4100
/** Close code sent to a viewer that speaks an unsupported protocol version or sends garbage. */
export const CLOSE_PROTOCOL_ERROR = 4400

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function encodeControl(message: object): Buffer {
  const json = textEncoder.encode(JSON.stringify(message))
  const envelope = Buffer.allocUnsafe(2 + json.byteLength)
  envelope[0] = PROTOCOL_VERSION
  envelope[1] = EnvelopeKind.CONTROL
  envelope.set(json, 2)
  return envelope
}

export function encodeFrame(surfaceKey: string, frame: Uint8Array): Buffer {
  const key = textEncoder.encode(surfaceKey)
  const envelope = Buffer.allocUnsafe(2 + 2 + key.byteLength + frame.byteLength)
  envelope[0] = PROTOCOL_VERSION
  envelope[1] = EnvelopeKind.FRAME
  envelope.writeUInt16LE(key.byteLength, 2)
  envelope.set(key, 4)
  envelope.set(frame, 4 + key.byteLength)
  return envelope
}

export function decodeControl(data: Buffer): { type: string; [key: string]: any } {
  if (data.byteLength < 2 || data[0] !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${data[0]}`)
  }
  if (data[1] !== EnvelopeKind.CONTROL) {
    throw new Error(`Unexpected envelope kind from viewer: ${data[1]}`)
  }
  const message = JSON.parse(textDecoder.decode(data.subarray(2)))
  if (typeof message !== 'object' || message === null || typeof message.type !== 'string') {
    throw new Error('Control message without a type.')
  }
  return message
}

/**
 * True if a viewer can start decoding the surface's stream at this frame (PNG, or H.264 IDR in every plane).
 */
export function isKeyFrame(frame: Uint8Array): boolean {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  // u32 bufferId, u32 creationSerial, u32 contentSerial
  let offset = 12
  const encodingType = view.getUint16(offset, true)
  if (encodingType === 1) {
    // png
    return true
  }
  offset += 4 // encoding type (u16 + padding)
  offset += 16 // width, height, encoded width, encoded height
  const opaqueLength = view.getUint32(offset, true)
  offset += 4
  const opaque = frame.subarray(offset, offset + opaqueLength)
  offset += opaqueLength
  const alphaLength = view.getUint32(offset, true)
  offset += 4
  const alpha = alphaLength > 0 ? frame.subarray(offset, offset + alphaLength) : undefined
  return hasIDR(opaque) && (alpha === undefined || hasIDR(alpha))
}

function hasIDR(accessUnit: Uint8Array): boolean {
  for (let i = 0; i + 3 < accessUnit.length; i++) {
    // 3 byte start code (also matches the tail of a 4 byte one)
    if (accessUnit[i] === 0 && accessUnit[i + 1] === 0 && accessUnit[i + 2] === 1) {
      if ((accessUnit[i + 3] & 0x1f) === 5) {
        return true
      }
    }
  }
  return false
}
