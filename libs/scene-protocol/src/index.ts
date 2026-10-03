/**
 * The wire protocol between the viewer (the browser app) and a session (the server side, in the compositor proxy).
 * This library is the single source of truth; packages/viewer/src/protocol.ts and
 * packages/compositor-proxy/src/viewer/protocol.ts re-export it.
 *
 * One WebSocket per session: ws(s)://<server>/viewer?session=<id>. Every message is a binary envelope:
 *   u8 protocol version, u8 kind, payload
 * CONTROL payload: UTF-8 JSON object with a `type` field (both directions).
 * FRAME payload (server -> viewer): u16le surface key length, surface key, encoded frame blob as produced by the
 * proxy encoder (u32 bufferId, u32 bufferCreationSerial, u32 contentSerial, u16 encoding type, ...). The whole surface.
 * PATCH payload (server -> viewer): u16le surface key length, surface key, then (all u32le) contentSerial, surface
 * width, surface height, x, y, width, height, followed by an RGBA PNG of that rectangle of the surface.
 *
 * A surface is either streamed as video (FRAME, H.264) or updated with lossless PNG patches (PATCH) of its changed
 * areas, see the encoding policy in ROADMAP.md. Frames and patches of one surface arrive in order and are applied in
 * order: a patch draws over whatever the surface showed (including the last video frame), a video frame replaces it.
 *
 * Surfaces are identified by a key "<clientId>/<surfaceId>". Coordinates are in output (canvas CSS) pixels, at any
 * device pixel ratio: the viewer reports its scale (devicePixelRatio) but the output size stays in CSS pixels.
 *
 * Runs unchanged in the browser bundle and in Node: only Uint8Array, DataView and TextEncoder/TextDecoder are used.
 * Node consumers that need Buffers (e.g. for ws's typings) can adapt with Buffer.from, which is a Uint8Array view.
 */
export const PROTOCOL_VERSION = 4

export const enum EnvelopeKind {
  CONTROL = 1,
  FRAME = 2,
  PATCH = 3,
}

/** The session was taken over by another viewer. Don't reconnect automatically. */
export const CLOSE_TAKEN_OVER = 4100
/** Close code sent to a viewer that speaks an unsupported protocol version or sends garbage. */
export const CLOSE_PROTOCOL_ERROR = 4400

// ---------------------------------------------------------------------------------------------------------------------
// server -> viewer

export type SceneRect = { x: number; y: number; width: number; height: number }

export type SceneSurface = {
  id: string
  x: number
  y: number
  width: number
  height: number
  /**
   * Where the surface takes pointer input (wl_surface.set_input_region), surface local rectangles clipped to the
   * surface. Absent: the whole surface. Empty: nowhere, input goes to whatever is underneath.
   */
  input?: SceneRect[]
}

