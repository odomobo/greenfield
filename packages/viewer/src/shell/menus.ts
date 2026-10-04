import { Desktop, ShellWindow } from '../desktop'
import { MenuItem } from '../popups'
import { Group, groupName } from './groups'
import type { ShellController } from './shell'

/**
 * The context menus of the taskbar: the menu of a window (from a preview card or the single window of a group) and
 * the menu of a taskbar group.
 */
export function windowMenuItems(window: ShellWindow, desktop: Desktop): MenuItem[] {
  return [
    window.shownMinimized
      ? { label: 'Restore', action: () => desktop.activateWindow(window.id), testId: 'restore' }
      : { label: 'Minimize', action: () => desktop.minimizeWindow(window.id), testId: 'minimize' },
    window.maximized
      ? { label: 'Restore down', action: () => desktop.setMaximized(window.id, false), testId: 'unmaximize' }
      : { label: 'Maximize', action: () => desktop.setMaximized(window.id, true), testId: 'maximize' },
    {
      label: 'Move',
      action: () => desktop.startMenuMove(window.id),
      disabled: !desktop.canMoveOrSize(window.id),
      testId: 'move',
    },
    {
      label: 'Size',
      action: () => desktop.startMenuSize(window.id),
      disabled: !desktop.canMoveOrSize(window.id),
      testId: 'size',
    },
    { label: 'Close window', action: () => desktop.closeWindow(window.id), testId: 'close' },
  ]
}

export function groupMenuItems(
  group: Group,
  shell: ShellController,
  desktop: Desktop,
): MenuItem[] {
  const items: MenuItem[] = [{ heading: groupName(group) }]
  if (group.app) {
    const app = group.app
    items.push({
      label: group.windows.length ? 'New window' : 'Open',
      action: () => shell.launch(app.id),
      testId: 'launch',
    })
    items.push({
      label: group.pinned ? 'Unpin from taskbar' : 'Pin to taskbar',
      action: () => shell.togglePin(app.id),
      testId: group.pinned ? 'unpin' : 'pin',
    })
  }
  if (group.windows.length === 1) {
    items.push({ separator: true }, ...windowMenuItems(group.windows[0], desktop))
  } else if (group.windows.length > 1) {
    items.push(
      { separator: true },
      {
        label: 'Close all windows',
        action: () => group.windows.forEach((window) => desktop.closeWindow(window.id)),
        testId: 'close-all',
      },
    )
  }
  return items
}
