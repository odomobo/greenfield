import { api, currentToken, login, setSignedOutHandler, SignedOut, signOut } from './auth'
import { Connection, ConnectionState } from './connection'
import { Desktop } from './desktop'
import { Renderer } from './gl/renderer'
import { SessionInfo, SessionList } from './sessions'
import { Shell } from './shell/shell'

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) {
    throw new Error(`BUG. No element with id "${id}"`)
  }
  return found as T
}

/**
 * The whole app, served by the gateway at /: the sign-in form, the session list and the desktop. Signing in lasts
 * as long as this page (see auth.ts), so switching between them never leaves the page.
 */
const params = new URLSearchParams(location.search)
const testMode = params.get('test') === '1'

const loginView = element<HTMLDivElement>('login-view')
const loginForm = element<HTMLFormElement>('login-form')
const loginError = element<HTMLParagraphElement>('login-error')
const loginSubmit = element<HTMLButtonElement>('login-submit')
const usernameInput = element<HTMLInputElement>('username')
const passwordInput = element<HTMLInputElement>('password')

const sessionsView = element<HTMLDivElement>('sessions-view')
const sessionsError = element<HTMLParagraphElement>('sessions-error')
const welcome = element<HTMLHeadingElement>('welcome')
const newSessionButton = element<HTMLButtonElement>('new-session')

const desktopView = element<HTMLDivElement>('desktop-view')
const canvas = element<HTMLCanvasElement>('output')
const overlay = element<HTMLDivElement>('overlay')
const overlayMessage = element<HTMLDivElement>('overlay-message')
const reconnectButton = element<HTMLButtonElement>('overlay-reconnect')
const overlaySessionsButton = element<HTMLButtonElement>('overlay-sessions')

element('sessions-hostname').textContent = element('hostname').textContent

const connection = new Connection()
const renderer = new Renderer(canvas, { preserveDrawingBuffer: testMode })
const desktop = new Desktop(canvas, renderer, connection)
const shell = new Shell(
  desktop,
  {
    send: (message) => connection.send(message),
    disconnect: () => showSessions(),
    logout: () => logout(),
  },
  element('taskbar'),
)

/** The renderer draws the desktop background: use the theme's color, also when the system switches light/dark. */
function applyDesktopColor() {
  renderer.setClearColor(getComputedStyle(desktopView).backgroundColor)
  desktop.scheduleRender()
}
applyDesktopColor()
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyDesktopColor)
let username = ''
let currentSession: string | undefined

function showError(target: HTMLElement, message: string | undefined) {
  target.textContent = message ?? ''
  target.hidden = message === undefined
}

function show(view: HTMLElement, title: string) {
  for (const candidate of [loginView, sessionsView, desktopView]) {
    candidate.hidden = candidate !== view
  }
  document.title = title
}

// --- signing in ---

function showLogin(message?: string) {
  shell.stop()
  connection.stop()
  desktop.clear()
  currentSession = undefined
  passwordInput.value = ''
  loginSubmit.disabled = false
  showError(loginError, message)
  show(loginView, 'Sign in')
  ;(usernameInput.value ? passwordInput : usernameInput).focus()
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  loginSubmit.disabled = true
  showError(loginError, undefined)
  try {
    const result = await login(usernameInput.value, passwordInput.value)
    if (!result.ok) {
      showLogin(result.error)
      return
    }
    username = result.username
    passwordInput.value = ''
    // still within the activation of the submit
    armHistoryGuard()
    await showSessions()
  } catch {
    showLogin('The server could not be reached.')
  }
})

setSignedOutHandler(() => showLogin())

// --- staying on the page ---
//
// Leaving the page signs out, so going back by accident (a mouse's back button, Alt+Left) would be costly. Three
// layers: the desktop gives those to the remote app (desktop.ts), a guard history entry absorbs a back navigation,
// and while signed in the browser asks before leaving.

const GUARD = 'session-guard'

function onGuardEntry(): boolean {
  return history.state?.[GUARD] === true
}

/**
 * Push the guard entry if we're not on it. Only during user activation: browsers skip entries added without it when
 * going back.
 */
function armHistoryGuard() {
  if (currentToken() !== undefined && !onGuardEntry()) {
    // same URL; pushing truncates any forward entries, so guard entries don't pile up
    history.pushState({ [GUARD]: true }, '')
  }
}

// back from the guard entry lands on the base entry of this same document: nothing to do but re-arm on the next input
window.addEventListener('pointerdown', armHistoryGuard, { capture: true })
window.addEventListener('keydown', armHistoryGuard, { capture: true })

