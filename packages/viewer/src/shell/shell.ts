import { Desktop, ShellWindow } from '../desktop'
import { ServerMessage, ShellApp, ViewerMessage } from '../protocol'
import { SessionInfo } from '../rename-field'
import { AppsMenu } from './apps-menu'
import { glyphs } from './glyphs'
import { IconCache } from './icon-cache'
import { closePopup, isOpen, MenuItem, openPopup, showContextMenu } from './menu'
import { Notifications } from './notifications'

export type ShellCallbacks = {
  send: (message: ViewerMessage) => void
  disconnect: () => void
  logout: () => void
}

export type ConnectionIndicator = 'connecting' | 'connected' | 'reconnecting' | 'offline'

/** A taskbar entry: a pinned app and/or the windows of one app. */
type Group = { key: string; app?: ShellApp; windows: ShellWindow[]; pinned: boolean }

const PREVIEW_WIDTH = 200
const PREVIEW_HEIGHT = 120
const PREVIEW_REFRESH_MS = 250
/** hover this long before a preview opens; once one is open, moving to another button switches right away */
const PREVIEW_OPEN_DELAY_MS = 150
const PREVIEW_CLOSE_DELAY_MS = 300

/**
 * The desktop shell, drawn by the browser on top of the session: the taskbar at the top (Apps menu, pinned apps and
 * running windows grouped by app, connection indicator, notifications and clock), window previews, the Apps menu and
 * notifications. Server-side state (apps, pinned apps, notifications) comes from the session's shell service.
 */
export class Shell {
  readonly icons: IconCache
  private apps: ShellApp[] = []
  private pinned: string[] = []
  private windows: ShellWindow[] = []
  /** running groups in the order they first appeared, so buttons don't jump around */
  private readonly groupOrder: string[] = []
  private readonly appsMenu: AppsMenu
  private readonly notifications: Notifications

  private readonly items: HTMLElement
  private readonly preview: HTMLElement
  private previewGroup?: string
  private previewTimer?: number
  private previewRefresh?: number
  private previewPinned = false

  constructor(
    private readonly desktop: Desktop,
    private readonly callbacks: ShellCallbacks,
    taskbar: HTMLElement,
  ) {
    this.icons = new IconCache((names) => callbacks.send({ type: 'shell.icons', names }))

    taskbar.replaceChildren()
    const appsButton = document.createElement('button')
    appsButton.type = 'button'
    appsButton.id = 'apps-button'
    appsButton.className = 'taskbar-button'
    appsButton.title = 'Apps'
    appsButton.setAttribute('aria-label', 'Apps')
    appsButton.setAttribute('aria-haspopup', 'true')
    appsButton.innerHTML = glyphs.apps()

    this.items = document.createElement('div')
    this.items.id = 'taskbar-items'
    this.items.setAttribute('role', 'toolbar')

    const tray = document.createElement('div')
    tray.id = 'tray'
    taskbar.append(appsButton, this.items, tray)

    this.appsMenu = new AppsMenu(this, appsButton, {
      launch: (app) => this.launch(app),
      togglePin: (app) => this.togglePin(app),
      isPinned: (app) => this.pinned.includes(app),
      disconnect: callbacks.disconnect,
      logout: callbacks.logout,
    })
    this.notifications = new Notifications(this, tray, callbacks.send)

    this.preview = document.createElement('div')
    this.preview.id = 'window-preview'
    this.preview.className = 'flyout'
    this.preview.hidden = true
    this.preview.addEventListener('pointerenter', () => clearTimeout(this.previewTimer))
    this.preview.addEventListener('pointerleave', () => this.schedulePreviewClose())
    document.body.append(this.preview)

    desktop.onWindowsChanged = (windows) => this.updateWindows(windows)
    desktop.minimizeTarget = (window) => this.buttonFor(window)?.getBoundingClientRect()
  }

