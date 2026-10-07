/**
 * Messages between the monitor (privileged in PAM mode) and the web process (unprivileged).
 *
 * The web process never learns passwords beyond forwarding them once for authentication, and can only act on
 * sessions through tickets the monitor issued on successful login.
 */
export type WebRequest =
  /** ip: the client's address, for the log */
  | { type: 'auth'; username: string; password: string; ip: string }
  /**
   * attach or create: the ticket's user's desktop is started if it isn't running (a user has at most one); the reply
   * is where to connect to it. Uses up the ticket.
   */
  | { type: 'desktop'; ticket: string }

export type WebRequestEnvelope = { serial: number; request: WebRequest }

export type MonitorReply =
  | { ok: true; type: 'auth'; ticket: string; username: string }
  | { ok: true; type: 'socket'; path: string }
  | { ok: false; error: 'auth-failed' | 'forbidden' | 'failed' }

export type MonitorReplyEnvelope = { serial: number; reply: MonitorReply }

/** Sent once by the monitor when the web process starts (with the listening socket as handle). */
export type WebStart = {
  type: 'start'
  tls: { cert: string; key: string }
  hostname: string | undefined
  allowedOrigins: string[]
  viewerDir: string
  devMode: boolean
  /** test only (see --dev-time-scale): divides the failed-sign-in delay; 1 in production */
  timeScale: number
}

/**
 * Sent by a session process to the monitor: `ready` once its socket is listening, `ending` when it was logged out
 * (it no longer takes connections, a sign-in must start a new desktop). (Its start-up input is the SessionConfig on
 * fd 3, see session-config.ts.)
 */
export type SessionMessage = { type: 'ready' } | { type: 'ending' }
