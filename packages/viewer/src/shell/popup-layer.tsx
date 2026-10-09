import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { closeAbove, closePopup, isOpen, openPopup, popupStore, usePopupStack } from '../popups'
import type { ContextPopup, MenuItem, PopupEntry, PreviewPopup, Submenu } from '../popups'
import { glyphs } from './glyphs'
import { usePresence } from './presence'
import { WindowPreview } from './previews'
import { TaskbarOverflow } from './taskbar'

/**
 * Renders the popups that come and go (see popups.ts): context menus, window previews and the taskbar's overflow, in stack order (a nested
 * one above its parent). The Apps menu and the notification panel stay in the document (hidden when closed) and are
 * rendered by the desktop view.
 */
export function PopupLayer() {
  // closed menus stay a moment, animating out (the .leaving animation in style.css)
  const entries = usePresence(usePopupStack(), keyOf, MENU_LEAVE_MS)
  return (
    <>
      {entries.map(({ item: entry, leaving }) => {
        if (entry.kind === 'context') {
          return <ContextMenu key={keyOf(entry)} entry={entry} leaving={leaving} />
        }
        if (entry.kind === 'preview' && !leaving) {
          return <WindowPreview key={keyOf(entry)} entry={entry} />
        }
        if (entry.kind === 'overflow' && !leaving) {
          return <TaskbarOverflow key={keyOf(entry)} />
        }
        return null
      })}
    </>
  )
}

const MENU_LEAVE_MS = 100
const keyOf = (entry: PopupEntry) => `${entry.kind}:${entry.owner}`

/** How long the pointer rests on an entry before its submenu opens (or an open one of another entry closes). */
const SUBMENU_DELAY_MS = 150

/**
 * A context menu at a point (page coordinates), kept inside the window. Leaving: closed, animating out (no input, not
 * the popup of its owner anymore). Entries with a submenu open it as a nested menu beside them, on pointing or
 * clicking.
 */
function ContextMenu({ entry, leaving }: { entry: ContextPopup; leaving: boolean }) {
  const [position, setPosition] = useState<{ left: number; top: number } | undefined>(undefined)
  const menuRef = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (menu === null) {
      return
    }
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    let left = entry.alignRight
      ? Math.max(4, entry.x - width)
      : Math.max(4, Math.min(entry.x, window.innerWidth - width - 4))
    // a submenu without room on the right goes on the left of its menu
    if (entry.parentLeft !== undefined && entry.x + width > window.innerWidth - 4) {
      left = Math.max(4, entry.parentLeft - width)
    }
    setPosition({ left, top: Math.max(4, Math.min(entry.y, window.innerHeight - height - 4)) })
  }, [entry.alignRight, entry.x, entry.y, entry.parentLeft, entry.items])

  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  /** Where this menu is in the popup stack (submenus open above it). */
  const stackIndex = () =>
    popupStore.get().stack.findIndex((popup) => popup.kind === 'context' && popup.owner === entry.owner)

  const openSubmenu = (submenu: Submenu, row: HTMLElement) => {
    const index = stackIndex()
    const menu = menuRef.current
    if (index < 0 || menu === null || popupStore.get().stack[index + 1]?.owner === submenu.owner) {
      return
    }
    closeAbove(index + 1)
    const menuRect = menu.getBoundingClientRect()
    openPopup(
      {
        kind: 'context',
        owner: submenu.owner,
        items: submenu.items,
        x: menuRect.right - 2,
        y: row.getBoundingClientRect().top - 5,
        nested: true,
        parentLeft: menuRect.left + 2,
      },
      true,
    )
    submenu.onOpen?.()
  }

  /** Pointing at an entry for a moment opens its submenu, or closes another entry's. */
  const pointAt = (item: MenuItem, row: HTMLElement) => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => {
      if ('submenu' in item && item.submenu && !item.disabled) {
        openSubmenu(item.submenu, row)
      } else {
        const index = stackIndex()
        if (index >= 0) {
          closeAbove(index + 1)
        }
      }
    }, SUBMENU_DELAY_MS)
  }

  const marks = entry.items.some((item) => 'label' in item && item.toggle !== undefined)
  const icons = entry.items.some((item) => 'label' in item && item.icon !== undefined)

  return (
    <div
      ref={menuRef}
      id={leaving ? undefined : entry.menuId}
      className={'context-menu flyout' + (entry.alignRight ? ' align-right' : '') + (leaving ? ' leaving' : '')}
      role="menu"
      data-popup-owner={leaving ? undefined : entry.owner}
      style={
        position === undefined
          ? { visibility: 'hidden' }
          : { left: `${position.left}px`, top: `${position.top}px` }
      }
    >
      {entry.items.map((item, index) => {
        if ('separator' in item) {
          return <div key={index} className="separator" />
        }
        if ('heading' in item) {
          return (
            <div key={index} className="heading">
              {item.heading}
            </div>
          )
        }
        const submenu = item.submenu
        return (
          <button
            key={index}
            type="button"
            role={item.toggle === 'radio' ? 'menuitemradio' : item.toggle ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={item.toggle ? item.checked === true : undefined}
            aria-haspopup={submenu ? 'menu' : undefined}
            className={(item.danger ? 'danger' : '') + (submenu && isOpen(submenu.owner) ? ' open' : '') || undefined}
            disabled={item.disabled}
            data-action={item.testId}
            onPointerEnter={(event) => pointAt(item, event.currentTarget)}
            onPointerLeave={() => clearTimeout(hoverTimer.current)}
            onClick={(event) => {
              if (submenu) {
                clearTimeout(hoverTimer.current)
                openSubmenu(submenu, event.currentTarget)
                return
              }
              // close this menu and what it was opened from
              if (item.keepOpener) {
                closeAbove(Math.max(0, stackIndex()))
              } else {
                closePopup()
              }
              item.action()
            }}
          >
            {marks && (
              <span className="menu-mark" aria-hidden="true">
                {item.checked &&
                  (item.toggle === 'radio' ? (
                    <span className="radio-dot" />
                  ) : (
                    <span dangerouslySetInnerHTML={{ __html: glyphs.check() }} />
                  ))}
              </span>
            )}
            {icons && (
              <span className="menu-icon" aria-hidden="true">
                {item.icon && <img src={item.icon} alt="" width={16} height={16} draggable={false} />}
              </span>
            )}
            <span className="menu-label">{item.label}</span>
            {submenu && (
              <span
                className="menu-chevron"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: glyphs.chevronRight() }}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
