/**
 * Messages between the monitor (privileged in PAM mode) and the web process (unprivileged).
 *
 * The web process never learns passwords beyond forwarding them once for authentication, and can only act on
 * sessions through tickets the monitor issued on successful login.
 */
import { AppConfigSchema } from './app-config'

export type SessionInfo = {
  id: string
  createdAt: number
}

export type WebRequest =
  | { type: 'auth'; username: string; password: string }
  | { type: 'logout'; ticket: string }
  | { type: 'listSessions'; ticket: string }
  | { type: 'createSession'; ticket: string }
  | { type: 'endSession'; ticket: string; sessionId: string }
  /** where to connect for a session the ticket's user owns */
  | { type: 'sessionSocket'; ticket: string; sessionId: string }

export type WebRequestEnvelope = { serial: number; request: WebRequest }

export type MonitorReply =
  | { ok: true; type: 'auth'; ticket: string; username: string }
  | { ok: true; type: 'sessions'; sessions: SessionInfo[] }
  | { ok: true; type: 'session'; session: SessionInfo }
  | { ok: true; type: 'socket'; path: string }
  | { ok: true; type: 'done' }
  | { ok: false; error: 'auth-failed' | 'forbidden' | 'not-found' | 'failed' }

export type MonitorReplyEnvelope = { serial: number; reply: MonitorReply }

/** Sent once by the monitor when the web process starts (with the listening socket as handle). */
export type WebStart = {
  type: 'start'
  tls: { cert: string; key: string } | undefined
  hostname: string | undefined
  allowedOrigins: string[]
  applications: AppConfigSchema
  viewerDir: string
  devMode: boolean
}

/** Sent by a session process to the monitor once its socket is listening. */
export type SessionReady = { type: 'ready' }

export type SessionStart = {
  type: 'start'
  sessionId: string
  socketPath: string
  encoder: 'x264' | 'nvh264' | 'vaapih264'
  renderDevice: string
}