window.addEventListener('beforeunload', (event) => {
  if (currentToken() !== undefined) {
    event.preventDefault()
    // older browsers need returnValue set
    event.returnValue = ''
  }
})

// Leaving the page locks it, also when the browser keeps it in its back/forward cache.
window.addEventListener('pagehide', () => {
  if (currentToken() !== undefined) {
    signOut()
    showLogin()
  }
})

window.addEventListener('unhandledrejection', (event) => {
  // the signed-out handler already showed the sign-in form
  if (event.reason instanceof SignedOut) {
    event.preventDefault()
  }
})

element('sign-out').addEventListener('click', () => {
  signOut()
  showLogin()
})

// --- session list ---

const sessionList = new SessionList(
  element('session-list'),
  element('no-sessions'),
  (message) => showError(sessionsError, message),
  (session) => openSession(session),
  async (session: SessionInfo) => {
    await api(`/api/sessions/${encodeURIComponent(session.id)}/end`, { method: 'POST' })
    await showSessions()
  },
)

async function showSessions(error?: string) {
  shell.stop()
  connection.stop()
  desktop.clear()
  currentSession = undefined
  const response = await api('/api/sessions')
  sessionList.render(await response.json())
  welcome.textContent = `Welcome, ${username}`
  showError(sessionsError, error)
  newSessionButton.disabled = false
  show(sessionsView, 'Sessions')
}

newSessionButton.addEventListener('click', async () => {
  newSessionButton.disabled = true
  const response = await api('/api/sessions', { method: 'POST' })
  if (!response.ok) {
    await showSessions('The session could not be started.')
    return
  }
  const session: SessionInfo = await response.json()
  openSession(session)
})

// --- desktop ---

function openSession(session: SessionInfo) {
  const token = currentToken()
  if (token === undefined) {
    showLogin()
    return
  }
  currentSession = session.id
  overlay.hidden = true
  overlaySessionsButton.hidden = true
  show(desktopView, session.name)
  shell.start(username, session)
  connection.attach(session.id, token)
  canvas.focus()
}

/** End the session and sign out. */
async function logout() {
  if (currentSession !== undefined) {
    await api(`/api/sessions/${encodeURIComponent(currentSession)}/end`, { method: 'POST' }).catch(() => undefined)
  }
  signOut()
  showLogin()
}

overlaySessionsButton.addEventListener('click', () => showSessions())

if (testMode) {
  // hooks for automated tests (see scripts/test-gateway.sh)
  ;(window as any).__viewerTest = {
    connected: () => connection.open,
    session: () => currentSession,
    token: () => currentToken(),
    windows: () => desktop.debugWindows(),
    output: () => desktop.debugOutput(),
    interaction: () => desktop.debugInteraction(),
    resizing: () => desktop.debugResizing(),
    animations: () => desktop.debugAnimations(),
    shellWindows: () => desktop.shellWindows(),
    readLuma: (x: number, y: number, width: number, height: number) => renderer.readLuma(x, y, width, height),
  }
}

connection.onOpen = () => desktop.reset()
connection.onEnvelope = (envelope) => {
  if (envelope.kind === 'control') {
    if (envelope.message.type.startsWith('shell.')) {
      shell.handleMessage(envelope.message)
    } else {
      desktop.handleMessage(envelope.message)
    }
  } else {
    desktop.handleFrame(envelope.surface, envelope.frame)
  }
}
connection.onStateChange = (state: ConnectionState) => {
  reconnectButton.hidden = true
  switch (state.kind) {
    case 'connecting':
      shell.setConnection('connecting')
      break
    case 'connected':
      shell.setConnection('connected')
      overlay.hidden = true
      break
    case 'reconnecting':
      shell.setConnection('reconnecting')
      overlayMessage.textContent = `Connection lost. Reconnecting in ${state.inSeconds}s…`
      overlay.hidden = false
      break
    case 'taken-over':
      shell.setConnection('offline')
      overlayMessage.textContent = 'This session was opened somewhere else.'
      reconnectButton.hidden = false
      overlaySessionsButton.hidden = false
      overlay.hidden = false
      break
    case 'ended':
      shell.setConnection('offline')
      overlayMessage.textContent = 'This session has ended.'
      overlaySessionsButton.hidden = false
      overlay.hidden = false
      break
    case 'signed-out':
      showLogin()
      break
  }
}
reconnectButton.addEventListener('click', () => connection.connect())
