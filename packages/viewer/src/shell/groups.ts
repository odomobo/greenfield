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

// running groups in the order they first appeared, so buttons don't jump around
const groupOrder: string[] = []

/** Forget the group order (another session, see ShellController.start). */
export function resetGroupOrder(): void {
  groupOrder.length = 0
}

/**
 * The taskbar groups: pinned apps first (in pin order), then running groups in the order they first appeared.
 */
export function computeGroups(windows: ShellWindow[], pinned: string[], apps: ShellApp[]): Group[] {
  const byKey = new Map<string, Group>()
  for (const id of pinned) {
    byKey.set(id, { key: id, app: appById(apps, id), windows: [], pinned: true })
  }
  for (const window of windows) {
    const key = groupKey(apps, window)
    let group = byKey.get(key)
    if (group === undefined) {
      group = { key, app: appForWindow(apps, window), windows: [], pinned: false }
      byKey.set(key, group)
    }
    group.windows.push(window)
    if (!groupOrder.includes(key)) {
      groupOrder.push(key)
    }
  }
  const pinnedGroups = pinned
    .map((id) => byKey.get(id)!)
    .filter((group) => group.app || group.windows.length > 0)
  const running = groupOrder
    .map((key) => byKey.get(key))
    .filter((group): group is Group => group !== undefined && !group.pinned && group.windows.length > 0)
  // forget groups that are gone
  for (let i = groupOrder.length - 1; i >= 0; i--) {
    if (!byKey.get(groupOrder[i])?.windows.length) {
      groupOrder.splice(i, 1)
    }
  }
  return [...pinnedGroups, ...running]
}

export function groupName(group: Group): string {
  return group.app?.name ?? group.windows[0]?.title ?? group.windows[0]?.appId ?? 'Window'
}
