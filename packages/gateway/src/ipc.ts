/**
 * Messages between the monitor (privileged in PAM mode) and the web process (unprivileged).
 *
 * The web process never learns passwords beyond forwarding them once for authentication, and can only act on
 * sessions through tickets the monitor issued on successful login.
 */
export type WebRequest =
  | { type: 'auth'; username: string; password: string }
  | { type: 'logout'; ticket: string }
  /** attach or create: the user's desktop is started if it isn't running (a user has at most one) */
  | { type: 'desktop'; ticket: string }
  | { type: 'endDesktop'; ticket: string }
  /** where to connect for the ticket's user's desktop */
  | { type: 'desktopSocket'; ticket: string }

export type WebRequestEnvelope = { serial: number; request: WebRequest }

export type MonitorReply =
  | { ok: true; type: 'auth'; ticket: string; username: string }
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
  viewerDir: string
  devMode: boolean
  /** test only (see --dev-time-scale): divides the sign-in delays; 1 in production */
  timeScale: number
}

/** Sent by a session process to the monitor once its socket is listening. (Its start-up input is the SessionConfig on fd 3, see session-config.ts.) */
export type SessionReady = { type: 'ready' }
