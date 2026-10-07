import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  decodeRecord,
  encodeRecord,
  fdPassing,
  Kind,
  LoginRecord,
  MAX_ANSWER,
  Outcome,
  PromptStyle,
  RecordChannel,
} from '../login-protocol'

/** The same bytes are checked by the Rust side (packages/login/protocol, `layout_is_fixed`). */
test('login protocol: the byte layout', () => {
  const expect = (record: LoginRecord, bytes: number[]) => assert.deepEqual([...encodeRecord(record)], bytes)
  expect({ kind: Kind.ClientAddress, address: '127.0.0.1' }, [1, 0, 0, 18, 4, 0, 127, 0, 0, 1, ...Array(12).fill(0)])
  expect({ kind: Kind.Begin, username: 'ab' }, [2, 0, 0, 2, 97, 98])
  expect({ kind: Kind.Prompt, style: PromptStyle.EchoOn, text: 'x' }, [3, 0, 0, 2, 2, 120])
  expect({ kind: Kind.Answer, text: 'pw' }, [4, 0, 0, 2, 112, 119])
  expect({ kind: Kind.Result, outcome: Outcome.SignedIn, text: 'u' }, [5, 0, 0, 2, 0, 117])
  expect({ kind: Kind.Handover, address: '::1' }, [6, 0, 0, 18, 6, 0, ...Array(15).fill(0), 1])
})

test('login protocol: records round-trip, prefixes are incomplete', () => {
  const records: LoginRecord[] = [
    { kind: Kind.ClientAddress, address: '192.168.1.20' },
    { kind: Kind.ClientAddress, address: '2001:db8::1' },
    { kind: Kind.Handover, address: '::ffff:10.0.0.1' },
    { kind: Kind.Handover, address: '1:2:3:4:5:6:7:8' },
    { kind: Kind.Handover, address: 'fe80::1:0:0:2' },
    { kind: Kind.Begin, username: '' },
    { kind: Kind.Prompt, style: PromptStyle.Info, text: 'Hello' },
    { kind: Kind.Answer, text: 'pässword' },
    { kind: Kind.Result, outcome: Outcome.Refused, text: 'The username or password is incorrect.' },
  ]
  for (const record of records) {
    const bytes = encodeRecord(record)
    assert.deepEqual(decodeRecord(bytes), { record, size: bytes.length })
    for (let end = 0; end < bytes.length; end++) {
      assert.equal(decodeRecord(bytes.subarray(0, end)), 'incomplete')
    }
  }
  // addresses come back in their canonical text
  const handover = (address: string) => decodeRecord(encodeRecord({ kind: Kind.Handover, address }))
  assert.deepEqual(handover('2001:0db8:0:0:0:0:0:0001'), {
    record: { kind: Kind.Handover, address: '2001:db8::1' },
    size: 22,
  })
})

test('login protocol: limits and malformed records', () => {
  assert.throws(() => encodeRecord({ kind: Kind.Answer, text: 'x'.repeat(MAX_ANSWER + 1) }))
  assert.throws(() => encodeRecord({ kind: Kind.Begin, username: 'x'.repeat(257) }))
  assert.throws(() => encodeRecord({ kind: Kind.ClientAddress, address: 'example.com' }))
  for (const bytes of [
    [4, 0, 0x04, 0x01], // over the answer limit, refused from the header alone
    [1, 0, 0, 17], // an address has exactly 18 bytes
    [3, 0, 0, 0], // a prompt has at least its style
    [9, 0, 0, 0],
    [2, 1, 0, 0],
    [2, 0, 0, 1, 0xff],
    [3, 0, 0, 1, 5],
    [5, 0, 0, 1, 3],
    [1, 0, 0, 18, 5, ...Array(17).fill(0)],
  ]) {
    assert.throws(() => decodeRecord(Buffer.from(bytes)), `${bytes}`)
  }
})

test('login protocol: a channel reads records as they come, split or together', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nebula-login-'))
  const socketPath = path.join(dir, 's')
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  const accepted = new Promise<import('node:net').Socket>((resolve) => server.once('connection', resolve))
  const fd = fdPassing().unixConnect(socketPath)
  assert.ok(fd >= 0)
  const channel = new RecordChannel(fd)
  const peer = await accepted
  try {
    const prompt = encodeRecord({ kind: Kind.Prompt, style: PromptStyle.EchoOff, text: 'Password: ' })
    const info = encodeRecord({ kind: Kind.Prompt, style: PromptStyle.Info, text: 'hi' })
    peer.write(prompt.subarray(0, 3))
    setTimeout(() => peer.write(Buffer.concat([prompt.subarray(3), info])), 20)
    assert.deepEqual(await channel.read(2000), {
      record: { kind: Kind.Prompt, style: PromptStyle.EchoOff, text: 'Password: ' },
    })
    assert.deepEqual(await channel.read(2000), { record: { kind: Kind.Prompt, style: PromptStyle.Info, text: 'hi' } })
    // and writes
    const received = new Promise<Buffer>((resolve) => peer.once('data', resolve))
    assert.ok(channel.write({ kind: Kind.Answer, text: 'secret' }))
    assert.deepEqual(decodeRecord(await received), { record: { kind: Kind.Answer, text: 'secret' }, size: 10 })
    // a signed-in result without its fd is an error; so is EOF
    peer.end(encodeRecord({ kind: Kind.Result, outcome: Outcome.SignedIn, text: 'u' }))
    assert.equal(await channel.read(2000), undefined)
  } finally {
    channel.close()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
