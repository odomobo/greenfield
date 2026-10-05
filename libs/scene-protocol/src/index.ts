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
 * width, surface height, x, y, width, height, then u8 format (`PatchFormat`), u8 channels (3 or 4), followed by the
 * pixels of that rectangle of the surface in that format: raw (RGB or RGBA, rows top to bottom), QOI, or the LZ4 block
 * of a QOI stream (see `PatchFormat`). The rectangle's width and height are the image's.
 *
 * FILE payload (viewer -> server): u32le file id, then the next bytes of that file: files dragged from the user's
 * computer onto the desktop are uploaded in chunks, announced by a `file-drop` message (ids, names, sizes), see there.
 * ACK payload (viewer -> server): u32le received, u32le backlogBytes, u32le largestPendingBytes, see `ViewerAck`.
 * AUDIO payload (server -> viewer): u16le sequence number, u32le timestamp, one Opus packet (20 ms of 48 kHz stereo).
 * The sequence number counts packets (mod 2^16), the timestamp counts samples at 48 kHz (mod 2^32; its origin is
 * arbitrary and changes whenever the server starts capturing again, e.g. after a mute), so a viewer detects lost
 * packets by gaps in the sequence, and how much audio is missing from the timestamps. Audio is sent only after the
 * viewer asked for it with `audio.mute` (muted: false), see there.
 *
 * Audio envelopes have control priority: they go out right away, ahead of frames and patches, and are neither
 * acknowledged nor counted by the congestion controller (about 14 KB/s, small next to the video). Control messages
 * are never dropped, audio packets are: when the connection's send buffer is full the server drops packets instead of
 * letting the audio get ever later (the sequence numbers show it). The viewer plays audio through a small jitter
 * buffer and does not conceal losses.
 *
 * Data envelopes (FRAME and PATCH) are acknowledged for congestion control (see "Transport and congestion control" in
 * ROADMAP.md): the viewer sends an ACK first thing when a data envelope arrives, before decoding it, so the server's
 * round-trip times measure the network, not decoding. Data envelopes are numbered implicitly, in the order they're
 * sent (TCP keeps it); `received` counts them. The ACK also reports the viewer's backlog (received, not yet applied):
 * the server sends no data while `backlogBytes - largestPendingBytes > BACKLOG_HOLD_BYTES`, so after applying an item
 * the viewer sends a fresh ACK (same `received`) whenever its last report was over that, or the server would wait
 * forever. Control envelopes are never acknowledged.
 *
 * A surface is either streamed as video (FRAME, H.264) or updated with lossless patches (raw, QOI or QOI + LZ4) (PATCH) of its changed
 * areas, see the encoding policy in ROADMAP.md. Frames and patches of one surface arrive in order and are applied in
 * order: a patch draws over whatever the surface showed (including the last video frame), a video frame replaces it.
 *
 * Window state (position, size, stacking, minimized, maximized) is the server's. The viewer changes it optimistically
 * (a drag shows the window where the pointer is right away) and reconciles with sequence numbers: every window.* change
 * it sends carries the next number for that window (`seq`, one counter per window, continuing from the window's `seq`
 * in the scene), and every scene window carries the last number the server applied (`seq`). While the server's number
 * is behind the last one sent, or while the window is being dragged, the viewer keeps showing its own state for that
 * window; once the server caught up, the server's state is shown as is, including its corrections. A late scene that
 * still reflects an older move can't pull a window back, and changes the server makes on its own (an app maximizing,
 * a dialog following its parent) show whenever the viewer has nothing unconfirmed for that window.
 *
 * Surfaces are identified by a key "<clientId>/<surfaceId>". Coordinates are in output (canvas CSS) pixels, at any
 * device pixel ratio: the viewer reports its scale (devicePixelRatio) but the output size stays in CSS pixels.
 *
 * HiDPI: the server tells apps the viewer's scale (wl_output.scale, wp_fractional_scale_v1), so they render at device
 * pixels. A surface's x, y, width and height (scene, input regions, cursor hotspots, input coordinates) stay logical,
 * in CSS pixels; the content of its frames and patches is the app's buffer, at its own size, often larger (the
 * `surfaceSize` of a patch, the size of a frame). The viewer draws that content into the logical rectangle, stretched
 * as needed (one device pixel per buffer pixel when the scales agree). Patch rectangles are in buffer pixels.
 *
 * Window decorations: a window with `decorated` set has a frame drawn by the viewer (a title bar above, a thin border on
 * the other sides, an invisible resize margin outside), see `frameInsets`. The frame is outside the app's content:
 * `x`, `y`, `geometry`, the surfaces, input coordinates and `window.move`/`window.resize` all keep meaning the app's
 * window geometry, exactly as for an undecorated window, so the frame is never part of any of them. Whoever reasons about
 * the window's outer rectangle (placement, centering a dialog on its parent, keeping a window reachable on screen) adds
 * `frameInsets` to the geometry: the server does it where it places windows and sizes them to the output (a maximized
 * decorated window gets the output minus the title bar, at y = TITLE_HEIGHT), the viewer when it draws the frame, hit
 * tests it and keeps windows reachable. Both use the constants and the function below, so they can't disagree.
 *
 * Runs unchanged in the browser bundle and in Node: only Uint8Array, DataView and TextEncoder/TextDecoder are used.
 * Node consumers that need Buffers (e.g. for ws's typings) can adapt with Buffer.from, which is a Uint8Array view.
 */
export const PROTOCOL_VERSION = 17

/**
 * The title bar's height of a decorated window, in CSS pixels (a fixed constant of the frame, shared by both sides). The
 * same as the viewer's taskbar (--taskbar-height in the theme).
 */
export const FRAME_TITLE_HEIGHT = 48
/** The visible border's width on the left, right and bottom of a decorated window, in CSS pixels. */
export const FRAME_BORDER = 1

/** How far a window's frame reaches beyond the app's window geometry on each side, in CSS pixels. */
export type FrameInsets = { top: number; left: number; right: number; bottom: number }

/**
 * The frame around a window's geometry: none for an undecorated or fullscreen window, the title bar alone for a
 * maximized one (it fills the output, so no borders), the title bar and the borders otherwise.
 */
export function frameInsets(window: { decorated?: boolean; maximized?: boolean; fullscreen?: boolean }): FrameInsets {
  if (!window.decorated || window.fullscreen) {
    return { top: 0, left: 0, right: 0, bottom: 0 }
  }
  const border = window.maximized ? 0 : FRAME_BORDER
  return { top: FRAME_TITLE_HEIGHT, left: border, right: border, bottom: border }
}

export const enum EnvelopeKind {
  CONTROL = 1,
  FRAME = 2,
  PATCH = 3,
  FILE = 4,
  ACK = 5,
  AUDIO = 6,
}

/**
 * The server holds data envelopes while the viewer's reported backlog, not counting its largest item, is over this
 * (bytes). See ACK above.
 */
export const BACKLOG_HOLD_BYTES = 1024 * 1024

/** What an ACK envelope reports. */
export type ViewerAck = {
  /** data envelopes (FRAME, PATCH) received on this connection so far, mod 2^32 */
  received: number
  /** bytes of data envelopes received but not yet applied (a patch drawn, a frame decoded; dropped counts as applied) */
  backlogBytes: number
  /** the size of the largest single envelope in that backlog, 0 if none */
  largestPendingBytes: number
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
  /**
   * The surface belongs to one of the window's popups (an xdg popup, an X11 override-redirect menu or tooltip, and
   * their subsurfaces); absent: false, the window's own surface or a subsurface of it. Popups come after the window's
   * own surfaces. The viewer shows them above all windows (a menu or tooltip of a window that isn't on top isn't covered
   * by the ones that are), and doesn't clip them to the window's frame: they reach past the window's edge on purpose.
   */
  popup?: boolean
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
  /**
   * The viewer draws a frame (title bar, borders, resize margin) around the window; absent: false, the app draws its
   * own decorations, or none. Wayland apps that ask for server side decorations (xdg-decoration) and X11 windows that
   * don't say they have none (_MOTIF_WM_HINTS) are decorated; popups, cursors and drag icons never are. See the top of
   * this file for what the frame does to the window's geometry.
   */
  decorated?: boolean
  /** hidden (shown only in the taskbar); window.activate shows it again */
  minimized: boolean
  /** false until the viewer decided where the window goes (send window.move) */
  placed: boolean
  /**
   * The last window change sequence number the server applied for this window (0: none), see the top of this file.
   */
  seq: number
  /** position of the main surface's origin */
  x: number
  y: number
  /** window geometry relative to the main surface origin (excludes client side shadows) */
  geometry: { x: number; y: number; width: number; height: number }
  /** size of the configure the committed content reflects (xdg_toplevel only), see the server's SceneWindow */
  configuredSize?: { width: number; height: number }
  /**
   * The size limits the app declared, in window geometry pixels (xdg_toplevel min_size/max_size, X11 WM_NORMAL_HINTS
   * PMinSize/PMaxSize). 0 (or absent) means unbounded, as in xdg-shell. The viewer keeps interactive resizes inside.
   */
  minWidth?: number
  minHeight?: number
  maxWidth?: number
  maxHeight?: number
  /** bottom to top, relative to the window origin */
  surfaces: SceneSurface[]
}

export type ServerMessage =
  | { type: 'welcome'; protocolVersion: number }
  /** Full snapshot, sent on attach and whenever anything changes. Windows are ordered bottom to top. */
  | { type: 'scene'; windows: SceneWindow[]; focus: string | null }
  | { type: 'cursor'; kind: 'default' | 'hidden' }
  | { type: 'cursor'; kind: 'named'; name: string }
  /**
   * size: the cursor surface's logical size (CSS pixels). The cursor surface isn't in the scene, and its content can
   * be larger (an app rendering at the viewer's scale). Absent: the size of the content.
   */
  | {
      type: 'cursor'
      kind: 'surface'
      surface: string
      hotspot: { x: number; y: number }
      size?: { width: number; height: number }
    }
  /**
   * An app set the clipboard (not the primary selection, which stays between the remote apps): its text, UTF-8, at
   * most 4 MB. The viewer writes it to the browser's clipboard. Text only for now.
   */
  | { type: 'clipboard'; text: string }
  /**
   * A drag and drop between remote apps is going on (an app started it with a button held) or ended. While it goes on
   * the pointer messages must name the surface under the pointer, not the one the press started on (the implicit
   * grab doesn't apply), and the viewer shows the icon, if there is one: the content of surface `icon.surface` (a
   * surface that isn't part of any window, like a cursor surface) with its top left at the pointer plus (x, y).
   * Sent again when the icon changes.
   */
  | { type: 'drag'; active: boolean; icon?: { surface: string; x: number; y: number } }
  /** The client asked to start an interactive move/resize (xdg_toplevel.move/resize) during the current button press. */
  | { type: 'interactive'; mode: 'move'; window: string }
  | { type: 'interactive'; mode: 'resize'; window: string; edges: number }
  /** The client asked to be (un)maximized; the scene follows once it committed. Lets the viewer animate right away. */
  | { type: 'maximize-requested'; window: string; maximized: boolean }
  /**
   * The app's own title bar was right-clicked (xdg_toplevel.show_window_menu, client-side decorations): the viewer
   * opens its window menu (the one of our own title bars) at x, y, in the window's main surface coordinates.
   */
  | { type: 'window-menu-requested'; window: string; x: number; y: number }
  /**
   * An app locked the pointer to a surface (locked: true, confined: false): the viewer requests the browser's pointer
   * lock and sends `pointer.relative` instead of positions, until it's unlocked (the app let go, the window lost
   * focus) or the browser ends the lock (then it sends `pointer.unlock`). confined: the pointer is kept in a region
   * of the surface; the server does it by clamping the viewer's positions, the viewer does nothing.
   */
  | { type: 'pointer.lock'; surface: string; locked: boolean; confined: boolean }
  /** A window's own icon (X11 _NET_WM_ICON, nearest to 48 px) as a PNG data URL, null if it has none (anymore). Resent on attach. */
  | { type: 'window.icon'; window: string; icon: string | null }
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
  /**
   * Whether the session has audio (its own PipeWire is running); sent on attach and when it changes. Without it the
   * session works silently and `audio.mute` has no effect.
   */
  | { type: 'audio.state'; available: boolean }

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

/**
 * The browser's modifier state at an input event (KeyboardEvent/MouseEvent.getModifierState()), sent with every key,
 * pointer, button and axis message. It's the truth about modifiers: the server's keyboard state is made to agree with
 * it before the event (a modifier released while the page didn't have focus is released then). altGr: AltGraph; ctrl
 * and alt are false while it's held (Windows reports AltGr as Ctrl+Alt).
 */
export type Modifiers = {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  altGr: boolean
  capsLock: boolean
  numLock: boolean
}

export type ViewerMessage =
  /** scale: the viewer's devicePixelRatio. The server tells apps (they render at it); the output size stays in CSS pixels. */
  | { type: 'hello'; output: { width: number; height: number; scale: number } }
  | { type: 'output'; width: number; height: number; scale: number }
  | ({ type: 'pointer'; buttons: number; modifiers: Modifiers } & PointerTarget)
  | ({ type: 'button'; button: number; pressed: boolean; buttons: number; modifiers: Modifiers } & PointerTarget)
  /**
   * wheelX/wheelY: set when a pixel-mode (deltaMode 0) delta is a wheel click rather than touchpad scrolling: the
   * signed v120 value (120 per click). Line deltas (deltaMode 1) are wheel clicks too.
   */
  | ({
      type: 'axis'
      deltaX: number
      deltaY: number
      deltaMode: number
      wheelX?: number
      wheelY?: number
      modifiers: Modifiers
    } & PointerTarget)
  /** Relative pointer motion while the browser's pointer lock is on (see `pointer.lock`), in CSS pixels. */
  | { type: 'pointer.relative'; dx: number; dy: number; time: number }
  /** The browser ended the pointer lock (Escape, focus lost): the server deactivates the app's constraint. */
  | { type: 'pointer.unlock' }
  /**
   * A touch point (pointerType 'touch'): id is the pointer event's pointerId. Coordinates are local to the surface the
   * point went down on (it stays there until it ends); `surface` is that surface's key.
   */
  | ({ type: 'touch'; phase: 'down' | 'move' | 'up' | 'cancel'; id: number; modifiers: Modifiers } & PointerTarget)
  /**
   * code is KeyboardEvent.code, the server maps it to an evdev key code and owns the keymap. Keys that repeat
   * (KeyboardEvent.repeat) aren't sent: apps repeat keys themselves.
   */
  | { type: 'key'; code: string; pressed: boolean; modifiers: Modifiers; time: number }
  /**
   * The browser's clipboard text, sent when the user pastes (Ctrl+V, Shift+Insert) and it isn't what the viewer last
   * synchronized, before the key events of the paste. The server makes it the clipboard selection of the session.
   */
  | { type: 'clipboard'; text: string }
  /** the viewer page gained/lost keyboard focus (lost also when it's hidden); losing it releases every held key */
  | { type: 'focus'; focused: boolean }
  /**
   * Files from the user's computer are being dragged over the desktop (the browser's drag events), at this target;
   * sent as they move. The server starts a drag with a text/uri-list offer, so apps under the pointer show their drop
   * targets. over: false when the drag left the page (or was cancelled).
   */
  | ({ type: 'file-drag'; over: boolean } & PointerTarget)
  /**
   * The files were dropped at this target. Their content follows as FILE envelopes (ids, in order, `size` bytes in
   * all); once complete the server saves them in a directory of the user's (~/.cache/greenfield/drops/<random>/, files
   * older than a day are removed when a session starts) and gives the app under the pointer their file:// URIs.
   */
  | ({ type: 'file-drop'; files: { id: number; name: string; size: number }[] } & PointerTarget)
  // window changes; seq: the window's next change sequence number, see the top of this file
  | { type: 'window.move'; window: string; seq: number; x: number; y: number }
  | { type: 'window.activate'; window: string; seq: number }
  /** width/height are window geometry sizes. done: the interactive resize ended. */
  | { type: 'window.resize'; window: string; seq: number; width: number; height: number; edges: number; done: boolean }
  | { type: 'window.maximize'; window: string; seq: number; maximized: boolean }
  | { type: 'window.minimize'; window: string; seq: number; minimized: boolean }
  | { type: 'window.close'; window: string }
  /** frame pacing: how often the viewer refreshes (ms) */
  | { type: 'feedback'; refreshInterval: number }
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
   * Whether the viewer wants no audio. A session sends no audio to a viewer until it said `muted: false` (the viewer
   * sends its state first thing after connecting), and stops capturing and encoding while it's muted.
   */
  | { type: 'audio.mute'; muted: boolean }

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

/** Encode a viewer -> server chunk of an uploaded file (see `file-drop`) as a binary envelope. */
export function encodeFileChunk(id: number, bytes: Uint8Array): Uint8Array {
  const envelope = new Uint8Array(6 + bytes.byteLength)
  envelope[0] = PROTOCOL_VERSION
  envelope[1] = EnvelopeKind.FILE
  new DataView(envelope.buffer).setUint32(2, id, true)
  envelope.set(bytes, 6)
  return envelope
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

/** Encode a viewer -> server acknowledgement (see ACK above) as a binary envelope. */
export function encodeAck(ack: ViewerAck): Uint8Array {
  const envelope = new Uint8Array(2 + 12)
  envelope[0] = PROTOCOL_VERSION
  envelope[1] = EnvelopeKind.ACK
  const view = new DataView(envelope.buffer)
  view.setUint32(2, ack.received >>> 0, true)
  view.setUint32(6, Math.min(ack.backlogBytes, 0xffffffff) >>> 0, true)
  view.setUint32(10, Math.min(ack.largestPendingBytes, 0xffffffff) >>> 0, true)
  return envelope
}

/** Audio samples per second and per Opus packet's channel, and the packet duration: fixed by the protocol. */
export const AUDIO_SAMPLE_RATE = 48000
export const AUDIO_CHANNELS = 2
export const AUDIO_PACKET_SAMPLES = 960

/** One packet of the audio stream, see the AUDIO envelope. */
export type AudioPacket = { seq: number; timestamp: number; opus: Uint8Array }

const AUDIO_HEADER_BYTES = 2 + 2 + 4

/** Encode a server -> viewer audio packet as a binary envelope. */
export function encodeAudio(packet: AudioPacket): Uint8Array {
  const envelope = new Uint8Array(AUDIO_HEADER_BYTES + packet.opus.byteLength)
  const view = new DataView(envelope.buffer)
  envelope[0] = PROTOCOL_VERSION
  envelope[1] = EnvelopeKind.AUDIO
  view.setUint16(2, packet.seq & 0xffff, true)
  view.setUint32(4, packet.timestamp >>> 0, true)
  envelope.set(packet.opus, AUDIO_HEADER_BYTES)
  return envelope
}

/** The number of packets lost between two consecutive received sequence numbers (0 when `next` follows `previous`). */
export function audioPacketsLost(previous: number, next: number): number {
  return (next - previous - 1) & 0xffff
}

export type ViewerEnvelope =
  | { kind: 'control'; message: ControlMessage }
  | { kind: 'file'; id: number; data: Uint8Array }
  | ({ kind: 'ack' } & ViewerAck)

/** Decode any viewer -> server envelope (a control message, a chunk of a file, an ack). Throws like decodeControl. */
export function decodeViewerEnvelope(data: Uint8Array): ViewerEnvelope {
  if (data.byteLength >= 6 && data[0] === PROTOCOL_VERSION && data[1] === EnvelopeKind.FILE) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    return { kind: 'file', id: view.getUint32(2, true), data: data.subarray(6) }
  }
  if (data.byteLength >= 2 && data[0] === PROTOCOL_VERSION && data[1] === EnvelopeKind.ACK) {
    if (data.byteLength !== 14) {
      throw new Error(`ACK envelope of ${data.byteLength} bytes.`)
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    return {
      kind: 'ack',
      received: view.getUint32(2, true),
      backlogBytes: view.getUint32(6, true),
      largestPendingBytes: view.getUint32(10, true),
    }
  }
  return { kind: 'control', message: decodeControl(data) }
}

/** True for a server -> viewer data envelope (FRAME or PATCH, the ones the viewer acknowledges). */
export function isDataEnvelope(data: Uint8Array): boolean {
  return data.byteLength >= 2 && (data[1] === EnvelopeKind.FRAME || data[1] === EnvelopeKind.PATCH)
}

/**
 * How a patch's pixels are encoded (the format tag). Raw, QOI and QOI + LZ4 are lossless (the cascade of "Encoding
 * policy" in ROADMAP.md). 3 and 4 are reserved for JPEG and JPEG with alpha (lossy patches, later).
 */
export enum PatchFormat {
  /** width x height x channels bytes, RGB (opaque) or RGBA, rows top to bottom */
  RAW = 0,
  /** a QOI stream (https://qoiformat.org), 3 or 4 channels */
  QOI = 1,
  /** the LZ4 block (no frame, no length prefix) of a QOI stream; the viewer decompresses it into a buffer of the QOI size bound */
  QOI_LZ4 = 2,
}

/** A lossless update of a rectangle of a surface, see the PATCH envelope. */
export type Patch = {
  contentSerial: number
  /** size of the whole surface at the time the patch was made */
  surfaceSize: { width: number; height: number }
  /** the patched rectangle, in surface (buffer) pixels */
  rect: { x: number; y: number; width: number; height: number }
  /** how `data` is encoded */
  format: PatchFormat
  /** 3 if the rectangle is opaque (the alpha was dropped), else 4 */
  channels: 3 | 4
  /** the rectangle's pixels in `format` */
  data: Uint8Array
}

const PATCH_HEADER_BYTES = 7 * 4 + 2

/** Encode a server -> viewer patch as a binary envelope addressed to the surface's key. */
export function encodePatch(surfaceKey: string, patch: Patch): Uint8Array {
  const key = textEncoder.encode(surfaceKey)
  const envelope = new Uint8Array(4 + key.byteLength + PATCH_HEADER_BYTES + patch.data.byteLength)
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
  envelope[offset] = patch.format
  envelope[offset + 1] = patch.channels
  envelope.set(patch.data, offset + 2)
  return envelope
}

function parsePatch(payload: Uint8Array): Patch {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const u32 = (index: number) => view.getUint32(index * 4, true)
  return {
    contentSerial: u32(0),
    surfaceSize: { width: u32(1), height: u32(2) },
    rect: { x: u32(3), y: u32(4), width: u32(5), height: u32(6) },
    format: payload[28],
    channels: payload[29] === 3 ? 3 : 4,
    data: payload.subarray(PATCH_HEADER_BYTES),
  }
}

export type DecodedEnvelope =
  | { kind: 'control'; message: ServerMessage }
  | { kind: 'frame'; surface: string; frame: Uint8Array }
  | { kind: 'patch'; surface: string; patch: Patch }
  | ({ kind: 'audio' } & AudioPacket)

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
  if (bytes[1] === EnvelopeKind.AUDIO) {
    if (bytes.byteLength <= AUDIO_HEADER_BYTES) {
      throw new Error(`AUDIO envelope of ${bytes.byteLength} bytes.`)
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return {
      kind: 'audio',
      seq: view.getUint16(2, true),
      timestamp: view.getUint32(4, true),
      opus: bytes.subarray(AUDIO_HEADER_BYTES),
    }
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
