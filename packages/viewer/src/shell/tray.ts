import { shellStore } from '../state'
import { ServerMessage, ShellTrayMenuItem, ViewerMessage } from '../protocol'
import { closePopupOf, isOpen, MenuItem, openPopup, popupStore, updateMenus } from '../popups'

/** The owner of a tray item's menu in the popup stack; its submenus' are this, a slash and the entry's id. */
export const trayMenuOwner = (item: string) => `tray-menu:${item}`

/**
 * The system tray's side of the shell controller: the session's tray items (shown by the taskbar), clicks and the wheel
 * on them, and their menus, shown as our own context menus (submenus nested), updated while open, and the session told
 * when they close.
 */
export class TrayController {
  /** the items whose menu is shown: the session hears when it closes */
  private readonly openMenus = new Set<string>()

  constructor(private readonly send: (message: ViewerMessage) => void) {
    popupStore.subscribe(() => {
      for (const item of [...this.openMenus]) {
        if (!isOpen(trayMenuOwner(item))) {
          this.openMenus.delete(item)
          this.send({ type: 'shell.tray-menu-closed', item })
        }
      }
    })
  }

  /** Another desktop, or none. */
  reset(): void {
    for (const item of this.openMenus) {
      closePopupOf(trayMenuOwner(item))
    }
    this.openMenus.clear()
    shellStore.update({ tray: [] })
  }

  /** Handles the tray's messages; false if it isn't one. */
  handleMessage(message: ServerMessage): boolean {
    switch (message.type) {
      case 'shell.tray':
        shellStore.update({ tray: message.items })
        return true
      case 'shell.tray-item': {
        const tray = shellStore.get().tray
        const index = tray.findIndex((item) => item.id === message.item.id)
        shellStore.update({
          tray: index < 0 ? [...tray, message.item] : tray.map((item, i) => (i === index ? message.item : item)),
        })
        return true
      }
      case 'shell.tray-item-removed':
        closePopupOf(trayMenuOwner(message.id))
        shellStore.update({ tray: shellStore.get().tray.filter((item) => item.id !== message.id) })
        return true
      case 'shell.tray-menu':
        this.menu(message.item, message.menu, message.show)
        return true
    }
    return false
  }

  /** A click on an item: activate (left), secondary (middle) or context (right); x, y: where its menu would go. */
  click(item: string, action: 'activate' | 'secondary' | 'context', x: number, y: number): void {
    this.send({ type: 'shell.tray-activate', item, action, x, y })
  }

  /** The wheel over an item, in wheel units (120 per click). */
  scroll(item: string, delta: number, orientation: 'vertical' | 'horizontal'): void {
    this.send({ type: 'shell.tray-scroll', item, delta, orientation })
  }

  private menu(item: string, menu: ShellTrayMenuItem[], show: { x: number; y: number } | undefined): void {
    if (!shellStore.get().tray.some((trayItem) => trayItem.id === item)) {
      return
    }
    const owner = trayMenuOwner(item)
    if (show) {
      if (isOpen(owner)) {
        closePopupOf(owner)
      }
      openPopup({ kind: 'context', owner, items: this.menuItems(item, menu), x: show.x, y: show.y, nested: false })
      this.openMenus.add(item)
      return
    }
    // an update of the open menu and its open submenus
    updateMenus((popupOwner) => {
      if (popupOwner === owner) {
        return this.menuItems(item, menu)
      }
      if (popupOwner.startsWith(owner + '/')) {
        const entry = findEntry(menu, Number(popupOwner.slice(owner.length + 1)))
        return entry && 'label' in entry ? this.menuItems(item, entry.children ?? []) : []
      }
      return undefined
    })
  }

  private menuItems(item: string, entries: ShellTrayMenuItem[]): MenuItem[] {
    return entries.map((entry): MenuItem => {
      if ('separator' in entry) {
        return { separator: true }
      }
      return {
        label: entry.label,
        disabled: !entry.enabled,
        toggle: entry.toggle,
        checked: entry.checked,
        icon: entry.icon,
        testId: `entry-${entry.id}`,
        action: () => this.send({ type: 'shell.tray-menu-event', item, id: entry.id }),
        submenu: entry.children && {
          owner: `${trayMenuOwner(item)}/${entry.id}`,
          items: this.menuItems(item, entry.children),
          onOpen: () => this.send({ type: 'shell.tray-submenu', item, id: entry.id }),
        },
      }
    })
  }
}

function findEntry(entries: ShellTrayMenuItem[], id: number): ShellTrayMenuItem | undefined {
  for (const entry of entries) {
    if (entry.id === id) {
      return entry
    }
    const found = 'children' in entry && entry.children ? findEntry(entry.children, id) : undefined
    if (found) {
      return found
    }
  }
  return undefined
}