  /** A session was opened: show its user and name, start empty until the session sends its state. */
  start(username: string, session: SessionInfo): void {
    this.apps = []
    this.pinned = []
    this.windows = []
    this.groupOrder.length = 0
    this.icons.clear()
    closePopup()
    this.appsMenu.start(username, session)
    this.notifications.reset()
    this.renderTaskbar()
  }

  /** Left the desktop: put popups and toasts away. */
  stop(): void {
    closePopup()
    this.notifications.reset()
  }

  setConnection(state: ConnectionIndicator): void {
    this.notifications.setConnection(state)
  }

  handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'shell.apps':
        this.apps = message.apps
        this.appsMenu.setApps(this.apps)
        this.renderTaskbar()
        break
      case 'shell.pinned':
        this.pinned = message.apps
        this.appsMenu.setApps(this.apps)
        this.renderTaskbar()
        break
      case 'shell.icons':
        this.icons.received(message.icons)
        break
      case 'shell.notifications':
        this.notifications.setAll(message.notifications)
        break
      case 'shell.notification':
        this.notifications.add(message.notification)
        break
      case 'shell.notification-closed':
        this.notifications.remove(message.id)
        break
      case 'shell.launch-failed': {
        const app = this.apps.find((a) => a.id === message.app)
        this.notifications.local(`${app?.name ?? 'The app'} could not be started.`)
        break
      }
    }
  }

  appById(id: string | undefined): ShellApp | undefined {
    return id === undefined ? undefined : this.apps.find((app) => app.id === id)
  }

  /** The installed app a window belongs to, by its app_id. */
  appForWindow(window: { appId: string }): ShellApp | undefined {
    const appId = window.appId
    if (!appId) {
      return undefined
    }
    const lower = appId.toLowerCase()
    return (
      this.apps.find((app) => app.id === `${appId}.desktop`) ??
      this.apps.find((app) => app.wmClass === appId) ??
      this.apps.find((app) => app.id.toLowerCase() === `${lower}.desktop`) ??
      this.apps.find((app) => app.wmClass?.toLowerCase() === lower) ??
      // reverse-DNS IDs: org.example.Foo.desktop for app_id foo
      this.apps.find((app) => app.id.toLowerCase().endsWith(`.${lower}.desktop`))
    )
  }

  launch(app: string): void {
    this.callbacks.send({ type: 'shell.launch', app })
    // apps take a moment; the window shows up in the taskbar when it maps
  }

  togglePin(app: string): void {
    const pinned = this.pinned.includes(app) ? this.pinned.filter((id) => id !== app) : [...this.pinned, app]
    // shown right away, the session confirms with shell.pinned
    this.pinned = pinned
    this.callbacks.send({ type: 'shell.pin', apps: pinned })
    this.appsMenu.setApps(this.apps)
    this.renderTaskbar()
  }

  /** Installed apps may have changed (the session rate-limits re-reading them). */
  refreshApps(): void {
    this.callbacks.send({ type: 'shell.refresh-apps' })
  }

  /** Give the keyboard back to the desktop (after a popup closed). */
  focusDesktop(): void {
    this.desktop.focus()
  }

  // -------------------------------------------------------------------------------------------------------------------
  // taskbar

  private updateWindows(windows: ShellWindow[]) {
    this.windows = windows
    this.renderTaskbar()
    if (this.previewGroup !== undefined && isOpen(this.preview)) {
      const group = this.groups().find((g) => g.key === this.previewGroup)
      if (group === undefined || group.windows.length === 0) {
        closePopup()
      } else {
        this.renderPreview(group)
      }
    }
  }

  private groupKey(window: ShellWindow): string {
    return this.appForWindow(window)?.id ?? `window:${window.appId || window.id}`
  }

  private groups(): Group[] {
    const byKey = new Map<string, Group>()
    for (const id of this.pinned) {
      byKey.set(id, { key: id, app: this.appById(id), windows: [], pinned: true })
    }
    for (const window of this.windows) {
      const key = this.groupKey(window)
      let group = byKey.get(key)
      if (group === undefined) {
        group = { key, app: this.appForWindow(window), windows: [], pinned: false }
        byKey.set(key, group)
      }
      group.windows.push(window)
      if (!this.groupOrder.includes(key)) {
        this.groupOrder.push(key)
      }
    }
    const pinned = this.pinned.map((id) => byKey.get(id)!).filter((group) => group.app || group.windows.length > 0)
    const running = this.groupOrder
      .map((key) => byKey.get(key))
      .filter((group): group is Group => group !== undefined && !group.pinned && group.windows.length > 0)
    // forget groups that are gone
    for (let i = this.groupOrder.length - 1; i >= 0; i--) {
      if (!byKey.get(this.groupOrder[i])?.windows.length) {
        this.groupOrder.splice(i, 1)
      }
    }
    return [...pinned, ...running]
  }

  private groupName(group: Group): string {
    return group.app?.name ?? group.windows[0]?.title ?? group.windows[0]?.appId ?? 'Window'
  }

  private renderTaskbar() {
    const groups = this.groups()
    const existing = new Map([...this.items.children].map((child) => [(child as HTMLElement).dataset.group!, child]))
    const buttons = groups.map((group) => {
      const button = (existing.get(group.key) as HTMLButtonElement | undefined) ?? this.createButton(group.key)
      this.updateButton(button, group)
      return button
    })
    // keep elements (and their hover state) where possible
    buttons.forEach((button, index) => {
      if (this.items.children[index] !== button) {
        this.items.insertBefore(button, this.items.children[index] ?? null)
      }
    })
    while (this.items.children.length > buttons.length) {
      this.items.lastElementChild!.remove()
    }
  }

  private createButton(key: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'taskbar-button app'
    button.dataset.group = key
    button.addEventListener('click', () => this.clickGroup(key, button))
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      this.groupMenu(key, button, event.clientX, event.clientY)
    })
    button.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'mouse') {
        this.schedulePreviewOpen(key, button)
      }
    })
    button.addEventListener('pointerleave', () => this.schedulePreviewClose())
    return button
  }

  private updateButton(button: HTMLButtonElement, group: Group) {
    const name = this.groupName(group)
    const iconName = group.app?.icon
    if (button.dataset.icon !== (iconName ?? '')) {
      button.dataset.icon = iconName ?? ''
      const indicator = document.createElement('span')
      indicator.className = 'indicator'
      button.replaceChildren(this.icons.element(iconName, 24), indicator)
    }
    const active = group.windows.some((window) => window.activated && !window.shownMinimized)
    button.classList.toggle('running', group.windows.length > 0)
    button.classList.toggle('active', active)
    button.classList.toggle('pinned', group.pinned)
    button.dataset.windows = String(group.windows.length)
    button.setAttribute('aria-label', group.windows.length > 1 ? `${name}, ${group.windows.length} windows` : name)
    // running groups get a preview instead of a tooltip
    button.title = group.windows.length === 0 ? name : ''
  }

  private buttonFor(windowId: string): HTMLElement | undefined {
    const window = this.windows.find((w) => w.id === windowId)
    if (window === undefined) {
      return undefined
    }
    const key = this.groupKey(window)
    return [...this.items.children].find((child) => (child as HTMLElement).dataset.group === key) as
      | HTMLElement
      | undefined
  }

  private clickGroup(key: string, button: HTMLElement) {
    const group = this.groups().find((g) => g.key === key)
    if (group === undefined) {
      return
    }
    if (group.windows.length === 0) {
      if (group.app) {
        this.launch(group.app.id)
      }
      return
    }
    if (group.windows.length === 1) {
      const [window] = group.windows
      closePopup()
      if (window.activated && !window.shownMinimized) {
        this.desktop.minimizeWindow(window.id)
      } else {
        this.desktop.activateWindow(window.id)
      }
      return
    }
    // several windows: pick one from the previews
    if (isOpen(this.preview) && this.previewGroup === key && this.previewPinned) {
      closePopup()
      return
    }
    this.openPreview(key, button)
    this.previewPinned = true
  }

  private groupMenu(key: string, button: HTMLElement, x: number, y: number) {
    const group = this.groups().find((g) => g.key === key)
    if (group === undefined) {
      return
    }
    const items: MenuItem[] = [{ heading: this.groupName(group) }]
    if (group.app) {
      const app = group.app
      items.push({ label: group.windows.length ? 'New window' : 'Open', action: () => this.launch(app.id), testId: 'launch' })
      items.push({
        label: group.pinned ? 'Unpin from taskbar' : 'Pin to taskbar',
        action: () => this.togglePin(app.id),
        testId: group.pinned ? 'unpin' : 'pin',
      })
    }
    if (group.windows.length === 1) {
      items.push({ separator: true }, ...this.windowMenuItems(group.windows[0]))
    } else if (group.windows.length > 1) {
      items.push(
        { separator: true },
        {
          label: 'Close all windows',
          action: () => group.windows.forEach((window) => this.desktop.closeWindow(window.id)),
          testId: 'close-all',
        },
      )
    }
    showContextMenu(items, x, y, button)
  }

  private windowMenuItems(window: ShellWindow): MenuItem[] {
    return [
      window.shownMinimized
        ? { label: 'Restore', action: () => this.desktop.activateWindow(window.id), testId: 'restore' }
        : { label: 'Minimize', action: () => this.desktop.minimizeWindow(window.id), testId: 'minimize' },
      window.maximized
        ? { label: 'Restore down', action: () => this.desktop.setMaximized(window.id, false), testId: 'unmaximize' }
        : { label: 'Maximize', action: () => this.desktop.setMaximized(window.id, true), testId: 'maximize' },
      { label: 'Close window', action: () => this.desktop.closeWindow(window.id), testId: 'close' },
    ]
  }

  // -------------------------------------------------------------------------------------------------------------------
  // window previews

  private schedulePreviewOpen(key: string, button: HTMLElement) {
    clearTimeout(this.previewTimer)
    const group = this.groups().find((g) => g.key === key)
    if (group === undefined || group.windows.length === 0) {
      if (isOpen(this.preview)) {
        this.schedulePreviewClose()
      }
      return
    }
    if (isOpen(this.preview)) {
      // already showing previews: switch right away
      this.openPreview(key, button)
      return
    }
    // another popup (menu) is open: don't cover it
    if (document.querySelector('.flyout:not([hidden])')) {
      return
    }
    this.previewTimer = window.setTimeout(() => this.openPreview(key, button), PREVIEW_OPEN_DELAY_MS)
  }

  private schedulePreviewClose() {
    clearTimeout(this.previewTimer)
    if (!isOpen(this.preview) || this.previewPinned) {
      return
    }
    this.previewTimer = window.setTimeout(() => {
      if (isOpen(this.preview)) {
        closePopup()
      }
    }, PREVIEW_CLOSE_DELAY_MS)
  }

  private openPreview(key: string, button: HTMLElement) {
    clearTimeout(this.previewTimer)
    const group = this.groups().find((g) => g.key === key)
    if (group === undefined || group.windows.length === 0) {
      return
    }
    this.previewGroup = key
    this.previewPinned = false
    this.renderPreview(group)
    openPopup(this.preview, button, () => {
      clearInterval(this.previewRefresh)
      this.previewRefresh = undefined
      this.previewGroup = undefined
      this.previewPinned = false
    })
    // under the button, inside the window
    const anchor = button.getBoundingClientRect()
    const width = this.preview.offsetWidth
    this.preview.style.left = `${Math.max(4, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 4))}px`
    this.preview.style.top = `${anchor.bottom + 4}px`
    clearInterval(this.previewRefresh)
    this.previewRefresh = window.setInterval(() => this.refreshPreviewImages(), PREVIEW_REFRESH_MS)
  }

  private renderPreview(group: Group) {
    const existing = new Map(
      [...this.preview.children].map((child) => [(child as HTMLElement).dataset.window!, child as HTMLElement]),
    )
    const cards = group.windows.map((window) => {
      const card = existing.get(window.id) ?? this.createPreviewCard(window.id)
      this.updatePreviewCard(card, window, group)
      return card
    })
    this.preview.replaceChildren(...cards)
    this.refreshPreviewImages()
  }

  private createPreviewCard(windowId: string): HTMLElement {
    const card = document.createElement('div')
    card.className = 'preview-card'
    card.dataset.window = windowId
    card.setAttribute('role', 'button')
    card.tabIndex = 0

    const header = document.createElement('div')
    header.className = 'preview-header'
    const title = document.createElement('span')
    title.className = 'preview-title'
    const controls = document.createElement('div')
    controls.className = 'preview-controls'
    const control = (action: string, label: string) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.action = action
      button.title = label
      button.setAttribute('aria-label', label)
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        this.windowAction(windowId, action)
      })
      return button
    }
    controls.append(control('minimize', 'Minimize'), control('maximize', 'Maximize'), control('close', 'Close'))
    header.append(document.createElement('span'), title, controls)

    const image = document.createElement('canvas')
    image.className = 'preview-image'
    card.append(header, image)
    card.addEventListener('click', () => {
      closePopup()
      this.desktop.activateWindow(windowId)
    })
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        card.click()
      }
    })
    card.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      const window = this.windows.find((w) => w.id === windowId)
      if (window) {
        showContextMenu(this.windowMenuItems(window), event.clientX, event.clientY, undefined, true)
      }
    })
    return card
  }

  private updatePreviewCard(card: HTMLElement, window: ShellWindow, group: Group) {
    const header = card.firstElementChild as HTMLElement
    const [icon, title, controls] = header.children as unknown as HTMLElement[]
    const iconName = group.app?.icon ?? ''
    if (icon.dataset.icon !== iconName || !icon.classList.contains('app-icon')) {
      const element = this.icons.element(group.app?.icon, 16)
      element.dataset.icon = iconName
      header.replaceChild(element, icon)
    }
    title.textContent = window.title || this.groupName(group)
    card.title = window.title
    card.classList.toggle('active', window.activated && !window.shownMinimized)
    const [minimize, maximize, close] = controls.children as unknown as HTMLButtonElement[]
    minimize.innerHTML = glyphs.minimize(12)
    minimize.hidden = window.shownMinimized
    maximize.innerHTML = window.maximized ? glyphs.restore(12) : glyphs.maximize(12)
    maximize.title = window.maximized ? 'Restore down' : 'Maximize'
    maximize.dataset.action = window.maximized ? 'unmaximize' : 'maximize'
    close.innerHTML = glyphs.close(12)
  }

  private windowAction(windowId: string, action: string) {
    switch (action) {
      case 'minimize':
        closePopup()
        this.desktop.minimizeWindow(windowId)
        break
      case 'maximize':
      case 'unmaximize':
        closePopup()
        this.desktop.setMaximized(windowId, action === 'maximize')
        break
      case 'close':
        this.desktop.closeWindow(windowId)
        break
    }
  }

  private refreshPreviewImages() {
    for (const card of this.preview.children as unknown as HTMLElement[]) {
      const canvas = card.querySelector('canvas')!
      const image = this.desktop.renderPreview(card.dataset.window!, PREVIEW_WIDTH, PREVIEW_HEIGHT)
      if (image === undefined) {
        continue
      }
      if (canvas.width !== image.width || canvas.height !== image.height) {
        canvas.width = image.width
        canvas.height = image.height
      }
      canvas.getContext('2d')?.putImageData(image, 0, 0)
    }
  }
}
