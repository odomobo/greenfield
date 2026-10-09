import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Connection, ConnectionEnd } from './connection'
import { Core } from './core'
import { Desktop } from './desktop'
import { PatchFormat } from './protocol'
import { AudioPlayer } from './audio/player'
import { ShellController } from './shell/shell'
import { AppsMenuActions } from './shell/apps-menu'
import { appForWindow, groupKey } from './shell/groups'
import { windowMenuItems } from './shell/menus'
import { openPopup } from './popups'
import { appStore, shellStore, signInTitle, userAtHost } from './state'
import { DesktopView } from './views/desktop'
import { LoginView } from './views/login'

// --- staying on the page ---
//
// Leaving the page signs out (its WebSocket is the sign-in), so going back by accident (a mouse's back button, Alt+Left) would be costly. Three
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
  if (signedIn() && !onGuardEntry()) {
    // same URL; pushing truncates any forward entries, so guard entries don't pile up
    history.pushState({ [GUARD]: true }, '')
  }
}

/** Signed in: the page's WebSocket is open to the desktop. */
function signedIn(): boolean {
  return appStore.get().connection.kind === 'connected'
}

/** What the sign-in form says after the connection to the desktop closed. */
function closedMessage(end: ConnectionEnd): string | undefined {
  switch (end.kind) {
    case 'taken-over':
      return `This desktop was opened somewhere else${end.ip ? ` (from ${end.ip})` : ''}.`
    case 'logged-out':
      return undefined
    case 'lost':
      return 'The connection to the desktop was lost.'
  }
}

/**
 * The whole app, served by the gateway at /: the sign-in form and the desktop. Signing in happens on the page's one
 * WebSocket and lasts as long as it is open (see connection.ts), so switching between them never leaves the page.
 * Signing in attaches to the user's desktop, starting it if it isn't running; there is one per user.
 *
 * React renders the views and the shell; the connection and the window manager (desktop.ts, which owns the window
 * elements and their canvases) are imperative and mounted once behind the output ref.
 */
