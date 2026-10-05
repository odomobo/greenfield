import type { SessionEncoder } from './encoder'

/**
 * Messages between the monitor (privileged in PAM mode) and the web process (unprivileged).
 *
 * The web process never learns passwords beyond forwarding them once for authentication, and can only act on
 * sessions through tickets the monitor issued on successful login.
 */
export type SessionInfo = {
  id: string
  /** user-visible name, "Nebula N" until the user renames it */
  name: string
  createdAt: number
}

export const MAX_SESSION_NAME_LENGTH = 64

/**
 * A session name as entered by the user: trimmed, whitespace runs collapsed, control characters removed. Undefined if
 * nothing usable is left or it's too long.
 */
export function normalizeSessionName(name: unknown): string | undefined {
  if (typeof name !== 'string') {
    return undefined
  }
  // eslint-disable-next-line no-control-regex
  const normalized = name
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length === 0 || [...normalized].length > MAX_SESSION_NAME_LENGTH) {
    return undefined
  }
  return normalized
}

export type WebRequest =
  | { type: 'auth'; username: string; password: string }
  | { type: 'logout'; ticket: string }
  | { type: 'listSessions'; ticket: string }
  | { type: 'createSession'; ticket: string }
  | { type: 'endSession'; ticket: string; sessionId: string }
  | { type: 'renameSession'; ticket: string; sessionId: string; name: string }
  /** where to connect for a session the ticket's user owns */
  | { type: 'sessionSocket'; ticket: string; sessionId: string }

export type WebRequestEnvelope = { serial: number; request: WebRequest }

export type MonitorReply =
  | { ok: true; type: 'auth'; ticket: string; username: string }
  | { ok: true; type: 'sessions'; sessions: SessionInfo[] }
  | { ok: true; type: 'session'; session: SessionInfo }
  | { ok: true; type: 'socket'; path: string }
  | { ok: true; type: 'done' }
  | { ok: false; error: 'auth-failed' | 'forbidden' | 'not-found' | 'invalid' | 'failed' }

export type MonitorReplyEnvelope = { serial: number; reply: MonitorReply }

/** Sent once by the monitor when the web process starts (with the listening socket as handle). */
export type WebStart = {
  type: 'start'
  tls: { cert: string; key: string } | undefined
  hostname: string | undefined
  allowedOrigins: string[]
  viewerDir: string
  devMode: boolean
  /** test only (see --dev-time-scale): divides the sign-in delays; 1 in production */
  timeScale: number
}

/** Sent by a session process to the monitor once its socket is listening. */
export type SessionReady = { type: 'ready' }

export type SessionStart = {
  type: 'start'
  sessionId: string
  socketPath: string
  encoder: SessionEncoder
  renderDevice: string
  /** test only (see --dev-time-scale): divides how long apps get to quit when the session ends; 1 in production */
  timeScale: number
  /** test only (see --dev-link-kbps): the simulated link to the viewer in kbit/s; 0 in production */
  linkKbps: number
  /** test only (see --dev-patch-order): 'oldest' in production */
  patchOrder: 'oldest' | 'random'
  /** test only (see --dev-patch-shape): 'bands' in production */
  patchShape: 'bands' | 'tiles'
}
