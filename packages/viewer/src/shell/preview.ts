import { popupStore, closeAbove, closePopup, isKindOpen, openPopup } from '../popups'
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

/** Open the group's previews now (pinned: kept open until clicked elsewhere, not closed on hover-out). */
export function openPreview(key: string, button: HTMLElement, pinned: boolean) {
  clearTimer()
  if (!groupWithWindows(key)) {
    return
  }
  const anchorRect = button.getBoundingClientRect()
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
  openPopup({ kind: 'preview', owner: key, anchorRect, pinned })
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
  if (popupStore.get().stack.length > 0) {
    return
  }
  if (pointerType !== 'mouse') {
    return
  }
  timer = window.setTimeout(() => {
    // the stack may have changed since scheduling: a menu opened on right-click must not be covered
    if (popupStore.get().stack.length > 0) {
      return
    }
    openPreview(key, button, false)
  }, OPEN_DELAY_MS)
}

/** Left a taskbar button (or its preview): close it after a moment, unless it's pinned by a click. */
export function schedulePreviewClose() {
  clearTimer()
  const preview = popupStore.get().stack.find((popup) => popup.kind === 'preview')
  if (preview === undefined || (preview.kind === 'preview' && preview.pinned)) {
    return
  }
  timer = window.setTimeout(() => {
    if (isKindOpen('preview')) {
      closePopup()
    }
  }, CLOSE_DELAY_MS)
}

/** The button of a taskbar group was clicked: toggle its pinned preview, or launch / (de)activate. */
export function previewPinnedFor(key: string): boolean {
  const preview = popupStore.get().stack.find((popup) => popup.kind === 'preview' && popup.owner === key)
  return preview !== undefined && preview.kind === 'preview' && preview.pinned
}
