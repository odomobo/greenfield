import { useEffect, useRef, useState } from 'react'
import { useCore } from '../core'
import { shellStore } from '../state'
import { closePopup, closePopupOf, isOpen, openPopup, usePopupStack } from '../popups'
import { useStore } from '../store'
import { glyphs } from './glyphs'
import { AppIcon } from './icons'
import type { ShellApp } from '../protocol'

export type AppsMenuActions = {
  launch: (app: string) => void
  togglePin: (app: string) => void
  isPinned: (app: string) => boolean
  disconnect: () => void
  logout: () => void
}

/**
 * The Apps menu, top to bottom: who, with the session menu
 * (Disconnect, Log out), search, then pinned apps and all apps. Always in the document, shown while open (like the
 * old markup, tests check its hidden flag): opening empties the search and puts the keyboard into it, closing gives
 * it back to the desktop.
 */
export function AppsMenu({ actions }: { actions: AppsMenuActions }) {
  const state = useStore(shellStore)
  const { desktop, shell } = useCore()
  const open = usePopupStack().some((popup) => popup.kind === 'apps')
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const sessionMenuButtonRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)

  // React's onInput is delegated from the root and so misses input events dispatched directly on the element
  // without bubbling — the old DOM code listened on the element itself, and the test hooks still drive the
  // field that way. The input stays uncontrolled: its DOM value is the source of truth, mirrored into `query`
  // state for filtering.
  useEffect(() => {
    const input = searchRef.current
    if (input === null) {
      return
    }
    const onInput = () => setQuery(input.value)
    input.addEventListener('input', onInput)
    return () => input.removeEventListener('input', onInput)
  }, [])

  useEffect(() => {
    if (open) {
      // opened: empty search, at the top, the search field has the keyboard; the session re-reads its apps
      if (searchRef.current !== null) {
        searchRef.current.value = ''
      }
      setQuery('')
      bodyRef.current?.scrollTo(0, 0)
      searchRef.current?.focus()
      shell.refreshApps()
      wasOpen.current = true
    } else if (wasOpen.current) {
      // closed: give the keyboard back to the desktop
      wasOpen.current = false
      desktop.focus()
    }
  }, [open, desktop, shell])

  const pinned = state.apps.filter((app) => actions.isPinned(app.id))
  const shown = query.trim() ? matches(state.apps, query.trim()) : state.apps

  const launch = (app: string) => {
    closePopup()
    actions.launch(app)
  }

  const sessionMenu = () => {
    const button = sessionMenuButtonRef.current
    if (button === null) {
      return
    }
    // a second click closes it
    if (isOpen('session-menu-button')) {
      closePopupOf('session-menu-button')
      return
    }
    const rect = button.getBoundingClientRect()
    openPopup(
      {
        kind: 'context',
        owner: 'session-menu-button',
        items: [
          { label: 'Disconnect', action: () => actions.disconnect(), testId: 'disconnect' },
          { label: 'Log out', action: () => actions.logout(), testId: 'logout', danger: true },
        ],
        x: rect.right,
        y: rect.bottom + 4,
        nested: true,
        alignRight: true,
        menuId: 'session-menu',
      },
      true,
    )
  }

  return (
    <div
      id="apps-menu"
      className="flyout"
      role="dialog"
      aria-label="Apps"
      hidden={!open}
      data-popup-owner="apps-button"
    >
      {/* who, session menu */}
      <div className="apps-header">
        <div className="apps-user" title={state.username}>
          <span className="apps-avatar" dangerouslySetInnerHTML={{ __html: glyphs.user(18) }} />
          <span className="apps-username">{state.username}</span>
        </div>
        <button
          ref={sessionMenuButtonRef}
          type="button"
          id="session-menu-button"
          className={'icon-button' + (isOpen('session-menu-button') ? ' open' : '')}
          title="Disconnect or log out"
          aria-label="Session"
          aria-haspopup="menu"
          aria-expanded={isOpen('session-menu-button')}
          data-popup-anchor="session-menu-button"
          onClick={sessionMenu}
          dangerouslySetInnerHTML={{ __html: glyphs.power() }}
        />
      </div>

      <label className="apps-search">
        <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: glyphs.search() }} />
        <input
          ref={searchRef}
          type="text"
          id="apps-search"
          placeholder="Search apps"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search apps"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && query.trim() && shown.length > 0) {
              event.preventDefault()
              launch(shown[0].id)
            }
          }}
        />
      </label>

      <div className="apps-body" ref={bodyRef}>
        <section hidden={query.trim() !== '' || pinned.length === 0}>
          <h2>Pinned</h2>
          <div className="apps-grid">
            {pinned.map((app) => (
              <button
                key={app.id}
                type="button"
                className="app-tile"
                data-app={app.id}
                title={app.comment ?? app.name}
                onClick={() => launch(app.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  openPopup(
                    {
                      kind: 'context',
                      owner: `tile:${app.id}`,
                      items: [
                        { label: 'Open', action: () => launch(app.id), testId: 'launch' },
                        { label: 'Unpin', action: () => actions.togglePin(app.id), testId: 'unpin' },
                      ],
                      x: event.clientX,
                      y: event.clientY,
                      nested: true,
                    },
                    true,
                  )
                }}
              >
                <AppIcon name={app.icon} size={32} />
                <span>{app.name}</span>
              </button>
            ))}
          </div>
        </section>
        <section>
          <h2>{query.trim() ? 'Results' : 'All apps'}</h2>
          <ul className="apps-list">
            {shown.map((app) => (
              <AppRow key={app.id} app={app} pinned={actions.isPinned(app.id)} onLaunch={launch} onTogglePin={actions.togglePin} />
            ))}
          </ul>
          <p className="apps-empty" hidden={shown.length > 0}>
            {query.trim() ? 'No apps match your search.' : 'No apps found.'}
          </p>
        </section>
      </div>
    </div>
  )
}

function AppRow({
  app,
  pinned,
  onLaunch,
  onTogglePin,
}: {
  app: ShellApp
  pinned: boolean
  onLaunch: (app: string) => void
  onTogglePin: (app: string) => void
}) {
  return (
    <li>
      <button
        type="button"
        className="app-row"
        data-app={app.id}
        title={app.comment ?? app.name}
        onClick={() => onLaunch(app.id)}
      >
        <AppIcon name={app.icon} size={24} />
        <span className="app-row-text">
          <span className="app-name">{app.name}</span>
          {app.genericName && app.genericName !== app.name ? (
            <span className="app-generic">{app.genericName}</span>
          ) : null}
        </span>
      </button>
      <button
        type="button"
        className={'icon-button pin-toggle' + (pinned ? ' pinned' : '')}
        data-pin={app.id}
        title={pinned ? 'Unpin' : 'Pin'}
        aria-label={`${pinned ? 'Unpin' : 'Pin'} ${app.name}`}
        aria-pressed={pinned}
        onClick={() => onTogglePin(app.id)}
        dangerouslySetInnerHTML={{ __html: pinned ? glyphs.pinned() : glyphs.pin() }}
      />
    </li>
  )
}

/**
 * Apps matching the search query, best first: a name that starts with (or follows a space before) a term counts
 * most, other name hits less, the rest (generic name, comment, keywords, ID) least.
 */
function matches(apps: ShellApp[], query: string): ShellApp[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const scored: { app: ShellApp; score: number }[] = []
  for (const app of apps) {
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