export function App({ hostname, testMode }: { hostname: string; testMode: boolean }) {
  const outputRef = useRef<HTMLDivElement>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const coreRef = useRef<Core | null>(null)
  const [core, setCore] = useState<Core | null>(null)

  /** resolves the server's pending further prompt (see LoginView) */
  const answerRef = useRef<((answer: string) => void) | undefined>(undefined)

  const showLogin = useCallback((message?: string) => {
    const current = coreRef.current
    current?.shell.stop()
    current?.connection.stop()
    current?.desktop.clear()
    answerRef.current = undefined
    if (passwordRef.current !== null) {
      passwordRef.current.value = ''
    }
    appStore.update({
      view: 'login',
      loginError: message,
      loginInfo: undefined,
      loginPrompt: undefined,
      loginBusy: false,
      loginFocusNonce: appStore.get().loginFocusNonce + 1,
    })
    document.title = signInTitle(hostname)
  }, [])

  /** Log out: the desktop ends; the sign-in form shows once it did (the connection closes). */
  const logout = useCallback(() => {
    coreRef.current?.connection.logout()
  }, [])

  /** Disconnect: close the connection, the desktop keeps running (signing in again reattaches). */
  const disconnect = useCallback(() => showLogin(), [showLogin])

  /** Sign in on a new WebSocket; on success it is connected to the user's desktop (started if it wasn't running). */
  const handleLogin = useCallback(
    async (username: string, password: string) => {
      const current = coreRef.current
      if (current === null) {
        return
      }
      appStore.update({ loginBusy: true, loginError: undefined, loginInfo: undefined, loginPrompt: undefined })
      let passwordUsed = false
      const result = await current.connection.signIn(username, {
        prompt: (text, echo) => {
          // the form's password answers the first hidden prompt
          if (!echo && !passwordUsed) {
            passwordUsed = true
            return Promise.resolve(password)
          }
          return new Promise((resolve) => {
            answerRef.current = resolve
            appStore.update({ loginPrompt: { text, echo }, loginBusy: false })
          })
        },
        // PAM's messages are about the prompt that follows them (e.g. "You are required to change your password",
        // "Sorry, passwords do not match."): shown together until that prompt is answered
        message: (kind, text) => {
          const { loginInfo, loginError } = appStore.get()
          const add = (shown: string | undefined) => (shown === undefined ? text : `${shown}\n${text}`)
          appStore.update(kind === 'info' ? { loginInfo: add(loginInfo) } : { loginError: add(loginError) })
        },
      })
      if (!result.ok) {
        // (an empty message: stopped on purpose, e.g. the page is going away)
        showLogin(result.message || undefined)
        return
      }
      // the desktop shows already (connection.onOpen); still within the activation of the submit
      armHistoryGuard()
      current.desktop.focus()
    },
    [showLogin],
  )

  const handleAnswer = useCallback((answer: string) => {
    const resolve = answerRef.current
    answerRef.current = undefined
    appStore.update({ loginPrompt: undefined, loginBusy: true, loginInfo: undefined, loginError: undefined })
    resolve?.(answer)
  }, [])

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

    connection.onOpen = (username) => {
      // signed in: show the desktop right away, its output is measured for the session's hello (desktop.reset)
      flushSync(() =>
        appStore.update({ view: 'desktop', loginPrompt: undefined, loginInfo: undefined, loginBusy: false }),
      )
      document.title = userAtHost(username, hostname)
      shell.start(username, hostname)
      desktop.reset()
      audio.onOpen()
    }
    connection.onClosed = (end) => showLogin(closedMessage(end))
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
    connection.onStateChange = (state) => appStore.update({ connection: state })

    const onUserInput = () => armHistoryGuard()
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (signedIn()) {
        event.preventDefault()
        // older browsers need returnValue set
        event.returnValue = ''
      }
    }
    // Leaving the page locks it, also when the browser keeps it in its back/forward cache.
    const onPageHide = () => {
      if (appStore.get().connection.kind !== 'closed') {
        showLogin()
      }
    }
    window.addEventListener('pointerdown', onUserInput, { capture: true })
    window.addEventListener('keydown', onUserInput, { capture: true })
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onPageHide)

    if (testMode) {
      // hooks for automated tests (see scripts/test-gateway.sh)
      ;(window as unknown as Record<string, unknown>).__viewerTest = {
        connected: () => connection.open,
        windows: () => desktop.debugWindows(),
        output: () => desktop.debugOutput(),
        interaction: () => desktop.debugInteraction(),
        menuArmed: () => desktop.debugMenuArmed(),
        drag: () => desktop.debugDrag(),
        resizing: () => desktop.debugResizing(),
        resizesSent: () => desktop.debugResizesSent(),
        movesSent: () => desktop.debugMovesSent(),
        animations: () => desktop.debugAnimations(),
        surfaces: () => desktop.debugSurfaces(),
        videoFrames: () => desktop.debugVideoFrames(),
        patches: () => desktop.debugPatches(),
        patchKinds: () => desktop.debugPatchKinds(),
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
            desktop.handleFrame(
              surface,
              Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
              resolve,
            ),
          ),
        // the same for a patch: the pixels of the rectangle (base64; by default raw RGBA, a RAW patch: it goes through
        // the patch decoder worker like any other) and the size of the whole surface
        injectPatch: (
          surface: string,
          surfaceSize: { width: number; height: number },
          rect: { x: number; y: number; width: number; height: number },
          data: string,
          format: PatchFormat = PatchFormat.RAW,
          channels: 3 | 4 = 4,
        ) =>
          new Promise<void>((resolve) =>
            desktop.handlePatch(
              surface,
              {
                contentSerial: 0,
                surfaceSize,
                rect,
                format,
                channels,
                data: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
              },
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
    }
  }, [showLogin, testMode])

  const appsMenuActions: AppsMenuActions = {
    launch: (app) => coreRef.current?.shell.launch(app),
    togglePin: (app) => coreRef.current?.shell.togglePin(app),
    isPinned: (app) => shellStore.get().pinned.includes(app),
    disconnect,
    logout,
  }

  return (
    <>
      <LoginView
        hostname={hostname}
        onSubmit={(username, password) => void handleLogin(username, password)}
        onAnswer={handleAnswer}
        usernameRef={usernameRef}
        passwordRef={passwordRef}
      />
      <DesktopView core={core} outputRef={outputRef} appsMenuActions={appsMenuActions} />
    </>
  )
}
