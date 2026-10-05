/**
 * nebula's desktop settings: the one place that says what the desktop supplies to its apps (GSettings keys, by schema).
 * Everything that serves them is generated from here: today the dconf defaults database of our sessions (below), later
 * the nebula Settings backend of xdg-desktop-portal (ROADMAP 4c step 4), so both give the same values.
 *
 * Apps that read GSettings (GTK before 4.21 outside Flatpak, Chrome through GTK) get them through a dconf profile
 * whose first layer is the user's own database (what the user set explicitly wins, writes go there as usual) above a
 * defaults database of ours. Nothing machine-wide is touched and other desktops of the user don't see any of it.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** schema id -> key -> string value (the type all current settings have; enums such as the color scheme are strings) */
export type DesktopSettings = Record<string, Record<string, string>>

export const nebulaDesktopSettings: DesktopSettings = {
  'org.gnome.desktop.wm.preferences': {
    // Windows style, like our window frames: GTK and Chrome draw these in their own title bars
    'button-layout': ':minimize,maximize,close',
  },
}

/** `org.gnome.desktop.wm.preferences` -> `/org/gnome/desktop/wm/preferences/` (the dconf path of a schema, as GNOME's) */
export function schemaPath(schema: string): string {
  return `/${schema.replaceAll('.', '/')}/`
}

/** The settings as a dconf keyfile (what `dconf compile` reads: for the install script and for inspection) */
export function toKeyfile(settings: DesktopSettings = nebulaDesktopSettings): string {
  return Object.entries(settings)
    .map(
      ([schema, keys]) =>
        `[${schemaPath(schema).slice(1, -1)}]\n` +
        Object.entries(keys)
          .map(([key, value]) => `${key}='${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'\n`)
          .join(''),
    )
    .join('\n')
}

/** dconf key path -> string value */
function flatten(settings: DesktopSettings): Map<string, string> {
  const map = new Map<string, string>()
  for (const [schema, keys] of Object.entries(settings)) {
    for (const [key, value] of Object.entries(keys)) {
      map.set(schemaPath(schema) + key, value)
    }
  }
  return map
}

/** GVDB's string hash (gvdb_hash_value: djb2 style over signed chars) */
export function gvdbHash(key: string): number {
  let hash = 5381
  for (const byte of Buffer.from(key, 'utf8')) {
    hash = (Math.imul(hash, 33) + (byte > 127 ? byte - 256 : byte)) >>> 0
  }
  return hash
}

/**
 * The settings as a dconf database (GVDB file, little endian, what `dconf compile` writes), so no dconf command line
 * tool is needed (dconf-cli isn't installed by default). Every key is a variant holding a string.
 */
