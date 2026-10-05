import { useCallback, useEffect, useRef, useState } from 'react'
import { api, currentToken, login, setSignedOutHandler, SignedOut, signOut } from './auth'
import { Connection } from './connection'
import { Core } from './core'
import { Desktop } from './desktop'
import { SessionInfo } from './session-name'
import { AudioPlayer } from './audio/player'
import { ShellController } from './shell/shell'
import { AppsMenuActions } from './shell/apps-menu'
import { appForWindow, groupKey } from './shell/groups'
import { windowMenuItems } from './shell/menus'
import { openPopup } from './popups'
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
 * React renders the views and the shell; the connection and the window manager (desktop.ts, which owns the window
 * elements and their canvases) are imperative and mounted once behind the output ref.
 */
export function App({ hostname, testMode }: { hostname: string; testMode: boolean }) {
  const outputRef = useRef<HTMLDivElement>(null)
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

  // --- the imperative core, mounted once behind the output element ---

  useEffect(() => {
    const output = outputRef.current
    if (output === null) {
      throw new Error('BUG. The desktop views are not mounted.')
    }
    const connection = new Connection()
    const desktop = new Desktop(output, connection)
    const shell = new ShellController((message) => connection.send(message))
    const audio = new AudioPlayer((message) => connection.send(message))
    const stopAudioGestures = audio.install()
    const mounted: Core = { connection, desktop, shell, audio }
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

    /** A window's title bar shows its app's icon (the desktop entry's, else the window's own). */
    desktop.frameIcon = (window) => {
      const state = shellStore.get()
      const name = appForWindow(state.apps, window)?.icon
      if (name !== undefined) {
        shell.icons.want(name)
        const url = state.icons[name]
        if (typeof url === 'string') {
          return url
        }
      }
      return desktop.windowOwnIcon(window.id)
    }
    // the icons arrive after the windows
    let shownApps = shellStore.get().apps
    let shownIcons = shellStore.get().icons
    shellStore.subscribe(() => {
      const { apps, icons } = shellStore.get()
      if (apps !== shownApps || icons !== shownIcons) {
        shownApps = apps
        shownIcons = icons
        desktop.refreshFrames()
      }
    })
    /** Right click on a title bar: the window menu, as on the taskbar. */
    desktop.onWindowMenu = (window, at) => {
      openPopup({
        kind: 'context',
        owner: `frame:${window.id}`,
        items: windowMenuItems(window, desktop),
        x: at.x,
        y: at.y,
        nested: false,
      })
    }

    connection.onOpen = () => {
      desktop.reset()
      audio.onOpen()
    }
    connection.onEnvelope = (envelope, applied) => {
      if (envelope.kind === 'control') {
        if (envelope.message.type.startsWith('shell.')) {
          shell.handleMessage(envelope.message)
        } else if (envelope.message.type === 'audio.state') {
          audio.setAvailable(envelope.message.available)
        } else {
          desktop.handleMessage(envelope.message)
        }
      } else if (envelope.kind === 'audio') {
        audio.handlePacket(envelope)
      } else if (envelope.kind === 'frame') {
        desktop.handleFrame(envelope.surface, envelope.frame, applied)
      } else {
        desktop.handlePatch(envelope.surface, envelope.patch, applied)
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
        movesSent: () => desktop.debugMovesSent(),
        animations: () => desktop.debugAnimations(),
        videoFrames: () => desktop.debugVideoFrames(),
        patches: () => desktop.debugPatches(),
        delayScenes: (ms: number) => {
          desktop.debugSceneDelay = ms
        },
        shellWindows: () => desktop.shellWindows(),
        audio: () => audio.debug(),
        contentSize: (surface: string) => desktop.debugContentSize(surface),
        readLuma: (x: number, y: number, width: number, height: number) => desktop.debugReadLuma(x, y, width, height),
        surfacePixels: (surface: string, x: number, y: number, width: number, height: number) =>
          desktop.debugSurfacePixels(surface, x, y, width, height),
        // feeds a video frame (a FRAME envelope's payload, base64) to a surface as if the server had sent it
        injectFrame: (surface: string, base64: string) =>
          new Promise<void>((resolve) =>
            desktop.handleFrame(surface, Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)), resolve),
          ),
        // the same for a lossless patch: the PNG of the rectangle (base64) and the size of the whole surface
        injectPatch: (
          surface: string,
          surfaceSize: { width: number; height: number },
          rect: { x: number; y: number; width: number; height: number },
          png: string,
        ) =>
          new Promise<void>((resolve) =>
            desktop.handlePatch(
              surface,
              { contentSerial: 0, surfaceSize, rect, png: Uint8Array.from(atob(png), (c) => c.charCodeAt(0)) },
              resolve,
            ),
          ),
      }
    }

    return () => {
      stopAudioGestures()
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
        outputRef={outputRef}
        appsMenuActions={appsMenuActions}
        onReconnect={() => coreRef.current?.connection.connect()}
        onBackToSessions={() => {
          void showSessions()
        }}
      />
    </>
  )
}
