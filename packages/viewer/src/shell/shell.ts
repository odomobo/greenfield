import { shellStore } from '../state'
import { ServerMessage, ShellNotification, ViewerMessage } from '../protocol'
import { closePopup, isKindOpen, openPopup } from '../popups'
import { appById, resetGroupOrder } from './groups'
import { IconCache } from './icons'
import { TrayController } from './tray'


const TOAST_MS = 6000
const MAX_TOASTS = 3

/**
 * The desktop shell's controller, the imperative side of the shell: it receives the session's shell.* messages and
 * publishes their state into the shell store, sends the shell's own messages to the session, and keeps the toast
 * timers. What the user sees (taskbar, Apps menu, previews, notifications, menus) is rendered by React from the
 * store (shell/*.tsx). The system tray's part is the TrayController (shell/tray.ts).
 */
export class ShellController {
  readonly icons: IconCache
  readonly tray: TrayController
  /** IDs for the shell's own notifications (not kept by the session, which uses positive IDs) */
  private localId = -1
  /** hide-timers of the shown toasts, by notification ID */
  private readonly toastTimers = new Map<number, number>()

  constructor(private readonly send: (message: ViewerMessage) => void) {
    this.icons = new IconCache((names) => this.send({ type: 'shell.icons', names }))
    this.tray = new TrayController(send)
  }

  /** The desktop was opened: show its user, start empty until the session sends its state. */
  start(username: string): void {
    this.icons.clear()
    this.clearToastTimers()
    resetGroupOrder()
    closePopup()
    this.tray.reset()
    shellStore.update({
      username,
      apps: [],
      pinned: [],
      windows: [],
      notifications: [],
      unseen: false,
      toasts: [],
    })
  }

  /** Left the desktop: put popups and toasts away. */
  stop(): void {
    closePopup()
    this.tray.reset()
    this.clearToastTimers()
    shellStore.update({ notifications: [], unseen: false, toasts: [] })
  }

  handleMessage(message: ServerMessage): void {
    if (this.tray.handleMessage(message)) {
      return
    }
    switch (message.type) {
      case 'shell.apps':
        shellStore.update({ apps: message.apps })
        break
      case 'shell.pinned':
        shellStore.update({ pinned: message.apps })
        break
      case 'shell.icons':
        this.icons.received(message.icons)
        break
      case 'shell.notifications':
        this.setAll(message.notifications)
        break
      case 'shell.notification':
        this.add(message.notification)
        break
      case 'shell.notification-closed':
        this.remove(message.id)
        break
      case 'shell.launch-failed': {
        const app = appById(shellStore.get().apps, message.app)
        this.local(`${app?.name ?? 'The app'} could not be started.`)
        break
      }
    }
  }

  launch(app: string): void {
    this.send({ type: 'shell.launch', app })
    // apps take a moment; the window shows up in the taskbar when it maps
  }

  togglePin(app: string): void {
    const pinned = shellStore.get().pinned
    const updated = pinned.includes(app) ? pinned.filter((id) => id !== app) : [...pinned, app]
    // shown right away, the session confirms with shell.pinned
    shellStore.update({ pinned: updated })
    this.send({ type: 'shell.pin', apps: updated })
  }

  /** Installed apps may have changed (the session rate-limits re-reading them). */
  refreshApps(): void {
    this.send({ type: 'shell.refresh-apps' })
  }

  // -----------------------------------------------------------------------------------------------------------------
  // notifications (the panel and the toasts)

  /** The session's notifications after attaching. Not toasted: they're not new. */
  setAll(notifications: ShellNotification[]): void {
    shellStore.update({
      notifications: [...notifications],
      unseen: notifications.length > 0 && !isKindOpen('notifications'),
    })
  }

  /** A new notification, or one replacing the notification with the same id. Shows as a toast. */
  add(notification: ShellNotification): void {
    const notifications = shellStore.get().notifications.filter((n) => n.id !== notification.id)
    notifications.push(notification)
    shellStore.update({
      notifications,
      unseen: isKindOpen('notifications') ? shellStore.get().unseen : true,
    })
    this.toast(notification)
  }

  remove(id: number): void {
    this.hideToast(id)
    shellStore.update({ notifications: shellStore.get().notifications.filter((n) => n.id !== id) })
  }

  /** A message from the shell itself (not kept by the session). */
  local(summary: string): void {
    this.add({
      id: this.localId--,
      appName: '',
      summary,
      body: '',
      urgency: 'normal',
      expireTimeout: -1,
      time: Date.now(),
    })
  }

  /** Dismissing removes the notification here and in the session (local ones only here). */
  dismiss(id: number): void {
    if (id >= 0) {
      this.send({ type: 'shell.notification-dismiss', id })
    }
    this.remove(id)
  }

  clearAll(): void {
    this.send({ type: 'shell.notifications-clear' })
    this.clearToastTimers()
    shellStore.update({ toasts: [], notifications: [], unseen: false })
  }

  /** The bell was clicked: the panel shows everything, so nothing is unseen and no toasts are needed. */
  openPanel(): void {
    this.clearToastTimers()
    shellStore.update({ unseen: false, toasts: [] })
    openPopup({ kind: 'notifications', owner: 'notifications-button' })
  }

  /** A toast was clicked or expired: put it away (it stays in the history). */
  hideToast(id: number): void {
    clearTimeout(this.toastTimers.get(id))
    this.toastTimers.delete(id)
    const toasts = shellStore.get().toasts
    if (toasts.some((n) => n.id === id)) {
      shellStore.update({ toasts: toasts.filter((n) => n.id !== id) })
    }
  }

  private toast(notification: ShellNotification): void {
    this.hideToast(notification.id)
    const toasts = [notification, ...shellStore.get().toasts]
    while (toasts.length > MAX_TOASTS) {
      const last = toasts.pop()!
      this.hideToast(last.id)
    }
    shellStore.update({ toasts })
    const timeout =
      notification.urgency === 'critical' || notification.expireTimeout === 0
        ? undefined
        : notification.expireTimeout > 0
          ? Math.min(notification.expireTimeout, 60_000)
          : TOAST_MS
    if (timeout !== undefined) {
      this.toastTimers.set(
        notification.id,
        window.setTimeout(() => this.hideToast(notification.id), timeout),
      )
    }
  }

  private clearToastTimers(): void {
    for (const timer of this.toastTimers.values()) {
      clearTimeout(timer)
    }
    this.toastTimers.clear()
  }
}
