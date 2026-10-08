import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { createServer, Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { decodeRecord, Kind } from '../login-protocol'
import { clientIP, WorkerCount } from '../web'

test('web listener: connection caps in all and per IP', () => {
  const count = new WorkerCount(3, 2)
  assert.ok(count.add('a'))
  assert.ok(count.add('a'))
  assert.ok(!count.add('a'), 'over the per-IP cap')
  assert.ok(count.add('b'))
  assert.ok(!count.add('c'), 'over the total cap')
  count.remove('a')
  assert.ok(count.add('c'), 'room again')
  assert.ok(!count.add('d'))
  count.remove('nobody')
  assert.equal(count.size, 3)
  count.remove('b')
  assert.ok(count.add('b'))
  assert.ok(!count.add('e'), 'full again')
})

test('web listener: client IPs without the IPv6 mapping', () => {
  assert.equal(clientIP('::ffff:192.0.2.1'), '192.0.2.1')
  assert.equal(clientIP('::1'), '::1')
  assert.equal(clientIP('2001:db8::ffff:1'), '2001:db8::ffff:1')
})

function exitOf(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)))
}

test('setNotDumpable: other processes of the same user can no longer read its /proc files', async () => {
  const addon = require.resolve('@gfld/compositor-proxy/dist/fd-passing.js')
  const run = async (notDumpable: boolean) => {
    const script =
      (notDumpable ? `if (require(${JSON.stringify(addon)}).setNotDumpable() !== 0) process.exit(3);` : '') +
      `process.stdout.write('ready'); setTimeout(() => {}, 10000)`
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise((resolve) => child.stdout!.once('data', resolve))
    let readable = true
    try {
      readFileSync(`/proc/${child.pid}/environ`)
    } catch (e: any) {
      assert.equal(e.code, 'EACCES')
      readable = false
    }
    child.kill()
    await exitOf(child)
    return readable
  }
  assert.equal(await run(false), true)
  assert.equal(await run(true), false)
})

test('web listener: a worker per connection, with the client address written to the helper first', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nebula-web-test-'))
  const loginSocket = path.join(dir, 'login.sock')
  const helperConnections: Socket[] = []
  const received: Buffer[] = []
  const helper: Server = createServer((connection) => {
    helperConnections.push(connection)
    let bytes = Buffer.alloc(0)
    connection.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk])
      received[helperConnections.indexOf(connection)] = bytes
    })
  })
  await new Promise<void>((resolve) => helper.listen(loginSocket, resolve))
  const tcp = createServer()
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
  const port = (tcp.address() as { port: number }).port
  const listenFd: number = (tcp as any)._handle.fd
  const web = spawn(
    process.execPath,
    [path.join(__dirname, '../web.js'), '--listen-fd', '3', '--login-socket', loginSocket, '--state-dir', dir],
    { stdio: ['ignore', 'ignore', 'inherit', listenFd] },
  )
  // the listener has its own copy now
  tcp.close()
  try {
    const get = () =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const attempt = (left: number) => {
          const req = request(
            { host: '127.0.0.1', port, path: '/', rejectUnauthorized: false, agent: false },
            (response) => {
              let body = ''
              response.on('data', (chunk) => (body += chunk))
              response.on('end', () => resolve({ status: response.statusCode!, body }))
            },
          )
          // (the listener may still be generating its certificate)
          req.on('error', (e) => (left > 0 ? setTimeout(() => attempt(left - 1), 100) : reject(e)))
          req.end()
        }
        attempt(100)
      })
    const page = await get()
    assert.equal(page.status, 200)
    assert.match(page.body, /<html/i)

    // one helper connection for the connection served, starting with the client's address
    await waitFor(() => received[0] !== undefined && received[0].length >= 22)
    const first = decodeRecord(received[0])
    assert.ok(first !== 'incomplete' && first !== undefined)
    assert.deepEqual(first.record, { kind: Kind.ClientAddress, address: '127.0.0.1' })
    // the worker exits once its connection is closed (agent: false closes it), which closes the helper connection
    await waitFor(() => helperConnections[0].readableEnded || helperConnections[0].destroyed)
  } finally {
    web.kill()
    await exitOf(web)
    helper.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

async function waitFor(condition: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
