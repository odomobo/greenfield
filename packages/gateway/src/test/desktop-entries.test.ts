import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadDesktopEntries } from '../shell/desktop-entries'

function entry(name: string, extra = ''): string {
  return `[Desktop Entry]\nType=Application\nName=${name}\nExec=${name.toLowerCase()}\n${extra}\n`
}

function visibleIn(desktop: string | undefined): string[] {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nebula-entries-'))
  try {
    const apps = path.join(root, 'applications')
    mkdirSync(apps)
    writeFileSync(path.join(apps, 'plain.desktop'), entry('Plain'))
    writeFileSync(path.join(apps, 'gnome-only.desktop'), entry('GnomeOnly', 'OnlyShowIn=GNOME;'))
    writeFileSync(path.join(apps, 'kde-only.desktop'), entry('KdeOnly', 'OnlyShowIn=KDE;'))
    writeFileSync(path.join(apps, 'nebula-only.desktop'), entry('NebulaOnly', 'OnlyShowIn=nebula;'))
    writeFileSync(path.join(apps, 'not-gnome.desktop'), entry('NotGnome', 'NotShowIn=GNOME;'))
    writeFileSync(path.join(apps, 'not-nebula.desktop'), entry('NotNebula', 'NotShowIn=nebula;'))
    const env: NodeJS.ProcessEnv = { HOME: root, XDG_DATA_HOME: root, XDG_DATA_DIRS: path.join(root, 'none') }
    if (desktop !== undefined) {
      env.XDG_CURRENT_DESKTOP = desktop
    }
    return loadDesktopEntries(env)
      .map((e) => e.name)
      .sort()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('in a nebula session, GNOME- and KDE-only entries are hidden, NotShowIn=GNOME shown', () => {
  assert.deepEqual(visibleIn('nebula'), ['NebulaOnly', 'NotGnome', 'Plain'])
})

test('OnlyShowIn=nebula and NotShowIn=nebula follow the session desktop', () => {
  const names = visibleIn('nebula')
  assert.ok(names.includes('NebulaOnly'))
  assert.ok(!names.includes('NotNebula'))
})

test('GNOME sessions still see GNOME-only entries', () => {
  assert.deepEqual(visibleIn('GNOME'), ['GnomeOnly', 'NotNebula', 'Plain'])
})

test('without XDG_CURRENT_DESKTOP only unrestricted and NotShowIn entries show', () => {
  assert.deepEqual(visibleIn(undefined), ['NotGnome', 'NotNebula', 'Plain'])
})

test('the shipped portals.conf is named after the session desktop', () => {
  assert.ok(existsSync(path.resolve(__dirname, '../../xdg/xdg-desktop-portal/nebula-portals.conf')))
  assert.ok(!existsSync(path.resolve(__dirname, '../../xdg/xdg-desktop-portal/greenfield-portals.conf')))
})
