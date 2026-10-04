import { useCallback, useEffect, useRef, useState } from 'react'
import { api, currentToken, login, setSignedOutHandler, SignedOut, signOut } from './auth'
import { Connection } from './connection'
import { Core } from './core'
import { Desktop } from './desktop'
import { Renderer } from './gl/renderer'
import { SessionInfo } from './session-name'
import { ShellController } from './shell/shell'
import { AppsMenuActions } from './shell/apps-menu'
import { groupKey } from './shell/groups'
import { appStore, shellStore } from './state'
import { DesktopView } from './views/desktop'
import { LoginView } from './views/login'
import { SessionsView } from './views/sessions'

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

/**
 * The whole app, served by the gateway at /: the sign-in form, the session list and the desktop. Signing in lasts
 * as long as this page (see auth.ts), so switching between them never leaves the page.
 *
 * React renders the views and the shell; the connection, the renderer and the window manager (desktop.ts) are
 * imperative and mounted once behind the canvas ref.
 */
export function App({ hostname, testMode }: { hostname: string; testMode: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const desktopViewRef = useRef<HTMLDivElement>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const coreRef = useRef<Core | null>(null)
  const userRef = useRef('')
  /** the session shown on the desktop, for the test hooks and Log out */
  const sessionRef = useRef<string | undefined>(undefined)
  const [core, setCore] = useState<Core | null>(null)

  const showLogin = useCallback((message?: string) => {
    const current = coreRef.current
    current?.shell.stop()
    current?.connection.stop()
    current?.desktop.clear()
    sessionRef.current = undefined
    if (passwordRef.current !== null) {
      passwordRef.current.value = ''
    }
    appStore.update({
      view: 'login',
      loginError: message,
      loginBusy: false,
      loginFocusNonce: appStore.get().loginFocusNonce + 1,
    })
    document.title = 'Sign in'
  }, [])

  const showSessions = useCallback(async (error?: string) => {
    const current = coreRef.current
    current?.shell.stop()
    current?.connection.stop()
    current?.desktop.clear()
    sessionRef.current = undefined
    const response = await api('/api/sessions')
    const sessions: SessionInfo[] = await response.json()
    appStore.update({
      sessions,
      sessionsError: error,
      creatingSession: false,
      username: userRef.current,
      view: 'sessions',
    })
    document.title = 'Sessions'
  }, [])

  const openSession = useCallback(
    (session: SessionInfo) => {
      const current = coreRef.current
      const token = currentToken()
      if (current === null || token === undefined) {
        showLogin()
        return
      }
      sessionRef.current = session.id
      appStore.update({ session, connection: { kind: 'connecting' }, view: 'desktop' })
      document.title = session.name
      current.shell.start(userRef.current, session)
      current.connection.attach(session.id, token)
      current.desktop.focus()
    },
    [showLogin],
  )

  /** End the session and sign out. */
  const logout = useCallback(async () => {
    const current = sessionRef.current
    if (current !== undefined) {
      await api(`/api/sessions/${encodeURIComponent(current)}/end`, { method: 'POST' }).catch(() => undefined)
    }
    signOut()
    showLogin()
  }, [showLogin])

  const handleLogin = useCallback(
    async (username: string, password: string) => {
      appStore.update({ loginBusy: true, loginError: undefined })
      try {
        const result = await login(username, password)
        if (!result.ok) {
          showLogin(result.error)
          return
        }
        userRef.current = result.username
        // still within the activation of the submit
        armHistoryGuard()
        await showSessions()
      } catch {
        showLogin('The server could not be reached.')
      }
    },
    [showLogin, showSessions],
  )

  const newSession = useCallback(async () => {
    appStore.update({ creatingSession: true })
    const response = await api('/api/sessions', { method: 'POST' })
    if (!response.ok) {
      await showSessions('The session could not be started.')
      return
    }
    const session: SessionInfo = await response.json()
    openSession(session)
  }, [showSessions, openSession])

  // --- the imperative core, mounted once behind the canvas ---

  useEffect(() => {
    const canvas = canvasRef.current
    const desktopView = desktopViewRef.current
    if (canvas === null || desktopView === null) {
      throw new Error('BUG. The desktop views are not mounted.')
    }
    const connection = new Connection()
    const renderer = new Renderer(canvas, { preserveDrawingBuffer: testMode })
    const desktop = new Desktop(canvas, renderer, connection)
    const shell = new ShellController((message) => connection.send(message))
    const mounted: Core = { connection, renderer, desktop, shell }
    coreRef.current = mounted
    setCore(mounted)

    desktop.onWindowsChanged = (windows) => shellStore.update({ windows })
    /** Where a window goes when minimized (its taskbar button), in page coordinates. */
    desktop.minimizeTarget = (id) => {
      const state = shellStore.get()
      const window = state.windows.find((w) => w.id === id)
      if (window === undefined) {
        return undefined
      }
      const selector = `#taskbar-items button[data-group="${CSS.escape(groupKey(state.apps, window))}"]`
      return document.querySelector(selector)?.getBoundingClientRect()
    }

    connection.onOpen = () => desktop.reset()
    connection.onEnvelope = (envelope) => {
      if (envelope.kind === 'control') {
        if (envelope.message.type.startsWith('shell.')) {
          shell.handleMessage(envelope.message)
        } else {
          desktop.handleMessage(envelope.message)
        }
      } else if (envelope.kind === 'frame') {
        desktop.handleFrame(envelope.surface, envelope.frame)
      } else {
        desktop.handlePatch(envelope.surface, envelope.patch)
      }
    }
    connection.onStateChange = (state) => {
      switch (state.kind) {
        case 'connecting':
          shell.setConnection('connecting')
          break
        case 'connected':
          shell.setConnection('connected')
          break
        case 'reconnecting':
          shell.setConnection('reconnecting')
          break
        case 'taken-over':
        case 'ended':
          shell.setConnection('offline')
          break
        case 'signed-out':
          break
      }
      appStore.update({ connection: state })
      if (state.kind === 'signed-out') {
        showLogin()
      }
    }

    setSignedOutHandler(() => showLogin())

    /** The renderer draws the desktop background: use the theme's color, also when the system switches light/dark. */
    const applyDesktopColor = () => {
      renderer.setClearColor(getComputedStyle(desktopView).backgroundColor)
      desktop.scheduleRender()
    }
    applyDesktopColor()
    const darkTheme = matchMedia('(prefers-color-scheme: dark)')
    darkTheme.addEventListener('change', applyDesktopColor)

    const onUserInput = () => armHistoryGuard()
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (currentToken() !== undefined) {
        event.preventDefault()
        // older browsers need returnValue set
        event.returnValue = ''
      }
    }
    // Leaving the page locks it, also when the browser keeps it in its back/forward cache.
    const onPageHide = () => {
      if (currentToken() !== undefined) {
        signOut()
        showLogin()
      }
    }
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      // the signed-out handler already showed the sign-in form
      if (event.reason instanceof SignedOut) {
        event.preventDefault()
      }
    }
    window.addEventListener('pointerdown', onUserInput, { capture: true })
    window.addEventListener('keydown', onUserInput, { capture: true })
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('unhandledrejection', onUnhandledRejection)

    if (testMode) {
      // hooks for automated tests (see scripts/test-gateway.sh)
      ;(window as unknown as Record<string, unknown>).__viewerTest = {
        connected: () => connection.open,
        session: () => sessionRef.current,
        token: () => currentToken(),
        windows: () => desktop.debugWindows(),
        output: () => desktop.debugOutput(),
        interaction: () => desktop.debugInteraction(),
        drag: () => desktop.debugDrag(),
        resizing: () => desktop.debugResizing(),
        resizesSent: () => desktop.debugResizesSent(),
        animations: () => desktop.debugAnimations(),
        videoFrames: () => desktop.debugVideoFrames(),
        delayScenes: (ms: number) => {
          desktop.debugSceneDelay = ms
        },
        shellWindows: () => desktop.shellWindows(),
        contentSize: (surface: string) => renderer.contentSize(surface),
        readLuma: (x: number, y: number, width: number, height: number) => renderer.readLuma(x, y, width, height),
      }
    }

    return () => {
      darkTheme.removeEventListener('change', applyDesktopColor)
      window.removeEventListener('pointerdown', onUserInput, { capture: true })
      window.removeEventListener('keydown', onUserInput, { capture: true })
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
    }
  }, [showLogin, testMode])

  const endSession = useCallback(
    async (session: SessionInfo) => {
      await api(`/api/sessions/${encodeURIComponent(session.id)}/end`, { method: 'POST' })
      await showSessions()
    },
    [showSessions],
  )

  const appsMenuActions: AppsMenuActions = {
    launch: (app) => coreRef.current?.shell.launch(app),
    togglePin: (app) => coreRef.current?.shell.togglePin(app),
    isPinned: (app) => shellStore.get().pinned.includes(app),
    disconnect: () => {
      void showSessions()
    },
    logout: () => {
      void logout()
    },
  }

  return (
    <>
      <LoginView
        hostname={hostname}
        onSubmit={handleLogin}
        usernameRef={usernameRef}
        passwordRef={passwordRef}
      />
      <SessionsView
        hostname={hostname}
        onOpen={openSession}
        onEnd={endSession}
        onNewSession={() => {
          void newSession()
        }}
        onSignOut={() => {
          signOut()
          showLogin()
        }}
      />
      <DesktopView
        core={core}
        canvasRef={canvasRef}
        viewRef={desktopViewRef}
        appsMenuActions={appsMenuActions}
        onReconnect={() => coreRef.current?.connection.connect()}
        onBackToSessions={() => {
          void showSessions()
        }}
      />
    </>
  )
}
