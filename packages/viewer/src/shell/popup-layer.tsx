import { useLayoutEffect, useRef, useState } from 'react'
import { closePopup, usePopupStack } from '../popups'
import type { ContextPopup, PreviewPopup } from '../popups'
import { WindowPreview } from './previews'

/**
 * Renders the popups that come and go (see popups.ts): context menus and window previews, in stack order (a nested
 * one above its parent). The Apps menu and the notification panel stay in the document (hidden when closed) and are
 * rendered by the desktop view.
 */
export function PopupLayer() {
  const entries = usePopupStack()
  return (
    <>
      {entries.map((entry, index) => {
        if (entry.kind === 'context') {
          return <ContextMenu key={index} entry={entry} />
        }
        if (entry.kind === 'preview') {
          return <WindowPreview key={index} entry={entry} />
        }
        return null
      })}
    </>
  )
}

/** A context menu at a point (page coordinates), kept inside the window. */
function ContextMenu({ entry }: { entry: ContextPopup }) {
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
      id={entry.menuId}
      className="context-menu flyout"
      role="menu"
      data-popup-owner={entry.owner}
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
