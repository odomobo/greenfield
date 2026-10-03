/**
 * Signing in, like unlocking a screen: the token lives only in this page's memory (never in cookies or storage), so
 * another tab, a reload or reopening the browser has to sign in again. The page keeps a presence WebSocket to the
 * gateway open; when it closes for good, the gateway revokes the token.
 */

export class SignedOut extends Error {
  constructor() {
    super('Signed out')
  }
}

/** close code of the gateway for an unknown or revoked token */
const CLOSE_UNAUTHORIZED = 4001
/** how long to keep trying to restore the presence connection (the gateway's grace is a bit longer) */
const PRESENCE_RETRY_MS = 4000

let token: string | undefined
let presence: WebSocket | undefined
let presenceLostAt: number | undefined
let retryTimer: number | undefined
let onSignedOut: () => void = () => {
  /* noop */
}

export function currentToken(): string | undefined {
  return token
}

/** called once when the gateway stops accepting our token (not after signOut()) */
export function setSignedOutHandler(handler: () => void): void {
  onSignedOut = handler
}

export type LoginResult = { ok: true; username: string } | { ok: false; error: string }

export async function login(username: string, password: string): Promise<LoginResult> {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    credentials: 'omit',
    cache: 'no-store',
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || typeof body.token !== 'string') {
    return { ok: false, error: typeof body.error === 'string' ? body.error : 'Signing in failed. Please try again.' }
  }
  token = body.token
  connectPresence()
  return { ok: true, username: body.username }
}

/** Forget the token here and revoke it at the gateway. */
export function signOut(): void {
  const revoked = token
  forget()
  if (revoked !== undefined) {
    // keepalive: also delivered when the page is going away
    fetch('/api/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${revoked}` },
      credentials: 'omit',
      keepalive: true,
    }).catch(() => {
      /* the presence connection is closed too, the gateway revokes the token anyway */
    })
  }
}

function forget() {
  token = undefined
  clearTimeout(retryTimer)
  presenceLostAt = undefined
  const ws = presence
  presence = undefined
  ws?.close()
}

function signedOut() {
  if (token === undefined) {
    return
  }
  forget()
  onSignedOut()
}

function connectPresence() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/control`)
  presence = ws
  ws.onopen = () => ws.send(token!)
  ws.onmessage = () => {
    // { type: 'ok' }: the gateway accepted the token
    presenceLostAt = undefined
  }
  ws.onclose = (event) => {
    if (presence !== ws) {
      return
    }
    presence = undefined
    if (event.code === CLOSE_UNAUTHORIZED) {
      signedOut()
      return
    }
    // a network blip: try again for a little while
    presenceLostAt ??= Date.now()
    if (Date.now() - presenceLostAt > PRESENCE_RETRY_MS) {
      signedOut()
      return
    }
    retryTimer = window.setTimeout(connectPresence, 1000)
  }
}

/** A request to the gateway with our token. Throws SignedOut if the gateway doesn't accept it (anymore). */
export async function api(path: string, options: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<Response> {
  if (token === undefined) {
    throw new SignedOut()
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'omit',
    cache: 'no-store',
  })
  if (response.status === 401) {
    signedOut()
    throw new SignedOut()
  }
  return response
}
