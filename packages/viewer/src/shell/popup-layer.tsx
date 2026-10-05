import { useLayoutEffect, useRef, useState } from 'react'
import { closePopup, usePopupStack } from '../popups'
import type { ContextPopup, PopupEntry, PreviewPopup } from '../popups'
import { usePresence } from './presence'
import { WindowPreview } from './previews'

/**
 * Renders the popups that come and go (see popups.ts): context menus and window previews, in stack order (a nested
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
        return null
      })}
    </>
  )
}

const MENU_LEAVE_MS = 100
const keyOf = (entry: PopupEntry) => `${entry.kind}:${entry.owner}`

/**
 * A context menu at a point (page coordinates), kept inside the window. Leaving: closed, animating out (no input, not
 * the popup of its owner anymore).
 */
function ContextMenu({ entry, leaving }: { entry: ContextPopup; leaving: boolean }) {
  const [position, setPosition] = useState<{ left: number; top: number } | undefined>(undefined)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (menu === null) {
      return
    }
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    setPosition({
      left: entry.alignRight
        ? Math.max(4, entry.x - width)
        : Math.max(4, Math.min(entry.x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(entry.y, window.innerHeight - height - 4)),
    })
  }, [entry.alignRight, entry.x, entry.y])

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
        return (
          <button
            key={index}
            type="button"
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            disabled={item.disabled}
            data-action={item.testId}
            onClick={() => {
              // close this menu and what it was opened from
              closePopup()
              item.action()
            }}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
