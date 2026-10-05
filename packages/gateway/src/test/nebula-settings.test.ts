import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  gvdbHash,
  nebulaDesktopSettings,
  schemaPath,
  toDconfDatabase,
  toKeyfile,
  writeDconfProfile,
} from '../nebula-settings'

/** A minimal GVDB reader, the way dconf's lookups work: hash, bucket, compare the key rebuilt from the parent chain. */
function lookup(db: Buffer, key: string): Buffer | undefined {
  assert.equal(db.subarray(0, 8).toString('latin1'), 'GVariant')
  const tableStart = db.readUInt32LE(16)
  const tableEnd = db.readUInt32LE(20)
  const nBloomWords = db.readUInt32LE(tableStart) & 0x7ffffff
  const nBuckets = db.readUInt32LE(tableStart + 4)
  const bucketsStart = tableStart + 8 + 4 * nBloomWords
  const itemsStart = bucketsStart + 4 * nBuckets
  const nItems = (tableEnd - itemsStart) / 24
  assert.ok(Number.isInteger(nItems))
  const fullKey = (i: number): string => {
    const at = itemsStart + 24 * i
    const parent = db.readUInt32LE(at + 4)
    const start = db.readUInt32LE(at + 8)
    const name = db.subarray(start, start + db.readUInt16LE(at + 12)).toString('utf8')
    return (parent === 0xffffffff ? '' : fullKey(parent)) + name
  }
  const hash = gvdbHash(key)
  const bucket = hash % nBuckets
  const first = db.readUInt32LE(bucketsStart + 4 * bucket)
  const last = bucket + 1 < nBuckets ? db.readUInt32LE(bucketsStart + 4 * (bucket + 1)) : nItems
  for (let i = first; i < last; i++) {
    const at = itemsStart + 24 * i
    if (db.readUInt32LE(at) === hash && fullKey(i) === key) {
      assert.equal(String.fromCharCode(db[at + 14]), 'v')
      return db.subarray(db.readUInt32LE(at + 16), db.readUInt32LE(at + 20))
    }
  }
  return undefined
}

test('the button layout is Windows style', () => {
  assert.equal(nebulaDesktopSettings['org.gnome.desktop.wm.preferences']['button-layout'], ':minimize,maximize,close')
})

test('schema ids become dconf paths', () => {
  assert.equal(schemaPath('org.gnome.desktop.wm.preferences'), '/org/gnome/desktop/wm/preferences/')
})

test('the keyfile is what dconf compile reads', () => {
  assert.equal(toKeyfile(), "[org/gnome/desktop/wm/preferences]\nbutton-layout=':minimize,maximize,close'\n")
  assert.match(toKeyfile({ 'a.b': { k: "it's" } }), /k='it\\'s'/)
})

test('the gvdb hash is the one dconf uses', () => {
  assert.equal(gvdbHash('/'), 0x2b5d4)
})

test('the database holds the settings as string variants (read like dconf does)', () => {
  const db = toDconfDatabase()
  const value = lookup(db, '/org/gnome/desktop/wm/preferences/button-layout')
  assert.ok(value)
  assert.equal(Buffer.compare(value, Buffer.from(":minimize,maximize,close\0\0s")), 0)
  assert.equal(lookup(db, '/org/gnome/desktop/wm/preferences/other'), undefined)
})

test('several schemas and keys all resolve', () => {
  const db = toDconfDatabase({
    'org.gnome.desktop.interface': { 'color-scheme': 'prefer-dark', 'gtk-theme': 'Adwaita' },
    'org.gnome.desktop.wm.preferences': { 'button-layout': ':close' },
    'org.x': { k: 'v' },
  })
  const text = (key: string) => lookup(db, key)?.subarray(0, -3).toString()
  assert.equal(text('/org/gnome/desktop/interface/color-scheme'), 'prefer-dark')
  assert.equal(text('/org/gnome/desktop/interface/gtk-theme'), 'Adwaita')
  assert.equal(text('/org/gnome/desktop/wm/preferences/button-layout'), ':close')
  assert.equal(text('/org/x/k'), 'v')
})

test('the profile has the user layer first, then our defaults', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nebula-dconf-'))
  try {
    const profile = writeDconfProfile(path.join(dir, 'sub'))
    assert.ok(path.isAbsolute(profile))
    const lines = readFileSync(profile, 'utf8').trim().split('\n')
    assert.deepEqual(lines, ['user-db:user', `file-db:${path.join(dir, 'sub', 'defaults.db')}`])
    assert.deepEqual(readFileSync(path.join(dir, 'sub', 'defaults.db')), toDconfDatabase())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
