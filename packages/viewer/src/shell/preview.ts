import { popupStore, closeAbove, isKindOpen, openPopup } from '../popups'
import { shellStore } from '../state'
import { computeGroups } from './groups'

/** hover this long before a preview opens; once one is open, moving to another button switches right away */
const OPEN_DELAY_MS = 150
/** after hovering out of a button and its preview, close it after this long */
const CLOSE_DELAY_MS = 300

let timer: number | undefined

function clearTimer() {
  clearTimeout(timer)
  timer = undefined
}

/** Don't close the preview on the scheduled hover-out (the pointer moved onto the preview). */
export function cancelPreviewClose() {
  clearTimer()
}

function groupWithWindows(key: string): boolean {
  const state = shellStore.get()
  const group = computeGroups(state.windows, state.pinned, state.apps).find((g) => g.key === key)
  return group !== undefined && group.windows.length > 0
}

/** The overflow flyout of the taskbar (taskbar.tsx): previews of the buttons in it open above it, not instead. */
export const OVERFLOW_OWNER = 'taskbar-overflow'

/** How many popups at the bottom of the stack previews go above: the taskbar's overflow flyout, if it's open. */
function base(): number {
  return popupStore.get().stack[0]?.kind === 'overflow' ? 1 : 0
}

/** Put the open preview away (not the overflow flyout it may be over). */
export function closePreview() {
  clearTimer()
  const index = popupStore.get().stack.findIndex((popup) => popup.kind === 'preview')
  if (index >= 0) {
    closeAbove(index)
  }
}

/**
 * Where a button's previews go: under the button, or for a button in the overflow flyout, under the flyout (so they
 * don't cover its other buttons).
 */
function anchorRectOf(button: HTMLElement): DOMRect {
  const rect = button.getBoundingClientRect()
  const flyout = button.closest(`[data-popup-owner="${OVERFLOW_OWNER}"]`)
  if (flyout === null) {
    return rect
  }
  const bottom = flyout.getBoundingClientRect().bottom
  return new DOMRect(rect.left, rect.top, rect.width, bottom - rect.top)
}

/** Open the group's previews now (pinned: kept open until clicked elsewhere, not closed on hover-out). */
export function openPreview(key: string, button: HTMLElement, pinned: boolean) {
  clearTimer()
  if (!groupWithWindows(key)) {
    return
  }
  const anchorRect = anchorRectOf(button)
  const stack = popupStore.get().stack
  const index = stack.findIndex((popup) => popup.kind === 'preview' && popup.owner === key)
  if (index >= 0) {
    // already open for this group: update it (pinned or not) and drop what's above it
    const updated = [...stack]
    updated[index] = { kind: 'preview', owner: key, anchorRect, pinned }
    popupStore.update({ stack: updated })
    closeAbove(index + 1)
    return
  }
  closeAbove(base())
  openPopup({ kind: 'preview', owner: key, anchorRect, pinned }, true)
}

/**
 * Hovering a taskbar button: open its window previews after a delay. A preview that is already open switches to the
 * hovered group right away; other open popups (menus) are not covered.
 */
export function schedulePreviewOpen(key: string, button: HTMLElement, pointerType: string) {
  clearTimer()
  if (!groupWithWindows(key)) {
    if (isKindOpen('preview')) {
      schedulePreviewClose()
    }
    return
  }
  if (isKindOpen('preview')) {
    // already showing previews: switch right away
    openPreview(key, button, false)
    return
  }
  if (popupStore.get().stack.length > base()) {
    return
  }
  if (pointerType !== 'mouse') {
    return
  }
  timer = window.setTimeout(() => {
    // the stack may have changed since scheduling: a menu opened on right-click must not be covered
    if (popupStore.get().stack.length > base()) {
      return
    }
    openPreview(key, button, false)
  }, OPEN_DELAY_MS)
}

/**
 * Whether the open preview stays when the pointer leaves it: it's pinned by a click, or a menu opened from it (a card's
 * context menu, which the pointer moves onto) is open above it.
 */
function previewHeld(): boolean {
  const stack = popupStore.get().stack
  const index = stack.findIndex((popup) => popup.kind === 'preview')
  const preview = stack[index]
  return preview === undefined || (preview.kind === 'preview' && preview.pinned) || index < stack.length - 1
}

/** Left a taskbar button (or its preview): close it after a moment, unless it's held (see previewHeld). */
export function schedulePreviewClose() {
  clearTimer()
  if (previewHeld()) {
    return
  }
  timer = window.setTimeout(() => {
    if (!previewHeld()) {
      closePreview()
    }
  }, CLOSE_DELAY_MS)
}

/** The button of a taskbar group was clicked: toggle its pinned preview, or launch / (de)activate. */
export function previewPinnedFor(key: string): boolean {
  const preview = popupStore.get().stack.find((popup) => popup.kind === 'preview' && popup.owner === key)
  return preview !== undefined && preview.kind === 'preview' && preview.pinned
}

// a menu opened from the preview closed without acting (Escape): the preview goes too, unless the pointer is on it or
// on its button
let wasHeldByMenu = false
popupStore.subscribe(() => {
  const stack = popupStore.get().stack
  const index = stack.findIndex((popup) => popup.kind === 'preview')
  const heldByMenu = index >= 0 && index < stack.length - 1
  if (wasHeldByMenu && !heldByMenu && index >= 0) {
    const pointed = document.querySelector('#window-preview:hover, [data-group]:hover')
    if (pointed === null) {
      schedulePreviewClose()
    }
  }
  wasHeldByMenu = heldByMenu
})
