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
 * ?server=host:port (default: same host, port 8081) &session=name (default: "default")
 */
const params = new URLSearchParams(location.search)
const server = params.get('server') ?? `${location.hostname}:8081`
const session = params.get('session') ?? 'default'
const secure = params.get('secure') === '1' || location.protocol === 'https:'
const httpBase = `${secure ? 'https' : 'http'}://${server}`
const viewerURL = `${secure ? 'wss' : 'ws'}://${server}/viewer?session=${encodeURIComponent(session)}`

const canvas = element<HTMLCanvasElement>('output')
const status = element<HTMLDivElement>('status')
const overlay = element<HTMLDivElement>('overlay')
const overlayMessage = element<HTMLDivElement>('overlay-message')
const reconnectButton = element<HTMLButtonElement>('overlay-reconnect')

const testMode = params.get('test') === '1'
const connection = new Connection(viewerURL)
const renderer = new Renderer(canvas, { preserveDrawingBuffer: testMode })
const desktop = new Desktop(canvas, renderer, connection)

if (testMode) {
  // hooks for automated tests (see scripts/test-reattach.sh)
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
      status.textContent = `${session} · connecting…`
      break
    case 'connected':
      status.textContent = `${session} · connected`
      overlay.hidden = true
      break
    case 'reconnecting':
      status.textContent = `${session} · disconnected`
      overlayMessage.textContent = `Connection lost. Reconnecting in ${state.inSeconds}s…`
      overlay.hidden = false
      break
    case 'taken-over':
      status.textContent = `${session} · taken over`
      overlayMessage.textContent = 'This session was opened somewhere else.'
      reconnectButton.hidden = false
      overlay.hidden = false
      break
  }
}
reconnectButton.addEventListener('click', () => connection.connect())

async function loadApps() {
  const apps = element<HTMLDivElement>('apps')
  try {
    const response = await fetch(`${httpBase}/apps`, { credentials: 'include' })
    const list: { path: string; name: string }[] = await response.json()
    apps.replaceChildren(
      ...list.map(({ path, name }) => {
        const button = document.createElement('button')
        button.textContent = name
        button.dataset.app = path
        button.addEventListener('click', async () => {
          const url = `${httpBase}/launch?session=${encodeURIComponent(session)}&app=${encodeURIComponent(path)}`
          const result = await fetch(url, { credentials: 'include' })
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

loadApps()
connection.connect()
