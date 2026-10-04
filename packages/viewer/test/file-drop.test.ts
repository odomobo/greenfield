import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CHUNK_BYTES,
  dragHasFiles,
  dropAllowed,
  droppedFiles,
  MAX_DROP_BYTES,
  MAX_DROP_FILES,
  uploadFiles,
} from '../src/file-drop.js'
import { decodeViewerEnvelope, encodeControl, encodeFileChunk } from '../src/protocol.js'

const file = (name: string, size = 1) => new File([new Uint8Array(size)], name)

describe('dragHasFiles', () => {
  it('is true only for drags that carry files', () => {
    assert.equal(dragHasFiles({ types: ['text/plain', 'Files'] }), true)
    assert.equal(dragHasFiles({ types: ['text/plain'] }), false)
    assert.equal(dragHasFiles(null), false)
  })
})

describe('droppedFiles', () => {
  it('lists the files of the items, not folders or text', () => {
    const a = file('a')
    const b = file('b')
    const items = [
      { kind: 'file', getAsFile: () => a, webkitGetAsEntry: () => ({ isDirectory: false }) },
      { kind: 'file', getAsFile: () => file('folder'), webkitGetAsEntry: () => ({ isDirectory: true }) },
      { kind: 'string', getAsFile: () => null },
      // (no entry API: still a file)
      { kind: 'file', getAsFile: () => b },
    ]
    assert.deepEqual(droppedFiles({ types: ['Files'], items }), [a, b])
  })

  it('falls back to the file list', () => {
    const a = file('a')
    assert.deepEqual(droppedFiles({ types: ['Files'], files: [a] }), [a])
  })
})

describe('dropAllowed', () => {
  it('refuses nothing, too many files and too much data', () => {
    assert.equal(dropAllowed([]), false)
    assert.equal(dropAllowed([{ size: 5 }]), true)
    assert.equal(dropAllowed(Array.from({ length: MAX_DROP_FILES + 1 }, () => ({ size: 1 }))), false)
    assert.equal(dropAllowed([{ size: MAX_DROP_BYTES }, { size: 1 }]), false)
  })
})

describe('uploadFiles', () => {
  it('sends each file in chunks, in order', async () => {
    const chunks: [number, number][] = []
    const content = new Uint8Array(CHUNK_BYTES * 2 + 10).map((_, i) => i % 251)
    await uploadFiles(
      [
        { id: 1, file: new Blob([content]) },
        { id: 2, file: new Blob([new Uint8Array(3)]) },
        { id: 3, file: new Blob([]) },
      ],
      { chunk: (id, bytes) => chunks.push([id, bytes.length]), buffered: () => 0 },
    )
    assert.deepEqual(chunks, [
      [1, CHUNK_BYTES],
      [1, CHUNK_BYTES],
      [1, 10],
      [2, 3],
    ])
  })

  it('waits while the socket has a backlog', async () => {
    let backlog = 10 * 1024 * 1024
    const sent: number[] = []
    const done = uploadFiles([{ id: 1, file: new Blob([new Uint8Array(5)]) }], {
      chunk: (id) => sent.push(id),
      buffered: () => backlog,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(sent, [])
    backlog = 0
    await done
    assert.deepEqual(sent, [1])
  })
})

describe('file chunks on the wire', () => {
  it('round-trip, next to control messages', () => {
    const chunk = decodeViewerEnvelope(encodeFileChunk(0x01020304, new Uint8Array([9, 8, 7])))
    assert.equal(chunk.kind, 'file')
    assert.deepEqual(chunk.kind === 'file' && [chunk.id, [...chunk.data]], [0x01020304, [9, 8, 7]])
    const control = decodeViewerEnvelope(encodeControl({ type: 'focus', focused: true }))
    assert.deepEqual(control, { kind: 'control', message: { type: 'focus', focused: true } })
  })
})
