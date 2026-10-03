import { useSyncExternalStore } from 'react'
import { createStore } from './store'

/**
 * Popups of the shell (context menus, the Apps menu, previews, the notification panel): one open at a time, closed by
 * pointing elsewhere, Escape, or opening another.
 *
 * The open popups live in a store, so React renders them (see shell/popup-layer.tsx); this module only manages the
 * stack. Popups mark their root element with data-popup-owner, anchors with data-popup-anchor, which is how the
 * outside-click logic finds the DOM of a popup and how anchored elements learn that they are open.
 */
export type MenuItem =
  | { label: string; action: () => void; danger?: boolean; testId?: string }
  | { separator: true }
  | { heading: string }

/** A context menu at a point (page coordinates). alignRight: x is the menu's right edge (under its button). */
export type ContextPopup = {
  kind: 'context'
  owner: string
  items: MenuItem[]
  x: number
  y: number
  nested: boolean
  alignRight?: boolean
  /** id for the menu element (e.g. #session-menu) */
  menuId?: string
}

export type AppsPopup = { kind: 'apps'; owner: 'apps-button' }

export type NotificationsPopup = { kind: 'notifications'; owner: 'notifications-button' }

/** Window previews of a taskbar group, under the group's button. pinned: stay until clicked/closed, not on hover-out. */
export type PreviewPopup = { kind: 'preview'; owner: string; anchorRect: DOMRect; pinned: boolean }

export type PopupEntry = ContextPopup | AppsPopup | NotificationsPopup | PreviewPopup

type PopupState = { stack: PopupEntry[] }

export const popupStore = createStore<PopupState>({ stack: [] })

function stack(): PopupEntry[] {
  return popupStore.get().stack
}

/** Subscribe a component to the open popups (the stack), e.g. for open states of anchored buttons. */
export function usePopupStack(): PopupEntry[] {
  return useSyncExternalStore(popupStore.subscribe, () => popupStore.get().stack)
}

/** Close popups above the first `keep`. */
export function closeAbove(keep: number) {
  const current = stack()
  if (current.length > keep) {
    popupStore.update({ stack: current.slice(0, keep) })
  }
}

/** Close all popups. */
export function closePopup(): void {
  closeAbove(0)
}

/** Whether a popup owned by `owner` is open (e.g. an anchored button shows its open state). */
export function isOpen(owner: string): boolean {
  return stack().some((popup) => popup.owner === owner)
}

/** Whether a popup of the given kind is open. */
export function isKindOpen(kind: PopupEntry['kind']): boolean {
  return stack().some((popup) => popup.kind === kind)
}

/** Show `entry` as the open popup, or, if it (by owner and kind) is already open, only close what's above it. */
export function openPopup(entry: PopupEntry, nested = false): void {
  const current = stack()
  const index = current.findIndex((popup) => popup.owner === entry.owner && popup.kind === entry.kind)
  if (index >= 0) {
    closeAbove(index + 1)
    return
  }
  if (!nested) {
    closePopup()
  }
  // re-read the stack: closePopup() above changed it, and a stale copy would resurrect closed popups
  popupStore.update({ stack: [...stack(), entry] })
}

function popupElement(popup: PopupEntry): Element | null {
  return document.querySelector(`[data-popup-owner="${CSS.escape(popup.owner)}"]`)
}

function anchorElement(popup: PopupEntry): Element | null {
  return document.querySelector(`[data-popup-anchor="${CSS.escape(popup.owner)}"]`)
}

document.addEventListener(
  'pointerdown',
  (event) => {
    const target = event.target as Node
    // keep the popups up to the innermost one the pointer is in
    let keep = 0
    stack().forEach((popup, index) => {
      if (popupElement(popup)?.contains(target) || anchorElement(popup)?.contains(target)) {
        keep = index + 1
      }
    })
    closeAbove(keep)
  },
  { capture: true },
)

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && stack().length > 0) {
    closeAbove(stack().length - 1)
  }
})
