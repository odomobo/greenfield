import { ShellWindow } from '../desktop'
import { ShellApp } from '../protocol'

/** A taskbar entry: a pinned app and/or the windows of one app. */
export type Group = { key: string; app?: ShellApp; windows: ShellWindow[]; pinned: boolean }

/** The installed app with a desktop file ID. */
export function appById(apps: ShellApp[], id: string | undefined): ShellApp | undefined {
  return id === undefined ? undefined : apps.find((app) => app.id === id)
}

/** The installed app a window belongs to, by its app_id. */
export function appForWindow(apps: ShellApp[], window: { appId: string }): ShellApp | undefined {
  const appId = window.appId
  if (!appId) {
    return undefined
  }
  const lower = appId.toLowerCase()
  return (
    apps.find((app) => app.id === `${appId}.desktop`) ??
    apps.find((app) => app.wmClass === appId) ??
    apps.find((app) => app.id.toLowerCase() === `${lower}.desktop`) ??
    apps.find((app) => app.wmClass?.toLowerCase() === lower) ??
    // reverse-DNS IDs: org.example.Foo.desktop for app_id foo
    apps.find((app) => app.id.toLowerCase().endsWith(`.${lower}.desktop`))
  )
}

/** The taskbar group a window belongs to (its app, or itself when unknown). */
export function groupKey(apps: ShellApp[], window: ShellWindow): string {
  return appForWindow(apps, window)?.id ?? `window:${window.appId || window.id}`
}

// The taskbar's order: pinned and running groups mixed, as the user dragged them. Pinned groups keep the order of the
// pinned list among themselves (that's what the session saves); the place of running ones is this viewer's own.
const groupOrder: string[] = []

// windows numbered in the order they first appeared, so a group's previews are in creation order (the scene's order is
// the stacking order, which changes whenever one is activated)
const windowOrder = new Map<string, number>()
let nextWindow = 0

/** Forget the group and window order (another session, see ShellController.start). */
export function resetGroupOrder(): void {
  groupOrder.length = 0
  windowOrder.clear()
}

/**
 * The taskbar's buttons were dragged into this order (group keys; groups not in it keep their places after these).
 * Returns the pinned list in the new order, for the session to save.
 */
export function setGroupOrder(keys: string[], pinned: string[]): string[] {
  const rest = groupOrder.filter((key) => !keys.includes(key))
  groupOrder.splice(0, groupOrder.length, ...keys, ...rest)
  const isPinned = new Set(pinned)
  const ordered = groupOrder.filter((key) => isPinned.has(key))
  // (pins without a button, e.g. an app that was uninstalled, stay at the end)
  return [...ordered, ...pinned.filter((id) => !ordered.includes(id))]
}

/** Window keys are "client/surface": a stand-in for creation order among windows that appeared at once (on attach). */
function compareKeys(a: string, b: string): number {
  const [clientA, surfaceA] = a.split('/').map(Number)
  const [clientB, surfaceB] = b.split('/').map(Number)
  return clientA - clientB || surfaceA - surfaceB || (a < b ? -1 : a > b ? 1 : 0)
}

/** The windows in the order they appeared. */
function inCreationOrder(windows: ShellWindow[]): ShellWindow[] {
  const ids = new Set(windows.map((window) => window.id))
  for (const id of [...windowOrder.keys()]) {
    if (!ids.has(id)) {
      windowOrder.delete(id)
    }
  }
  for (const id of [...ids].filter((id) => !windowOrder.has(id)).sort(compareKeys)) {
    windowOrder.set(id, nextWindow++)
  }
  return [...windows].sort((a, b) => windowOrder.get(a.id)! - windowOrder.get(b.id)!)
}

/**
 * The taskbar groups, in the taskbar's order (see groupOrder): at first the pinned apps in pin order, then running
 * groups in the order they first appeared; new ones are added at the end.
 */
export function computeGroups(windows: ShellWindow[], pinned: string[], apps: ShellApp[]): Group[] {
  const byKey = new Map<string, Group>()
  for (const id of pinned) {
    byKey.set(id, { key: id, app: appById(apps, id), windows: [], pinned: true })
  }
  for (const window of inCreationOrder(windows)) {
    const key = groupKey(apps, window)
    let group = byKey.get(key)
    if (group === undefined) {
      group = { key, app: appForWindow(apps, window), windows: [], pinned: false }
      byKey.set(key, group)
    }
    group.windows.push(window)
  }
  // the groups with a button: running ones, and pinned apps that are installed
  const shown = (key: string) => {
    const group = byKey.get(key)
    return group !== undefined && (group.windows.length > 0 || (group.pinned && group.app !== undefined))
  }
  // forget groups that are gone, add new ones at the end (pinned first, on attach)
  for (let i = groupOrder.length - 1; i >= 0; i--) {
    if (!shown(groupOrder[i])) {
      groupOrder.splice(i, 1)
    }
  }
  for (const key of byKey.keys()) {
    if (shown(key) && !groupOrder.includes(key)) {
      groupOrder.push(key)
    }
  }
  // the pinned groups' places hold them in pin order (the pinned list may have been reordered elsewhere)
  const pinnedInOrder = pinned.filter(shown)
  let nextPinned = 0
  return groupOrder.map((key) => byKey.get(byKey.get(key)!.pinned ? pinnedInOrder[nextPinned++] : key)!)
}

export function groupName(group: Group): string {
  return group.app?.name ?? group.windows[0]?.title ?? group.windows[0]?.appId ?? 'Window'
}
