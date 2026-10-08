import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import type { IconResolver } from '../shell/icons'
import { parseService, pickPixmap, stripMnemonics, TrayHost, TrayItemState, TrayMenuEntry } from '../shell/tray'
import { solidPixmap, TestTrayItem, TestWatcher } from '../test-fixtures/tray-item'

// a private session bus for the whole file
let busPid: number | undefined
before(() => {
  const [address, pid] = execFileSync(
    'dbus-daemon',
    ['--session', '--fork', '--nopidfile', '--print-address=1', '--print-pid=1'],
    {
      encoding: 'utf8',
    },
  )
    .trim()
    .split('\n')
  busPid = Number(pid)
  process.env.DBUS_SESSION_BUS_ADDRESS = address
})
after(() => {
  if (busPid) {
    process.kill(busPid)
  }
})

const noIcons = { resolve: () => null, resolveWithThemePath: () => null } as unknown as IconResolver

/** A tray host that records what it tells the viewer. */
function recordingHost(owns: (pid: number) => boolean = () => true) {
  const host = new TrayHost({ owns, icons: noIcons })
  const shown = new Map<string, TrayItemState>()
  const menus: { id: string; menu: TrayMenuEntry[]; show?: { x: number; y: number } }[] = []
  host.listener = {
    changed: (item) => shown.set(item.id, item),
    removed: (id) => shown.delete(id),
    menu: (id, menu, show) => menus.push({ id, menu, show }),
  }
  return { host, shown, menus }
}

async function until(what: string, condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('parseService reads a bus name, a name with a path, and a path (from the sender)', () => {
  assert.deepEqual(parseService(':1.42', ':1.9'), { busName: ':1.42', path: '/StatusNotifierItem' })
  assert.deepEqual(parseService('org.kde.StatusNotifierItem-12-1', ':1.9'), {
    busName: 'org.kde.StatusNotifierItem-12-1',
    path: '/StatusNotifierItem',
  })
  assert.deepEqual(parseService(':1.42/org/ayatana/NotificationItem/x', ':1.9'), {
    busName: ':1.42',
    path: '/org/ayatana/NotificationItem/x',
  })
  assert.deepEqual(parseService('/org/ayatana/NotificationItem/x', ':1.9'), {
    busName: ':1.9',
    path: '/org/ayatana/NotificationItem/x',
  })
  assert.equal(parseService('not a name', ':1.9'), undefined)
  assert.equal(parseService(':1.42/bad path', ':1.9'), undefined)
})

test('stripMnemonics drops single underscores and keeps escaped ones', () => {
  assert.equal(stripMnemonics('_File'), 'File')
  assert.equal(stripMnemonics('Save _As'), 'Save As')
  assert.equal(stripMnemonics('snake__case'), 'snake_case')
})

test('pickPixmap takes the size closest to 48 (larger preferred) and converts ARGB to RGBA', () => {
  const pixmap = pickPixmap([
    solidPixmap(16, [1, 2, 3, 4]),
    solidPixmap(64, [5, 6, 7, 8]),
    solidPixmap(32, [9, 9, 9, 9]),
  ])
  assert.equal(pixmap?.width, 64)
  assert.deepEqual([...pixmap!.rgba.subarray(0, 4)], [6, 7, 8, 5])
  // short data and silly sizes are skipped
  assert.equal(
    pickPixmap([
      [4, 4, Buffer.alloc(8)],
      [0, 0, Buffer.alloc(0)],
    ]),
    undefined,
  )
  assert.equal(pickPixmap('nonsense'), undefined)
})

test('as the watcher: an item shows with its icon and tooltip, clicks and menus reach it, and it goes with its app', async () => {
  const { host, shown, menus } = recordingHost()
  await host.start()
  const item = await TestTrayItem.start('First')
  try {
    await until('the item', () => shown.has(item.key))
    const state = shown.get(item.key)!
    assert.equal(state.title, 'First')
    assert.deepEqual(state.tooltip, { title: 'First tip', body: 'Tooltip body & more' })
    assert.equal(state.status, 'active')
    assert.equal(state.menu, true)
    assert.match(state.icon ?? '', /^data:image\/png;base64,/)

    // needing attention changes the icon
    item.needAttention()
    await until('the attention state', () => shown.get(item.key)?.status === 'attention')
    assert.notEqual(shown.get(item.key)!.icon, state.icon)

    await host.click(item.key, 'activate', 10, 20)
    await host.click(item.key, 'secondary', 11, 21)
    host.scroll(item.key, 120, 'vertical')
    await until('the clicks', () => item.events.includes('Scroll -120 vertical'))
    assert.ok(item.events.includes('Activate 10 20'))
    assert.ok(item.events.includes('SecondaryActivate 11 21'))

    // the menu: visible entries, mnemonics gone, toggles, a submenu, no hidden entry
    await host.click(item.key, 'context', 30, 40)
    assert.equal(menus.length, 1)
    assert.deepEqual(menus[0].show, { x: 30, y: 40 })
    assert.deepEqual(menus[0].menu, [
      { id: 1, label: 'Open Window', enabled: true },
      { id: 2, label: 'Enabled', enabled: true, toggle: 'checkmark', checked: true },
      { id: 3, separator: true },
      { id: 4, label: 'More', enabled: true, children: [{ id: 5, label: 'Sub entry', enabled: true }] },
      { id: 6, label: 'Disabled', enabled: false },
      { id: 8, label: 'Quit', enabled: true },
    ])
    assert.ok(item.events.includes('AboutToShow 0'))
    // a change while it's open is sent, without show
    item.addMenuEntry(9, 'Late')
    await until('the menu update', () => menus.length === 2)
    assert.equal(menus[1].show, undefined)
    assert.deepEqual(menus[1].menu.at(-1), { id: 9, label: 'Late', enabled: true })
    host.menuClicked(item.key, 8)
    host.menuClosed(item.key)
    await until('the menu events', () => item.events.includes('Event 0 closed'))
    assert.ok(item.events.includes('Event 8 clicked'))
    // closed: changes aren't sent anymore
    item.addMenuEntry(10, 'Later')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(menus.length, 2)

    item.close()
    await until('the item to go', () => !shown.has(item.key))
  } finally {
    item.close()
    host.stop()
  }
})

test("items of another desktop's processes aren't shown", async () => {
  const { host, shown } = recordingHost(() => false)
  await host.start()
  const item = await TestTrayItem.start('Foreign', 'name')
  try {
    // registering worked (the watcher has it), it's just not shown
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(shown.size, 0)
    assert.deepEqual(host.all, [])
  } finally {
    item.close()
    host.stop()
  }
})

test("with someone else's watcher the host follows it, and takes over when it ends", async () => {
  const watcher = await TestWatcher.start()
  const { host, shown } = recordingHost()
  await host.start()
  const item = await TestTrayItem.start('Followed')
  try {
    await until('the item through the other watcher', () => shown.has(item.key))
    assert.equal(watcher.hosts.length, 1)
    assert.deepEqual(watcher.items, [item.key])
    // the other watcher goes: we're next in line, the item registers again with us and stays
    watcher.close()
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.ok(shown.has(item.key))
    const second = await TestTrayItem.start('Second', 'name')
    try {
      await until('an item registered with us', () => shown.has(second.key))
    } finally {
      second.close()
    }
  } finally {
    item.close()
    watcher.close()
    host.stop()
  }
})
