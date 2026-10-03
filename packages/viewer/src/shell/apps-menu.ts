import { ShellApp } from '../protocol'
import { SessionInfo, sessionNameField } from '../rename-field'
import { glyphs } from './glyphs'
import { closePopup, isOpen, openPopup, showContextMenu } from './menu'
import type { Shell } from './shell'

export type AppsMenuActions = {
  launch: (app: string) => void
  togglePin: (app: string) => void
  isPinned: (app: string) => boolean
  disconnect: () => void
  logout: () => void
}

/**
 * The Apps menu, top to bottom: who and which session (rename by clicking the name) with the session menu
 * (Disconnect, Log out), search, then pinned apps and all apps.
 */
export class AppsMenu {
  private readonly menu: HTMLElement
  private readonly user: HTMLElement
  private readonly sessionSlot: HTMLElement
  private readonly error: HTMLElement
  private readonly search: HTMLInputElement
  private readonly pinnedSection: HTMLElement
  private readonly pinnedGrid: HTMLElement
  private readonly listHeading: HTMLElement
  private readonly list: HTMLElement
  private readonly empty: HTMLElement
  private apps: ShellApp[] = []

  constructor(
    private readonly shell: Shell,
    private readonly button: HTMLElement,
    private readonly actions: AppsMenuActions,
  ) {
    this.menu = document.createElement('div')
    this.menu.id = 'apps-menu'
    this.menu.className = 'flyout'
    this.menu.hidden = true
    this.menu.setAttribute('role', 'dialog')
    this.menu.setAttribute('aria-label', 'Apps')

    // who, which session, session menu
    const header = document.createElement('div')
    header.className = 'apps-header'
    this.user = document.createElement('div')
    this.user.className = 'apps-user'
    this.sessionSlot = document.createElement('div')
    this.sessionSlot.className = 'apps-session'
    const sessionMenuButton = document.createElement('button')
    sessionMenuButton.type = 'button'
    sessionMenuButton.id = 'session-menu-button'
    sessionMenuButton.className = 'icon-button'
    sessionMenuButton.title = 'Disconnect or log out'
    sessionMenuButton.setAttribute('aria-label', 'Session')
    sessionMenuButton.setAttribute('aria-haspopup', 'menu')
    sessionMenuButton.innerHTML = glyphs.power()
    sessionMenuButton.addEventListener('click', () => {
      const rect = sessionMenuButton.getBoundingClientRect()
      const menu = showContextMenu(
        [
          { label: 'Disconnect', action: () => actions.disconnect(), testId: 'disconnect' },
          { label: 'Log out', action: () => actions.logout(), testId: 'logout', danger: true },
        ],
        rect.right,
        rect.bottom + 4,
        sessionMenuButton,
        true,
      )
      menu.id = 'session-menu'
      // right-aligned under the button
      menu.style.left = `${Math.max(4, rect.right - menu.offsetWidth)}px`
    })
    header.append(this.user, this.sessionSlot, sessionMenuButton)

    this.error = document.createElement('p')
    this.error.className = 'error'
    this.error.setAttribute('role', 'alert')
    this.error.hidden = true

    const searchField = document.createElement('label')
    searchField.className = 'apps-search'
    searchField.innerHTML = glyphs.search()
    this.search = document.createElement('input')
    this.search.type = 'text'
    this.search.id = 'apps-search'
    this.search.placeholder = 'Search apps'
    this.search.autocomplete = 'off'
    this.search.spellcheck = false
    this.search.setAttribute('aria-label', 'Search apps')
    searchField.append(this.search)
    this.search.addEventListener('input', () => this.render())
    this.search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const first = this.list.querySelector<HTMLElement>('[data-app]')
        if (first && this.search.value.trim()) {
          event.preventDefault()
          this.launch(first.dataset.app!)
        }
      }
    })

    const body = document.createElement('div')
    body.className = 'apps-body'
    this.pinnedSection = document.createElement('section')
    const pinnedHeading = document.createElement('h2')
    pinnedHeading.textContent = 'Pinned'
    this.pinnedGrid = document.createElement('div')
    this.pinnedGrid.className = 'apps-grid'
    this.pinnedSection.append(pinnedHeading, this.pinnedGrid)
    const listSection = document.createElement('section')
    this.listHeading = document.createElement('h2')
    this.list = document.createElement('ul')
    this.list.className = 'apps-list'
    this.empty = document.createElement('p')
    this.empty.className = 'apps-empty'
    listSection.append(this.listHeading, this.list, this.empty)
    body.append(this.pinnedSection, listSection)

    this.menu.append(header, this.error, searchField, body)
    document.body.append(this.menu)

    button.addEventListener('click', () => (isOpen(this.menu) ? closePopup() : this.open()))
  }

  start(username: string, session: SessionInfo): void {
    this.user.replaceChildren()
    const avatar = document.createElement('span')
    avatar.className = 'apps-avatar'
    avatar.innerHTML = glyphs.user(16)
    const name = document.createElement('span')
    name.className = 'apps-username'
    name.textContent = username
    this.user.append(avatar, name)
    this.user.title = username
    const { field } = sessionNameField(
      session,
      (message) => {
        this.error.textContent = message ?? ''
        this.error.hidden = message === undefined
      },
      (renamed) => (document.title = renamed.name),
    )
    field.id = 'apps-session-name'
    this.sessionSlot.replaceChildren(field)
    this.error.hidden = true
    this.apps = []
    this.render()
  }

  setApps(apps: ShellApp[]): void {
    this.apps = apps
    if (isOpen(this.menu)) {
      this.render()
    }
  }

  private open() {
    this.search.value = ''
    this.error.hidden = true
    this.render()
    openPopup(this.menu, this.button, () => this.shell.focusDesktop())
    this.menu.querySelector('.apps-body')!.scrollTop = 0
    this.search.focus()
    this.shell.refreshApps()
  }

  private launch(app: string) {
    closePopup()
    this.actions.launch(app)
  }

  private matches(query: string): ShellApp[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const scored: { app: ShellApp; score: number }[] = []
    for (const app of this.apps) {
      const name = app.name.toLowerCase()
      const other = [app.genericName, app.comment, ...app.keywords, app.id].filter(Boolean).join(' ').toLowerCase()
      let score = 0
      for (const term of terms) {
        if (name.startsWith(term) || name.includes(` ${term}`)) {
          score += 3
        } else if (name.includes(term)) {
          score += 2
        } else if (other.includes(term)) {
          score += 1
        } else {
          score = -1
          break
        }
      }
      if (score > 0) {
        scored.push({ app, score })
      }
    }
    return scored.sort((a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name)).map(({ app }) => app)
  }

  private render() {
    const query = this.search.value.trim()
    const pinned = this.apps.filter((app) => this.actions.isPinned(app.id))
    this.pinnedSection.hidden = query !== '' || pinned.length === 0
    this.pinnedGrid.replaceChildren(...pinned.map((app) => this.tile(app)))

    const shown = query ? this.matches(query) : this.apps
    this.listHeading.textContent = query ? 'Results' : 'All apps'
    this.list.replaceChildren(...shown.map((app) => this.row(app)))
    this.empty.hidden = shown.length > 0
    this.empty.textContent = query ? 'No apps match your search.' : 'No apps found.'
  }

  private tile(app: ShellApp): HTMLElement {
    const tile = document.createElement('button')
    tile.type = 'button'
    tile.className = 'app-tile'
    tile.dataset.app = app.id
    tile.title = app.comment ?? app.name
    const name = document.createElement('span')
    name.textContent = app.name
    tile.append(this.shell.icons.element(app.icon, 32), name)
    tile.addEventListener('click', () => this.launch(app.id))
    tile.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      showContextMenu(
        [
          { label: 'Open', action: () => this.launch(app.id), testId: 'launch' },
          { label: 'Unpin', action: () => this.actions.togglePin(app.id), testId: 'unpin' },
        ],
        event.clientX,
        event.clientY,
        undefined,
        true,
      )
    })
    return tile
  }

  private row(app: ShellApp): HTMLElement {
    const row = document.createElement('li')
    const launch = document.createElement('button')
    launch.type = 'button'
    launch.className = 'app-row'
    launch.dataset.app = app.id
    launch.title = app.comment ?? app.name
    const text = document.createElement('span')
    text.className = 'app-row-text'
    const name = document.createElement('span')
    name.className = 'app-name'
    name.textContent = app.name
    text.append(name)
    if (app.genericName && app.genericName !== app.name) {
      const generic = document.createElement('span')
      generic.className = 'app-generic'
      generic.textContent = app.genericName
      text.append(generic)
    }
    launch.append(this.shell.icons.element(app.icon, 24), text)
    launch.addEventListener('click', () => this.launch(app.id))

    const pinned = this.actions.isPinned(app.id)
    const pin = document.createElement('button')
    pin.type = 'button'
    pin.className = 'icon-button pin-toggle'
    pin.classList.toggle('pinned', pinned)
    pin.dataset.pin = app.id
    pin.title = pinned ? 'Unpin' : 'Pin'
    pin.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} ${app.name}`)
    pin.setAttribute('aria-pressed', String(pinned))
    pin.innerHTML = pinned ? glyphs.pinned() : glyphs.pin()
    pin.addEventListener('click', () => this.actions.togglePin(app.id))
    row.append(launch, pin)
    return row
  }
}
