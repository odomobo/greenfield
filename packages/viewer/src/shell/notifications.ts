import { ShellNotification, ViewerMessage } from '../protocol'
import { glyphs } from './glyphs'
import { closePopup, isOpen, openPopup } from './menu'
import type { ConnectionIndicator, Shell } from './shell'

const TOAST_MS = 6000
const MAX_TOASTS = 3

/**
 * The right side of the taskbar and what belongs to it: the connection indicator, the clock with the notification
 * bell (opens the notification history), and toasts for new notifications, top right below the taskbar.
 * Notifications are kept by the session; dismissing one here removes it there.
 */
export class Notifications {
  private notifications: ShellNotification[] = []
  private unseen = false
  private readonly connection: HTMLElement
  private readonly button: HTMLButtonElement
  private readonly clock: HTMLElement
  private readonly panel: HTMLElement
  private readonly panelList: HTMLElement
  private readonly panelEmpty: HTMLElement
  private readonly toasts: HTMLElement
  private readonly toastTimers = new Map<number, number>()
  private localId = -1

  constructor(
    private readonly shell: Shell,
    tray: HTMLElement,
    private readonly send: (message: ViewerMessage) => void,
  ) {
    this.connection = document.createElement('span')
    this.connection.id = 'connection-indicator'
    this.connection.className = 'tray-item'
    this.connection.setAttribute('role', 'status')

    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.id = 'notifications-button'
    this.button.className = 'taskbar-button tray-clock'
    this.button.setAttribute('aria-haspopup', 'dialog')
    const bell = document.createElement('span')
    bell.className = 'bell'
    bell.innerHTML = glyphs.bell()
    this.clock = document.createElement('span')
    this.clock.className = 'clock'
    this.button.append(bell, this.clock)
    this.button.addEventListener('click', () => (isOpen(this.panel) ? closePopup() : this.openPanel()))
    tray.append(this.connection, this.button)

    this.panel = document.createElement('div')
    this.panel.id = 'notifications-panel'
    this.panel.className = 'flyout'
    this.panel.hidden = true
    this.panel.setAttribute('role', 'dialog')
    this.panel.setAttribute('aria-label', 'Notifications')
    const header = document.createElement('div')
    header.className = 'panel-header'
    const title = document.createElement('h2')
    title.textContent = 'Notifications'
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'link-button'
    clear.id = 'notifications-clear'
    clear.textContent = 'Clear all'
    clear.addEventListener('click', () => {
      this.send({ type: 'shell.notifications-clear' })
      for (const { id } of this.notifications) {
        this.hideToast(id)
      }
      this.setAll([])
    })
    header.append(title, clear)
    this.panelList = document.createElement('div')
    this.panelList.className = 'panel-list'
    this.panelEmpty = document.createElement('p')
    this.panelEmpty.className = 'panel-empty'
    this.panelEmpty.textContent = 'No new notifications'
    this.panel.append(header, this.panelList, this.panelEmpty)
    document.body.append(this.panel)

    this.toasts = document.createElement('div')
    this.toasts.id = 'toasts'
    this.toasts.setAttribute('aria-live', 'polite')
    document.body.append(this.toasts)

    this.updateClock()
    this.setConnection('connecting')
  }

  reset(): void {
    this.notifications = []
    this.unseen = false
    for (const timer of this.toastTimers.values()) {
      clearTimeout(timer)
    }
    this.toastTimers.clear()
    this.toasts.replaceChildren()
    this.render()
  }

  setConnection(state: ConnectionIndicator): void {
    const labels: Record<ConnectionIndicator, string> = {
      connecting: 'Connecting…',
      connected: 'Connected',
      reconnecting: 'Connection lost, reconnecting…',
      offline: 'Not connected',
    }
    this.connection.dataset.state = state
    this.connection.title = labels[state]
    this.connection.setAttribute('aria-label', labels[state])
    this.connection.innerHTML = state === 'connected' || state === 'connecting' ? glyphs.signal() : glyphs.signalOff()
  }

  /** The session's notifications after attaching. Not toasted: they're not new. */
  setAll(notifications: ShellNotification[]): void {
    this.notifications = [...notifications]
    this.unseen = this.notifications.length > 0 && !isOpen(this.panel)
    this.render()
  }

  add(notification: ShellNotification): void {
    this.notifications = this.notifications.filter((n) => n.id !== notification.id)
    this.notifications.push(notification)
    if (!isOpen(this.panel)) {
      this.unseen = true
    }
    this.render()
    this.toast(notification)
  }

  remove(id: number): void {
    this.notifications = this.notifications.filter((n) => n.id !== id)
    this.hideToast(id)
    this.render()
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

  private dismiss(id: number) {
    if (id >= 0) {
      this.send({ type: 'shell.notification-dismiss', id })
    }
    this.remove(id)
  }

  private openPanel() {
    this.unseen = false
    // the panel shows them all
    for (const id of [...this.toastTimers.keys()]) {
      this.hideToast(id)
    }
    this.toasts.replaceChildren()
    this.render()
    openPopup(this.panel, this.button, () => this.shell.focusDesktop())
  }

  private render() {
    this.button.classList.toggle('unseen', this.unseen)
    const count = this.notifications.length
    this.button.setAttribute('aria-label', count ? `Notifications (${count})` : 'Notifications')
    this.panelList.replaceChildren(...[...this.notifications].reverse().map((n) => this.card(n, 'panel')))
    this.panelEmpty.hidden = count > 0
  }

  private card(notification: ShellNotification, where: 'panel' | 'toast'): HTMLElement {
    const card = document.createElement('div')
    card.className = where === 'toast' ? 'toast' : 'notification'
    card.dataset.notification = String(notification.id)
    card.classList.toggle('critical', notification.urgency === 'critical')
    const app = this.shell.appById(notification.desktopEntry ? `${notification.desktopEntry}.desktop` : undefined)
    const iconName = notification.icon ?? app?.icon
    const icon = this.shell.icons.element(iconName, 24)
    const text = document.createElement('div')
    text.className = 'notification-text'
    const meta = document.createElement('div')
    meta.className = 'notification-meta'
    meta.textContent = [notification.appName || app?.name, formatTime(notification.time)].filter(Boolean).join(' · ')
    const summary = document.createElement('div')
    summary.className = 'notification-summary'
    summary.textContent = notification.summary
    text.append(meta, summary)
    if (notification.body) {
      const body = document.createElement('div')
      body.className = 'notification-body'
      body.textContent = notification.body
      text.append(body)
    }
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'icon-button notification-close'
    close.title = 'Dismiss'
    close.setAttribute('aria-label', 'Dismiss')
    close.innerHTML = glyphs.close(12)
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      this.dismiss(notification.id)
    })
    card.append(icon, text, close)
    if (where === 'toast') {
      // clicking a toast puts it away (it stays in the history)
      card.addEventListener('click', () => this.hideToast(notification.id))
    }
    return card
  }

  private toast(notification: ShellNotification) {
    this.hideToast(notification.id)
    const toast = this.card(notification, 'toast')
    this.toasts.prepend(toast)
    while (this.toasts.children.length > MAX_TOASTS) {
      const last = this.toasts.lastElementChild as HTMLElement
      this.hideToast(Number(last.dataset.notification))
    }
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

  private hideToast(id: number) {
    clearTimeout(this.toastTimers.get(id))
    this.toastTimers.delete(id)
    this.toasts.querySelector(`[data-notification="${id}"]`)?.remove()
  }

  private updateClock() {
    const now = new Date()
    this.clock.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    this.button.title = now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    // next minute
    window.setTimeout(() => this.updateClock(), 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50)
  }
}

function formatTime(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
