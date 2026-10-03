import { Connection, ConnectionState } from './connection'
import { Desktop } from './desktop'
import { Renderer } from './gl/renderer'

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) {
    throw new Error(`BUG. No element with id "${id}"`)
  }
  return found as T
}

/**
 * Served by the gateway at /desktop/?session=<id>. The gateway authenticates every request (cookie) and only lets
 * us reach our own sessions.
 */
const params = new URLSearchParams(location.search)
const session = params.get('session') ?? ''
const viewerURL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?session=${encodeURIComponent(session)}`

let csrfToken: string | undefined

/** The gateway's view of us: undefined when we're no longer signed in. */
async function fetchMe(): Promise<{ username: string; csrf: string } | undefined> {
  const response = await fetch('/api/me', { credentials: 'same-origin' })
  if (response.status === 401) {
    return undefined
  }
  return response.json()
}

async function sessionStillExists(): Promise<boolean | undefined> {
  const response = await fetch('/api/sessions', { credentials: 'same-origin' })
  if (response.status === 401) {
    return undefined
  }
  const sessions: { id: string }[] = await response.json()
  return sessions.some(({ id }) => id === session)
}

const canvas = element<HTMLCanvasElement>('output')
const status = element<HTMLDivElement>('status')
const overlay = element<HTMLDivElement>('overlay')
const overlayMessage = element<HTMLDivElement>('overlay-message')
const reconnectButton = element<HTMLButtonElement>('overlay-reconnect')
const sessionsLink = element<HTMLAnchorElement>('overlay-sessions')
const user = element<HTMLSpanElement>('user')

const testMode = params.get('test') === '1'
const connection = new Connection(viewerURL)
const renderer = new Renderer(canvas, { preserveDrawingBuffer: testMode })
const desktop = new Desktop(canvas, renderer, connection)

if (testMode) {
  // hooks for automated tests (see scripts/test-gateway.sh)
  ;(window as any).__viewerTest = {
    connected: () => connection.open,
    windows: () => desktop.debugWindows(),
    readLuma: (x: number, y: number, width: number, height: number) => renderer.readLuma(x, y, width, height),
  }
}

connection.onOpen = () => desktop.reset()
connection.onEnvelope = (envelope) => {
  if (envelope.kind === 'control') {
    desktop.handleMessage(envelope.message)
  } else {
    desktop.handleFrame(envelope.surface, envelope.frame)
  }
}
connection.onStateChange = (state: ConnectionState) => {
  reconnectButton.hidden = true
  switch (state.kind) {
    case 'connecting':
      status.textContent = 'connecting…'
      break
    case 'connected':
      status.textContent = 'connected'
      overlay.hidden = true
      break
    case 'reconnecting':
      status.textContent = 'disconnected'
      overlayMessage.textContent = `Connection lost. Reconnecting in ${state.inSeconds}s…`
      overlay.hidden = false
      checkSessionAfterDisconnect()
      break
    case 'taken-over':
      status.textContent = 'taken over'
      overlayMessage.textContent = 'This session was opened somewhere else.'
      reconnectButton.hidden = false
      overlay.hidden = false
      break
  }
}
reconnectButton.addEventListener('click', () => connection.connect())

async function checkSessionAfterDisconnect() {
  try {
    const exists = await sessionStillExists()
    if (exists === undefined) {
      // signed out (or the gateway restarted): back to the login page
      location.href = '/login'
    } else if (!exists) {
      connection.stop()
      overlayMessage.textContent = 'This session has ended.'
      overlay.hidden = false
      sessionsLink.hidden = false
    }
  } catch {
    // gateway unreachable; keep retrying
  }
}

async function loadApps() {
  const apps = element<HTMLDivElement>('apps')
  try {
    const response = await fetch('/api/apps', { credentials: 'same-origin' })
    const list: { path: string; name: string }[] = await response.json()
    apps.replaceChildren(
      ...list.map(({ path, name }) => {
        const button = document.createElement('button')
        button.textContent = name
        button.dataset.app = path
        button.addEventListener('click', async () => {
          const result = await fetch(`/api/sessions/${encodeURIComponent(session)}/launch`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken ?? '' },
            body: JSON.stringify({ app: path }),
          })
          if (!result.ok) {
            console.error(`Failed to launch ${name}: ${result.status}`)
          }
          canvas.focus()
        })
        return button
      }),
    )
  } catch (e) {
    console.error('Failed to load applications', e)
  }
}

async function main() {
  const me = await fetchMe()
  if (me === undefined) {
    location.href = '/login'
    return
  }
  csrfToken = me.csrf
  user.textContent = me.username
  loadApps()
  connection.connect()
}

main()
