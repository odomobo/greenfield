import { useEffect, useRef } from 'react'
import { useCore } from '../core'
import { ShellNotification } from '../protocol'
import { shellStore } from '../state'
import { usePopupStack } from '../popups'
import { useStore } from '../store'
import { glyphs } from './glyphs'
import { appById } from './groups'
import { AppIcon } from './icons'

/**
 * The notification panel (the bell's flyout, the whole kept history) and the toasts for new notifications, top
 * right below the taskbar. Notifications are kept by the session; dismissing one here removes it there.
 */
export function NotificationsPanel() {
  const state = useStore(shellStore)
  const { desktop, shell } = useCore()
  const open = usePopupStack().some((popup) => popup.kind === 'notifications')
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open) {
      wasOpen.current = true
    } else if (wasOpen.current) {
      // closed: give the keyboard back to the desktop
      wasOpen.current = false
      desktop.focus()
    }
  }, [open, desktop])
  // the panel shows them all, newest first
  const notifications = [...state.notifications].reverse()
  return (
    <div
      id="notifications-panel"
      className="flyout"
      role="dialog"
      aria-label="Notifications"
      hidden={!open}
      data-popup-owner="notifications-button"
    >
      <div className="panel-header">
        <h2>Notifications</h2>
        <button type="button" className="link-button" id="notifications-clear" onClick={() => shell.clearAll()}>
          Clear all
        </button>
      </div>
      <div className="panel-list">
        {notifications.map((notification) => (
          <NotificationCard key={notification.id} notification={notification} where="panel" />
        ))}
      </div>
      <p className="panel-empty" hidden={notifications.length > 0}>
        No new notifications
      </p>
    </div>
  )
}

/** The toasts for new notifications, newest first. Clicking a toast puts it away (it stays in the history). */
export function Toasts() {
  const toasts = useStore(shellStore).toasts
  return (
    <div id="toasts" aria-live="polite">
      {toasts.map((notification) => (
        <NotificationCard key={notification.id} notification={notification} where="toast" />
      ))}
    </div>
  )
}

function NotificationCard({ notification, where }: { notification: ShellNotification; where: 'panel' | 'toast' }) {
  const state = useStore(shellStore)
  const { shell } = useCore()
  const app = appById(state.apps, notification.desktopEntry ? `${notification.desktopEntry}.desktop` : undefined)
  return (
    <div
      className={(where === 'toast' ? 'toast' : 'notification') + (notification.urgency === 'critical' ? ' critical' : '')}
      data-notification={String(notification.id)}
      onClick={where === 'toast' ? () => shell.hideToast(notification.id) : undefined}
    >
      <AppIcon name={notification.icon ?? app?.icon} size={24} />
      <div className="notification-text">
        <div className="notification-meta">
          {[notification.appName || app?.name, formatTime(notification.time)].filter(Boolean).join(' · ')}
        </div>
        <div className="notification-summary">{notification.summary}</div>
        {notification.body ? <div className="notification-body">{notification.body}</div> : null}
      </div>
      <button
        type="button"
        className="icon-button notification-close"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={(event) => {
          event.stopPropagation()
          shell.dismiss(notification.id)
        }}
        dangerouslySetInnerHTML={{ __html: glyphs.close(12) }}
      />
    </div>
  )
}

function formatTime(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
