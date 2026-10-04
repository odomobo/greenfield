import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileDragNative, FileDrops, MAX_DROP_BYTES, safeFileName } from '../FileDrops.js'

class FakeNative implements FileDragNative {
  readonly calls: string[] = []
  accepted = true
  provided: string[] = []
  startFileDrag(sid: number) {
    this.calls.push(`start ${sid}`)
    return sid !== 99
  }
  fileDragAccepted() {
    return this.accepted
  }
  dropFileDrag() {
    this.calls.push('drop')
  }
  cancelFileDrag() {
    this.calls.push('cancel')
  }
  provideFiles(list: string) {
    this.calls.push('provide')
    this.provided.push(list)
  }
}

let directory: string
let native: FakeNative
let drops: FileDrops
let motions: unknown[]

const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(condition(), 'timed out')
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'gfld-drops-'))
  native = new FakeNative()
  motions = []
  drops = new FileDrops(
    native,
    (target) => motions.push(target),
    (surface) => (surface === 'a/1' ? 1 : surface === 'a/99' ? 99 : undefined),
    path.join(directory, 'drops'),
    100,
  )
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const target = (extra: object = {}) => ({
  type: 'file-drop',
  surface: 'a/1',
  sx: 3,
  sy: 4,
  x: 3,
  y: 4,
  time: 7,
  ...extra,
})

test('files over a surface start one drag and move it; leaving cancels it', () => {
  drops.over(target())
  drops.over(target())
  assert.deepEqual(native.calls, ['start 1'])
  assert.equal(motions.length, 2)
  drops.leave()
  drops.leave()
  assert.deepEqual(native.calls, ['start 1', 'cancel'])
})

test('nothing starts over the desktop, or where the core refuses', () => {
  drops.over(target({ surface: null }))
  drops.over(target({ surface: 'a/99' }))
  assert.deepEqual(native.calls, ['start 99'])
  assert.equal(motions.length, 0)
})

test('a drop saves the files and gives the app their URIs once they are all there', async () => {
  const files = [
    { id: 1, name: 'hello world.txt', size: 11 },
    { id: 2, name: 'empty', size: 0 },
    { id: 3, name: '../evil/../name', size: 2 },
  ]
  drops.drop(target({ files }))
  drops.chunk(1, Buffer.from('hello '))
  await waitFor(() => native.calls.includes('drop'))
  // the app took the drop while the files are still coming
  assert.equal(native.provided.length, 0)
  drops.chunk(1, Buffer.from('world and more that is not announced'))
  drops.chunk(3, Buffer.from('ok'))
  await waitFor(() => native.provided.length === 1)
  const uris = native.provided[0].split('\r\n')
  assert.equal(native.provided.length, 1)
  assert.equal(uris.pop(), '')
  assert.equal(uris.length, 3)
  const paths = uris.map((uri) => fileURLToPath(uri))
  assert.equal(path.basename(paths[0]), 'hello world.txt')
  assert.match(uris[0], /hello%20world\.txt$/)
  assert.equal(readFileSync(paths[0], 'utf8'), 'hello world')
  assert.equal(readFileSync(paths[1], 'utf8'), '')
  assert.equal(path.basename(paths[2]), '.._evil_.._name')
  assert.equal(readFileSync(paths[2], 'utf8'), 'ok')
  // all in one directory of this drop, inside the drops directory
  assert.equal(new Set(paths.map((p) => path.dirname(p))).size, 1)
  assert.equal(path.dirname(path.dirname(paths[0])), path.join(directory, 'drops'))
})

test('the same names in one drop get numbers', async () => {
  drops.drop(
    target({
      files: [
        { id: 5, name: 'a.txt', size: 1 },
        { id: 6, name: 'a.txt', size: 1 },
      ],
    }),
  )
  drops.chunk(5, Buffer.from('1'))
  drops.chunk(6, Buffer.from('2'))
  await waitFor(() => native.provided.length === 1)
  const names = native.provided[0]
    .split('\r\n')
    .filter(Boolean)
    .map((uri) => path.basename(fileURLToPath(uri)))
  assert.deepEqual(names, ['a.txt', 'a.txt (2)'])
})

test('a drop nobody accepts is cancelled', async () => {
  native.accepted = false
  drops.drop(target({ files: [{ id: 1, name: 'a', size: 0 }] }))
  await waitFor(() => native.calls.includes('cancel'))
  assert.ok(!native.calls.includes('drop'))
})

test('bad drops are refused', () => {
  drops.drop(target({ files: 'nope' }))
  drops.drop(target({ files: [] }))
  drops.drop(target({ files: [{ id: 1, name: 'big', size: MAX_DROP_BYTES + 1 }] }))
  drops.drop(target({ files: [{ id: 1.5, name: 'x', size: 1 }] }))
  assert.ok(!native.calls.includes('drop'))
  assert.deepEqual(readdirSync(directory), [])
})

test('directories of earlier drops older than a day are removed when a session starts', async () => {
  const old = path.join(directory, 'drops', 'd-old')
  const recent = path.join(directory, 'drops', 'd-recent')
  mkdirSync(old, { recursive: true })
  mkdirSync(recent, { recursive: true })
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  utimesSync(old, twoDaysAgo, twoDaysAgo)
  new FileDrops(
    native,
    () => undefined,
    () => undefined,
    path.join(directory, 'drops'),
  )
  await waitFor(() => !readdirSync(path.join(directory, 'drops')).includes('d-old'))
  assert.deepEqual(readdirSync(path.join(directory, 'drops')), ['d-recent'])
})

test('file names are made safe', () => {
  assert.equal(safeFileName('a/b\\c'), 'a_b_c')
  assert.equal(safeFileName('..'), 'file')
  assert.equal(safeFileName(''), 'file')
  assert.equal(safeFileName('bad\u0000name\n'), 'bad_name_')
  assert.ok(Buffer.byteLength(safeFileName('x'.repeat(500))) <= 200)
})
