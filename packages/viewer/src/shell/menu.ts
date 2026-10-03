/**
 * Popups of the shell (context menus, the Apps menu, previews, the notification panel): one open at a time, closed by
 * pointing elsewhere, Escape, or opening another.
 */
export type MenuItem =
  | { label: string; action: () => void; danger?: boolean; testId?: string }
  | { separator: true }
  | { heading: string }

type Popup = { element: HTMLElement; anchor?: HTMLElement; onClose?: () => void }

/** open popups, a nested one (e.g. a context menu inside the Apps menu) above its parent */
const stack: Popup[] = []

function close(popup: Popup) {
  popup.element.hidden = true
  popup.anchor?.classList.remove('open')
  popup.anchor?.setAttribute('aria-expanded', 'false')
  if (popup.element.dataset.transient === 'true') {
    popup.element.remove()
  }
  popup.onClose?.()
}

/** Close popups above the first `keep`. */
function closeAbove(keep: number) {
  while (stack.length > keep) {
    close(stack.pop()!)
  }
}

/** Close all popups. */
export function closePopup(): void {
  closeAbove(0)
}

export function isOpen(element: HTMLElement): boolean {
  return stack.some((popup) => popup.element === element)
}

/** Show `element` (already in the document) as the open popup, or nested in the open one. */
export function openPopup(element: HTMLElement, anchor?: HTMLElement, onClose?: () => void, nested = false): void {
  const index = stack.findIndex((popup) => popup.element === element)
  if (index >= 0) {
    closeAbove(index + 1)
    return
  }
  if (!nested) {
    closePopup()
  }
  stack.push({ element, anchor, onClose })
  element.hidden = false
  anchor?.classList.add('open')
  anchor?.setAttribute('aria-expanded', 'true')
}

document.addEventListener(
  'pointerdown',
  (event) => {
    const target = event.target as Node
    // keep the popups up to the innermost one the pointer is in
    let keep = 0
    stack.forEach((popup, index) => {
      if (popup.element.contains(target) || popup.anchor?.contains(target)) {
        keep = index + 1
      }
    })
    closeAbove(keep)
  },
  { capture: true },
)

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && stack.length > 0) {
    closeAbove(stack.length - 1)
  }
})

/** A context menu at a point (page coordinates), kept inside the window. */
export function showContextMenu(
  items: MenuItem[],
  x: number,
  y: number,
  anchor?: HTMLElement,
  nested = false,
): HTMLElement {
  const menu = document.createElement('div')
  menu.className = 'context-menu flyout'
  menu.setAttribute('role', 'menu')
  menu.dataset.transient = 'true'
  for (const item of items) {
    if ('separator' in item) {
      const separator = document.createElement('div')
      separator.className = 'separator'
      menu.append(separator)
    } else if ('heading' in item) {
      const heading = document.createElement('div')
      heading.className = 'heading'
      heading.textContent = item.heading
      menu.append(heading)
    } else {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.textContent = item.label
      if (item.testId) {
        button.dataset.action = item.testId
      }
      if (item.danger) {
        button.classList.add('danger')
      }
      button.addEventListener('click', () => {
        // close this menu and what it was opened from
        closePopup()
        item.action()
      })
      menu.append(button)
    }
  }
  document.body.append(menu)
  const width = menu.offsetWidth
  const height = menu.offsetHeight
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`
  openPopup(menu, anchor, undefined, nested)
  return menu
}