export function toDconfDatabase(settings: DesktopSettings = nebulaDesktopSettings): Buffer {
  type Item = { key: string; children: string[]; value?: Buffer; hash: number }
  const items = new Map<string, Item>()
  items.set('/', { key: '/', children: [], hash: gvdbHash('/') })
  for (const [keyPath, value] of flatten(settings)) {
    const parts = keyPath.slice(1).split('/')
    let dir = '/'
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1
      const key = dir + part + (leaf ? '' : '/')
      if (!items.has(key)) {
        items.set(key, { key, children: [], hash: gvdbHash(key) })
        items.get(dir)!.children.push(key)
      }
      dir = key
    })
    // a serialized variant of type 's': the string with its NUL, the NUL separator, the type
    items.get(keyPath)!.value = Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0, 0, 0x73])])
  }

  // items sit in buckets (hash modulo the bucket count; one bucket per item), a lookup scans its bucket
  const nBuckets = items.size
  const sorted = [...items.values()].sort((a, b) => (a.hash % nBuckets) - (b.hash % nBuckets))
  const index = new Map(sorted.map((item, i) => [item.key, i]))
  const parentOf = (key: string): string | undefined => {
    if (key === '/') return undefined
    const trimmed = key.endsWith('/') ? key.slice(0, -1) : key
    return trimmed.slice(0, trimmed.lastIndexOf('/') + 1)
  }

  const tableStart = 24
  const bucketsStart = tableStart + 8
  const itemsStart = bucketsStart + 4 * nBuckets
  let end = itemsStart + 24 * sorted.length
  const chunks: { at: number; data: Buffer }[] = []
  const place = (data: Buffer, align: number): [number, number] => {
    end = Math.ceil(end / align) * align
    const at = end
    chunks.push({ at, data })
    end += data.length
    return [at, end]
  }

  const records = sorted.map((item) => {
    const parentKey = parentOf(item.key)
    const keyName = Buffer.from(item.key.slice(parentKey === undefined ? 0 : parentKey.length), 'utf8')
    const [keyStart] = place(keyName, 1)
    let valueRange: [number, number]
    let type: string
    if (item.value !== undefined) {
      type = 'v'
      valueRange = place(item.value, 8)
    } else {
      type = 'L'
      const list = Buffer.alloc(4 * item.children.length)
      item.children.forEach((child, i) => list.writeUInt32LE(index.get(child)!, 4 * i))
      valueRange = place(list, 4)
    }
    return { item, parentKey, keyStart, keySize: keyName.length, type, valueRange }
  })

  const file = Buffer.alloc(end)
  file.write('GVariant', 0, 'latin1') // signature; version 0 and options 0 stay zero
  file.writeUInt32LE(tableStart, 16)
  file.writeUInt32LE(itemsStart + 24 * sorted.length, 20)
  file.writeUInt32LE((5 << 27) >>> 0, tableStart) // no bloom filter words, bloom shift 5
  file.writeUInt32LE(nBuckets, tableStart + 4)
  const firstOfBucket = new Array<number>(nBuckets).fill(sorted.length)
  sorted.forEach((item, i) => {
    const bucket = item.hash % nBuckets
    firstOfBucket[bucket] = Math.min(firstOfBucket[bucket], i)
  })
  // an empty bucket starts where the next non-empty one does
  for (let b = nBuckets - 2; b >= 0; b--) {
    firstOfBucket[b] = Math.min(firstOfBucket[b], firstOfBucket[b + 1])
  }
  firstOfBucket.forEach((first, b) => file.writeUInt32LE(first, bucketsStart + 4 * b))
  records.forEach((r, i) => {
    const at = itemsStart + 24 * i
    file.writeUInt32LE(r.item.hash, at)
    file.writeUInt32LE(r.parentKey === undefined ? 0xffffffff : index.get(r.parentKey)!, at + 4)
    file.writeUInt32LE(r.keyStart, at + 8)
    file.writeUInt16LE(r.keySize, at + 12)
    file.write(r.type, at + 14, 'latin1')
    file.writeUInt32LE(r.valueRange[0], at + 16)
    file.writeUInt32LE(r.valueRange[1], at + 20)
  })
  for (const chunk of chunks) {
    chunk.data.copy(file, chunk.at)
  }
  return file
}

/**
 * Where the profile and the defaults database live: one place for all users and sessions, generated by the build
 * (`dist/dconf`) and by the install script where nebula is installed (`node dist/build-dconf.js`), since the profile
 * names the database by its absolute path.
 */
export const dconfDir = path.resolve(__dirname, 'dconf')

/**
 * Writes the dconf profile and the defaults database into `dir` and returns the profile's path for `DCONF_PROFILE`.
 * Written to temporary names and renamed, so running sessions never see half a file.
 */
export function writeDconfProfile(dir: string, settings: DesktopSettings = nebulaDesktopSettings): string {
  mkdirSync(dir, { recursive: true })
  const database = path.join(dir, 'defaults.db')
  const profile = path.join(dir, 'profile')
  const suffix = `.${process.pid}.tmp`
  writeFileSync(database + suffix, toDconfDatabase(settings))
  renameSync(database + suffix, database)
  // the user's own database first: what they set wins and writes go there; ours below it
  writeFileSync(profile + suffix, profileText(database))
  renameSync(profile + suffix, profile)
  return profile
}

/** The profile's contents for the defaults database at `database` */
export function profileText(database: string): string {
  return `user-db:user\nfile-db:${database}\n`
}
