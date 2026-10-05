import { SessionInfo } from './session-name'
import { ShellWindow } from './desktop'
import { ConnectionState } from './connection'
import { ShellApp, ShellNotification } from './protocol'
import { createStore } from './store'

/** The views of the app, one shown at a time (see app.tsx). */
export type ViewName = 'login' | 'sessions' | 'desktop'

/**
 * The state of the three views: which one is shown, the sign-in form and the session list. Signing in lasts only for
 * the open page, so views switch without leaving it. Owned by app.tsx.
 */
export type AppState = {
  view: ViewName
  loginError: string | undefined
  /** the submit button is disabled while signing in */
  loginBusy: boolean
  /** bumped by every showLogin, so the sign-in form re-applies its focus rule (see LoginView) */
  loginFocusNonce: number
  username: string
  sessions: SessionInfo[]
  sessionsError: string | undefined
  /** the "Start new session" button is disabled while a session is being started */
  creatingSession: boolean
  /** the session shown on the desktop */
  session: SessionInfo | undefined
  connection: ConnectionState
}

export const appStore = createStore<AppState>({
  view: 'login',
  loginError: undefined,
  loginBusy: false,
  loginFocusNonce: 0,
  username: '',
  sessions: [],
  sessionsError: undefined,
  creatingSession: false,
  session: undefined,
  connection: { kind: 'connecting' },
})

/**
 * The state the desktop shell renders: the session's apps, pinned apps and windows, the connection indicator,
 * notifications (with their toasts) and app icons. Published by the shell controller (shell/shell.ts) and the
 * Desktop (window lists).
 */
export type ShellState = {
  username: string
  session: SessionInfo | undefined
  apps: ShellApp[]
  /** desktop file IDs of the pinned apps, in order */
  pinned: string[]
  /** the windows as shown, published by the Desktop */
  windows: ShellWindow[]
  notifications: ShellNotification[]
  /** the bell shows a dot until the panel was opened */
  unseen: boolean
  /** the toasts currently shown, newest first */
  toasts: ShellNotification[]
  /** data URLs for icon names (null: no such icon; missing: not requested/arrived yet) */
  icons: Record<string, string | null>
}

export const shellStore = createStore<ShellState>({
  username: '',
  session: undefined,
  apps: [],
  pinned: [],
  windows: [],
  notifications: [],
  unseen: false,
  toasts: [],
  icons: {},
})

/** The session's audio as the taskbar's mute toggle shows it. Published by the AudioPlayer (audio/player.ts). */
export type AudioState = {
  /** the user muted audio on this viewer (remembered per browser) */
  muted: boolean
  /** the session has audio (its PipeWire runs) */
  available: boolean
  /** this browser can play it (WebCodecs, AudioWorklet) */
  supported: boolean
  /** the audio context runs: browsers start it only after the first user input */
  running: boolean
}

export const audioStore = createStore<AudioState>({ muted: false, available: false, supported: true, running: false })
