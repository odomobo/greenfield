/**
 * Wire format between the viewer (this browser app) and a session (server). Mirrors
 * packages/compositor-proxy/src/viewer/protocol.ts.
 *
 * One WebSocket per session: ws(s)://<server>/viewer?session=<id>. Every message is a binary envelope:
 *   u8 protocol version, u8 kind, payload
 * CONTROL payload: UTF-8 JSON object with a `type` field (both directions).
 * FRAME payload (server -> viewer): u16le surface key length, surface key, encoded frame blob.
 *
 * Surfaces are identified by a key "<clientId>/<surfaceId>". Coordinates are in output (canvas CSS) pixels.
 */
export const PROTOCOL_VERSION = 1

export const enum EnvelopeKind {
  CONTROL = 1,
  FRAME = 2,
}

/** The session was taken over by another viewer. Don't reconnect automatically. */
export const CLOSE_TAKEN_OVER = 4100

// ---------------------------------------------------------------------------------------------------------------------
// server -> viewer

export type SceneSurface = { id: string; x: number; y: number; width: number; height: number }

export type SceneWindow = {
  id: string
  title: string
  appId: string
  activated: boolean
  maximized: boolean
  fullscreen: boolean
  /** false until the viewer decided where the window goes (send window.move) */
  placed: boolean
  /** position of the main surface's origin */
  x: number
  y: number
  /** window geometry relative to the main surface origin (excludes client side shadows) */
  geometry: { x: number; y: number; width: number; height: number }
  /** size of the configure the committed content reflects (xdg_toplevel only), see the server's SceneWindow */
  configuredSize?: { width: number; height: number }
  /** bottom to top, relative to the window origin */
  surfaces: SceneSurface[]
}

export type ServerMessage =
  | { type: 'welcome'; protocolVersion: number }
  /** Full snapshot, sent on attach and whenever anything changes. Windows are ordered bottom to top. */
  | { type: 'scene'; windows: SceneWindow[]; focus: string | null }
  | { type: 'cursor'; kind: 'default' | 'hidden' }
  | { type: 'cursor'; kind: 'named'; name: string }
  | { type: 'cursor'; kind: 'surface'; surface: string; hotspot: { x: number; y: number } }
  /** The client asked to start an interactive move/resize (xdg_toplevel.move/resize) during the current button press. */
  | { type: 'interactive'; mode: 'move'; window: string }
  | { type: 'interactive'; mode: 'resize'; window: string; edges: number }

// ---------------------------------------------------------------------------------------------------------------------
// viewer -> server

/** Pointer target picked by the viewer: surface key + surface local coordinates, or null for the desktop. */
type PointerTarget = { surface: string | null; sx?: number; sy?: number; x: number; y: number; time: number }

export type ViewerMessage =
  | { type: 'hello'; output: { width: number; height: number } }
  | { type: 'output'; width: number; height: number }
  | ({ type: 'pointer'; buttons: number } & PointerTarget)
  | ({ type: 'button'; button: number; pressed: boolean; buttons: number } & PointerTarget)
  | ({ type: 'axis'; deltaX: number; deltaY: number; deltaMode: number } & PointerTarget)
  /** code is KeyboardEvent.code, the server maps it to an evdev key code and owns the keymap and modifier state */
  | { type: 'key'; code: string; pressed: boolean; capsLock: boolean; numLock: boolean; time: number }
  /** the viewer page gained/lost keyboard focus */
  | { type: 'focus'; focused: boolean }
  | { type: 'window.move'; window: string; x: number; y: number }
  | { type: 'window.activate'; window: string }
  /** width/height are window geometry sizes. done: the interactive resize ended. */
  | { type: 'window.resize'; window: string; width: number; height: number; edges: number; done: boolean }
  | { type: 'window.maximize'; window: string; maximized: boolean }
  | { type: 'window.close'; window: string }
  /** frame pacing: how often the viewer refreshes and how long decoding takes (ms) */
  | { type: 'feedback'; refreshInterval: number; decodeDuration: number }
  /** the viewer can't decode this surface's stream, send a key frame */
  | { type: 'keyframe'; surface: string }

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function encodeControl(message: ViewerMessage): Uint8Array {
  const json = textEncoder.encode(JSON.stringify(message))
  const envelope = new Uint8Array(2 + json.byteLength)
  envelope[0] = PROTOCOL_VERSION
  envelope[1] = EnvelopeKind.CONTROL
  envelope.set(json, 2)
  return envelope
}

export type DecodedEnvelope =
  | { kind: 'control'; message: ServerMessage }
  | { kind: 'frame'; surface: string; frame: Uint8Array }

export function decodeEnvelope(data: ArrayBuffer): DecodedEnvelope {
  const bytes = new Uint8Array(data)
  if (bytes[0] !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version ${bytes[0]}`)
  }
  if (bytes[1] === EnvelopeKind.CONTROL) {
    return { kind: 'control', message: JSON.parse(textDecoder.decode(bytes.subarray(2))) }
  }
  if (bytes[1] === EnvelopeKind.FRAME) {
    const keyLength = bytes[2] | (bytes[3] << 8)
    const surface = textDecoder.decode(bytes.subarray(4, 4 + keyLength))
    return { kind: 'frame', surface, frame: bytes.subarray(4 + keyLength) }
  }
  throw new Error(`Unknown envelope kind ${bytes[1]}`)
}

// ---------------------------------------------------------------------------------------------------------------------
// encoded frames (as produced by the proxy encoder)

export type EncodedFrame = {
  contentSerial: number
  mimeType: 'video/h264' | 'image/png'
  /** real image size */
  size: { width: number; height: number }
  /** padded size the encoder used, the image sits in the bottom right corner */
  encodedSize: { width: number; height: number }
  opaque: Uint8Array
  alpha?: Uint8Array
}

export function parseEncodedFrame(frame: Uint8Array): EncodedFrame {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  // u32 bufferId, u32 bufferCreationSerial
  let offset = 8
  const contentSerial = view.getUint32(offset, true)
  offset += 4
  const encodingType = view.getUint16(offset, true)
  offset += 4
  const width = view.getUint32(offset, true)
  offset += 4
  const height = view.getUint32(offset, true)
  offset += 4
  const encodedWidth = view.getUint32(offset, true)
  offset += 4
  const encodedHeight = view.getUint32(offset, true)
  offset += 4
  const opaqueLength = view.getUint32(offset, true)
  offset += 4
  const opaque = frame.subarray(offset, offset + opaqueLength)
  offset += opaqueLength
  const alphaLength = view.getUint32(offset, true)
  offset += 4
  const alpha = alphaLength > 0 ? frame.subarray(offset, offset + alphaLength) : undefined
  return {
    contentSerial,
    mimeType: encodingType === 1 ? 'image/png' : 'video/h264',
    size: { width, height },
    encodedSize: { width: encodedWidth, height: encodedHeight },
    opaque,
    alpha,
  }
}
