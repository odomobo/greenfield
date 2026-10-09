import { ShellWindow } from './desktop'
import { ConnectionState } from './connection'
import { ShellApp, ShellNotification, ShellTrayItem } from './protocol'
import { createStore } from './store'

/** The views of the app, one shown at a time (see app.tsx). */
export type ViewName = 'login' | 'desktop'

/**
 * The state of the two views: which one is shown and the sign-in form. Signing in lasts only as long as the page's
 * WebSocket, so views switch without leaving it. Owned by app.tsx.
 */
export type AppState = {
  view: ViewName
  /** shown above the form: why it's shown (a failed sign-in, a lost connection, ...) or the server's error message */
  loginError: string | undefined
  /** an info message of the server's during the sign-in */
  loginInfo: string | undefined
  /** a further question of the server's during the sign-in (the password is answered from the form) */
  loginPrompt: { text: string; echo: boolean } | undefined
  /** the submit button is disabled while signing in */
  loginBusy: boolean
  /** bumped by every showLogin, so the sign-in form re-applies its focus rule (see LoginView) */
  loginFocusNonce: number
  username: string
  connection: ConnectionState
}

export const appStore = createStore<AppState>({
  view: 'login',
  loginError: undefined,
  loginInfo: undefined,
  loginPrompt: undefined,
  loginBusy: false,
  loginFocusNonce: 0,
  username: '',
  connection: { kind: 'closed' },
})

/**
 * The state the desktop shell renders: the session's apps, pinned apps and windows, the connection indicator,
 * notifications (with their toasts), app icons and the system tray. Published by the shell controller (shell/shell.ts) and the
 * Desktop (window lists).
 */
export type ShellState = {
  username: string
  /** the machine the desktop runs on (shown as user@hostname) */
  hostname: string
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
  /** the system tray's items, in the order they came (passive ones too: the taskbar hides them) */
  tray: ShellTrayItem[]
  /** the session host's clock (see shell/clock.ts); undefined until it's sent */
  clock: HostClock | undefined
}

/** The host's clock: how far ahead of the browser's it is (ms), and the host's time zone. */
export type HostClock = { offset: number; timeZone: string }

export const shellStore = createStore<ShellState>({
  username: '',
  hostname: '',
  apps: [],
  pinned: [],
  windows: [],
  notifications: [],
  unseen: false,
  toasts: [],
  icons: {},
  tray: [],
  clock: undefined,
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

/** Who is signed in where: "user@hostname" (the tab's title and the Apps menu's header on the desktop). */
export function userAtHost(username: string, hostname: string): string {
  // (a gateway that hides its host name puts a non-breaking space there, which trim() removes)
  const host = hostname.trim()
  return host ? `${username}@${host}` : username
}