export type SceneWindow = {
  id: string
  /**
   * The window this one belongs to (xdg_toplevel.set_parent, e.g. a dialog). A child window moves with its parent, is
   * stacked above it and is hidden with it; it has no taskbar button of its own. Positions are still absolute.
   */
  parent?: string
  title: string
  appId: string
  activated: boolean
  maximized: boolean
  fullscreen: boolean
  /** hidden (shown only in the taskbar); window.activate shows it again */
  minimized: boolean
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
  /** The client asked to be (un)maximized; the scene follows once it committed. Lets the viewer animate right away. */
  | { type: 'maximize-requested'; window: string; maximized: boolean }
  // desktop shell (packages/gateway/src/shell/service.ts)
  /** installed applications, sorted by name; sent on attach */
  | { type: 'shell.apps'; apps: ShellApp[] }
  /** desktop file IDs of the pinned apps, in order */
  | { type: 'shell.pinned'; apps: string[] }
  /** data URLs for requested icon names (null: no such icon) */
  | { type: 'shell.icons'; icons: Record<string, string | null> }
  /** all kept notifications, oldest first; sent on attach */
  | { type: 'shell.notifications'; notifications: ShellNotification[] }
  /** a new notification, or one replacing the notification with the same id */
  | { type: 'shell.notification'; notification: ShellNotification }
  | { type: 'shell.notification-closed'; id: number }
  | { type: 'shell.launch-failed'; app: string; reason: 'unknown' | 'not-runnable' | 'failed' }

export type ShellApp = {
  /** desktop file ID */
  id: string
  name: string
  genericName?: string
  comment?: string
  keywords: string[]
  /** icon name or path, see shell.icons */
  icon?: string
  /** StartupWMClass: the app_id its windows have, if it's not the desktop file ID */
  wmClass?: string
}

export type ShellNotification = {
  id: number
  appName: string
  summary: string
  body: string
  icon?: string
  desktopEntry?: string
  urgency: 'low' | 'normal' | 'critical'
  /** ms, -1: default, 0: stays until dismissed */
  expireTimeout: number
  time: number
}

// ---------------------------------------------------------------------------------------------------------------------
// viewer -> server

/** Pointer target picked by the viewer: surface key + surface local coordinates, or null for the desktop. */
type PointerTarget = { surface: string | null; sx?: number; sy?: number; x: number; y: number; time: number }

export type ViewerMessage =
  /** scale: the viewer's devicePixelRatio. The server stores it; apps aren't told yet (needs the wlroots migration). */
  | { type: 'hello'; output: { width: number; height: number; scale: number } }
  | { type: 'output'; width: number; height: number; scale: number }
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
  | { type: 'window.minimize'; window: string; minimized: boolean }
  | { type: 'window.close'; window: string }
  /** frame pacing: how often the viewer refreshes and how long decoding takes (ms) */
  | { type: 'feedback'; refreshInterval: number; decodeDuration: number }
  /** the viewer can't decode this surface's stream, send a key frame */
  | { type: 'keyframe'; surface: string }
  | { type: 'shell.launch'; app: string }
  | { type: 'shell.pin'; apps: string[] }
  | { type: 'shell.icons'; names: string[] }
  | { type: 'shell.notification-dismiss'; id: number }
  | { type: 'shell.notifications-clear' }
  /** re-read installed applications (the server rate-limits this) */
  | { type: 'shell.refresh-apps' }

/**
 * A loose control message, as the server side still parses it. New code should prefer the typed `ViewerMessage` /
 * `ServerMessage` unions; this alias exists so existing permissive usages keep compiling.
 */
export type ControlMessage = { type: string; [key: string]: unknown }

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function controlEnvelope(kind: EnvelopeKind, json: Uint8Array): Uint8Array {
  const envelope = new Uint8Array(2 + json.byteLength)
  envelope[0] = PROTOCOL_VERSION
  envelope[1] = kind
  envelope.set(json, 2)
  return envelope
}

/** Encode a viewer -> server control message as a binary envelope. */
export function encodeControl(message: ViewerMessage | ControlMessage): Uint8Array {
  return controlEnvelope(EnvelopeKind.CONTROL, textEncoder.encode(JSON.stringify(message)))
}

/** Encode a server -> viewer frame as a binary envelope addressed to the surface's key. */
export function encodeFrame(surfaceKey: string, frame: Uint8Array): Uint8Array {
  const key = textEncoder.encode(surfaceKey)
  const envelope = new Uint8Array(4 + key.byteLength + frame.byteLength)
  envelope[0] = PROTOCOL_VERSION
  envelope[1] = EnvelopeKind.FRAME
  new DataView(envelope.buffer).setUint16(2, key.byteLength, true)
  envelope.set(key, 4)
  envelope.set(frame, 4 + key.byteLength)
  return envelope
}

/** Decode a viewer -> server control envelope. Throws on a wrong version, kind or payload shape. */
export function decodeControl(data: Uint8Array): ControlMessage {
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

/** A lossless update of a rectangle of a surface, see the PATCH envelope. */
export type Patch = {
  contentSerial: number
  /** size of the whole surface at the time the patch was made */
  surfaceSize: { width: number; height: number }
  /** the patched rectangle, in surface (buffer) pixels */
  rect: { x: number; y: number; width: number; height: number }
  /** RGBA PNG of the rectangle */
  png: Uint8Array
}

const PATCH_HEADER_BYTES = 7 * 4

/** Encode a server -> viewer patch as a binary envelope addressed to the surface's key. */
export function encodePatch(surfaceKey: string, patch: Patch): Uint8Array {
  const key = textEncoder.encode(surfaceKey)
  const envelope = new Uint8Array(4 + key.byteLength + PATCH_HEADER_BYTES + patch.png.byteLength)
  const view = new DataView(envelope.buffer)
  envelope[0] = PROTOCOL_VERSION
  envelope[1] = EnvelopeKind.PATCH
  view.setUint16(2, key.byteLength, true)
  envelope.set(key, 4)
  let offset = 4 + key.byteLength
  for (const value of [
    patch.contentSerial,
    patch.surfaceSize.width,
    patch.surfaceSize.height,
    patch.rect.x,
    patch.rect.y,
    patch.rect.width,
    patch.rect.height,
  ]) {
    view.setUint32(offset, value, true)
    offset += 4
  }
  envelope.set(patch.png, offset)
  return envelope
}

function parsePatch(payload: Uint8Array): Patch {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const u32 = (index: number) => view.getUint32(index * 4, true)
  return {
    contentSerial: u32(0),
    surfaceSize: { width: u32(1), height: u32(2) },
    rect: { x: u32(3), y: u32(4), width: u32(5), height: u32(6) },
    png: payload.subarray(PATCH_HEADER_BYTES),
  }
}

export type DecodedEnvelope =
  | { kind: 'control'; message: ServerMessage }
  | { kind: 'frame'; surface: string; frame: Uint8Array }
  | { kind: 'patch'; surface: string; patch: Patch }

/** Decode a server -> viewer envelope. Throws on an unsupported version or unknown kind. */
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
  if (bytes[1] === EnvelopeKind.PATCH) {
    const keyLength = bytes[2] | (bytes[3] << 8)
    const surface = textDecoder.decode(bytes.subarray(4, 4 + keyLength))
    return { kind: 'patch', surface, patch: parsePatch(bytes.subarray(4 + keyLength)) }
  }
  throw new Error(`Unknown envelope kind ${bytes[1]}`)
}

// ---------------------------------------------------------------------------------------------------------------------
// encoded frames (as produced by the proxy encoder)

export type EncodedFrame = {
  contentSerial: number
  /** real image size */
  size: { width: number; height: number }
  /** padded size the encoder used, the image sits in the bottom right corner */
  encodedSize: { width: number; height: number }
  opaque: Uint8Array
  alpha?: Uint8Array
}

/** Parse an encoded frame blob from a FRAME envelope's payload. */
export function parseEncodedFrame(frame: Uint8Array): EncodedFrame {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  // u32 bufferId, u32 bufferCreationSerial
  let offset = 8
  const contentSerial = view.getUint32(offset, true)
  offset += 4
  // encoding type (u16 + padding), always H.264
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
    size: { width, height },
    encodedSize: { width: encodedWidth, height: encodedHeight },
    opaque,
    alpha,
  }
}

/**
 * True if a viewer can start decoding the surface's stream at this frame (H.264 IDR in every plane).
 */
export function isKeyFrame(frame: Uint8Array): boolean {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  // u32 bufferId, u32 creationSerial, u32 contentSerial
  let offset = 12
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
