import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { DBusConnection, DBusError, IncomingMessage, INVALID_ARGS, UNKNOWN_METHOD, Variant } from '../shell/dbus'
import { Notification, NotificationServer } from '../shell/notifications'

/** A session bus of our own: its address and pid. */
function startBus(): { address: string; pid: number } {
  const [address, pid] = execFileSync(
    'dbus-daemon',
    ['--session', '--fork', '--nopidfile', '--print-address=1', '--print-pid=1'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
  return { address, pid: Number(pid) }
}

// a private session bus for the whole file
let bus: { address: string; pid: number } | undefined
before(() => {
  bus = startBus()
  process.env.DBUS_SESSION_BUS_ADDRESS = bus.address
})
after(() => {
  if (bus) {
    process.kill(bus.pid)
  }
})

async function until(what: string, condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A connection answering calls to /echo with their first argument, a variant, unwrapped. */
async function echoServer(): Promise<DBusConnection> {
  const server = await DBusConnection.session(() => {})
  server.export('/echo', (call) => {
    if (call.member === 'Fail') {
      throw new DBusError('org.example.Error.Nope', 'no, thanks')
    }
    if (call.member === 'Throw') {
      throw new Error('a bug')
    }
    if (call.member === 'BadReply') {
      return { signature: 'i', body: ['not a number'] }
    }
    if (call.member !== 'Echo') {
      return undefined
    }
    const value = call.body[0] as Variant
    return { signature: value.signature, body: [value.value] }
  })
  return server
}

test('values of every kind go and come back as documented', async () => {
  const server = await echoServer()
  const client = await DBusConnection.session(() => {})
  assert.match(client.uniqueName, /^:1\.\d+$/)
  const cases: [string, unknown, unknown?][] = [
    ['y', 255],
    ['n', -32768],
    ['q', 65535],
    ['i', -7],
    ['u', 4294967295],
    ['x', -(2 ** 40)],
    ['t', 2 ** 40],
    ['d', 1.5],
    ['b', true],
    ['b', false],
    ['s', 'héllo'],
    ['o', '/a/b'],
    ['g', 'a{sv}'],
    ['as', ['a', 'b']],
    ['as', []],
    ['ay', Buffer.from([1, 2, 3])],
    ['ay', new Uint8Array([4, 5]), Buffer.from([4, 5])],
    ['ay', [6, 7], Buffer.from([6, 7])],
    ['(is)', [1, 'x']],
    ['a{sv}', { a: new Variant('i', 3), b: new Variant('as', ['z']) }],
    ['a{sv}', {}],
    // number keys are property names on our side
    ['a{us}', { 1: 'one', 2: 'two' }],
    ['v', new Variant('v', new Variant('s', 'deep'))],
    ['a(iiay)', [[1, 2, Buffer.from([9])]]],
    ['aai', [[1, 2], [], [3]]],
    // dbusmenu's layout
    ['(ia{sv}av)', [0, { label: new Variant('s', 'x') }, [new Variant('(ia{sv}av)', [1, {}, []])]]],
  ]
  for (const [signature, value, expected] of cases) {
    const [reply] = await client.call(server.uniqueName, '/echo', 'org.example', 'Echo', 'v', [
      new Variant(signature, value),
    ])
    assert.deepEqual(reply, expected ?? value, signature)
  }
  client.close()
  server.close()
})

test('a body that does not match its signature throws (and sends nothing)', async () => {
  const server = await echoServer()
  const client = await DBusConnection.session(() => {})
  for (const [signature, body] of [
    ['s', [1]],
    ['i', ['x']],
    ['as', ['not an array']],
    ['(ii)', [[1]]],
    ['v', [{}]],
    ['ss', ['only one']],
    ['s', ['one', 'too many']],
    ['a{', [{}]],
  ] as [string, unknown[]][]) {
    await assert.rejects(client.call(server.uniqueName, '/echo', 'org.example', 'Echo', signature, body), signature)
  }
  // the connection still works
  const [reply] = await client.call(server.uniqueName, '/echo', 'org.example', 'Echo', 'v', [new Variant('s', 'ok')])
  assert.equal(reply, 'ok')
  client.close()
  server.close()
})

test('errors: thrown DBusErrors, other exceptions, unknown methods and paths, bad replies', async () => {
  const server = await echoServer()
  const client = await DBusConnection.session(() => {})
  const call = (path: string, member: string) => client.call(server.uniqueName, path, 'org.example', member)
  const rejectsWith = (promise: Promise<unknown>, type: string) =>
    assert.rejects(promise, (e: unknown) => e instanceof DBusError && e.type === type)
  await rejectsWith(call('/echo', 'Fail'), 'org.example.Error.Nope')
  await rejectsWith(call('/echo', 'Throw'), 'org.freedesktop.DBus.Error.Failed')
  await rejectsWith(call('/echo', 'Nothing'), UNKNOWN_METHOD)
  await rejectsWith(call('/echo', 'BadReply'), 'org.freedesktop.DBus.Error.Failed')
  await rejectsWith(call('/elsewhere', 'Echo'), 'org.freedesktop.DBus.Error.UnknownObject')
  await rejectsWith(
    client.call('org.example.Nobody', '/', 'org.example', 'Echo'),
    'org.freedesktop.DBus.Error.ServiceUnknown',
  )
  // Ping is answered for exported paths
  assert.deepEqual(await client.call(server.uniqueName, '/echo', 'org.freedesktop.DBus.Peer', 'Ping'), [])
  client.close()
  server.close()
})

test('signals reach the subscriptions they match, until unsubscribed', async () => {
  const sender = await DBusConnection.session(() => {})
  const receiver = await DBusConnection.session(() => {})
  const got: IncomingMessage[] = []
  const unsubscribe = await receiver.subscribe(
    { sender: sender.uniqueName, interface: 'org.example', member: 'Changed', arg0: 'yes' },
    (message) => got.push(message),
  )
  sender.emitSignal('/thing', 'org.example', 'Changed', 'sa{sv}', ['no', {}])
  sender.emitSignal('/thing', 'org.example', 'Other', 's', ['yes'])
  sender.emitSignal('/thing', 'org.example', 'Changed', 'sa{sv}', ['yes', { n: new Variant('i', 1) }])
  await until('the signal', () => got.length === 1)
  assert.deepEqual(got[0], {
    sender: sender.uniqueName,
    path: '/thing',
    interface: 'org.example',
    member: 'Changed',
    signature: 'sa{sv}',
    body: ['yes', { n: new Variant('i', 1) }],
  })
  unsubscribe()
  sender.emitSignal('/thing', 'org.example', 'Changed', 'sa{sv}', ['yes', {}])
  // a round trip after it: the signal would have come before the reply
  await sender.call(receiver.uniqueName, '/', 'org.freedesktop.DBus.Peer', 'Ping')
  await receiver.call(sender.uniqueName, '/', 'org.freedesktop.DBus.Peer', 'Ping')
  assert.equal(got.length, 1)
  sender.close()
  receiver.close()
})

/** A process on the bus that never answers (its event loop is blocked): its unique name, and the process. */
async function blockedPeer(address: string) {
  const dbusModule = join(__dirname, '..', 'shell', 'dbus.js')
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(dbusModule)}).DBusConnection.session(() => {}).then((c) => {
        console.log(c.uniqueName)
        setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0), 20)
      })`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address } },
  )
  const name = await new Promise<string>((resolve) => child.stdout.once('data', (data) => resolve(String(data).trim())))
  // until it's blocked
  await new Promise((resolve) => setTimeout(resolve, 100))
  return { name, child }
}

test('a call nobody answers times out', async () => {
  const peer = await blockedPeer(bus!.address)
  try {
    const client = await DBusConnection.session(() => {})
    const start = Date.now()
    await assert.rejects(
      client.call(peer.name, '/', 'org.freedesktop.DBus.Peer', 'Ping', '', [], 200),
      (e: unknown) => e instanceof DBusError && e.type === 'org.freedesktop.DBus.Error.NoReply',
    )
    assert.ok(Date.now() - start >= 150, `timed out after ${Date.now() - start} ms`)
    client.close()
  } finally {
    peer.child.kill('SIGKILL')
  }
})

test('losing the bus rejects the pending calls and reports the error', async () => {
  const other = startBus()
  const peer = await blockedPeer(other.address)
  const saved = process.env.DBUS_SESSION_BUS_ADDRESS
  process.env.DBUS_SESSION_BUS_ADDRESS = other.address
  const errors: Error[] = []
  let connection: DBusConnection
  try {
    connection = await DBusConnection.session((e) => errors.push(e))
  } finally {
    process.env.DBUS_SESSION_BUS_ADDRESS = saved
  }
  try {
    const pending = connection.call(peer.name, '/', 'org.freedesktop.DBus.Peer', 'Ping', '', [], 5000)
    process.kill(other.pid)
    await assert.rejects(pending, DBusError)
    await until('the error', () => errors.length === 1)
    await assert.rejects(connection.call('org.freedesktop.DBus', '/', 'org.freedesktop.DBus.Peer', 'Ping'), DBusError)
    connection.close()
  } finally {
    peer.child.kill('SIGKILL')
  }
})

test('the notification server takes notifications, closes them, and introspects', async () => {
  const server = new NotificationServer()
  const added: Notification[] = []
  const closed: number[] = []
  server.listener = { added: (n) => added.push(n), closed: (id) => closed.push(id) }
  await server.start()
  const app = await DBusConnection.session(() => {})
  const signals: unknown[][] = []
  await app.subscribe({ interface: 'org.freedesktop.Notifications', member: 'NotificationClosed' }, (message) =>
    signals.push(message.body),
  )
  const notify = (replacesId: number, hints: Record<string, Variant>) =>
    app.call(
      'org.freedesktop.Notifications',
      '/org/freedesktop/Notifications',
      'org.freedesktop.Notifications',
      'Notify',
      'susssasa{sv}i',
      ['App', replacesId, 'dialog-information', '<b>Hi</b>', 'a &amp; b', [], hints, -1],
    )
  const [id] = await notify(0, { urgency: new Variant('y', 2), 'desktop-entry': new Variant('s', 'app') })
  assert.equal(typeof id, 'number')
  assert.equal(added.length, 1)
  assert.deepEqual(
    { ...added[0], time: 0 },
    {
      id,
      appName: 'App',
      summary: 'Hi',
      body: 'a & b',
      icon: 'dialog-information',
      desktopEntry: 'app',
      urgency: 'critical',
      expireTimeout: -1,
      time: 0,
    },
  )
  // replacing keeps the id
  assert.deepEqual(await notify(id as number, {}), [id])
  const call = (member: string, signature = '', body: unknown[] = []) =>
    app.call(
      'org.freedesktop.Notifications',
      '/org/freedesktop/Notifications',
      'org.freedesktop.Notifications',
      member,
      signature,
      body,
    )
  assert.deepEqual(await call('GetCapabilities'), [['body']])
  assert.equal((await call('GetServerInformation')).length, 4)
  await assert.rejects(call('Notify', 's', ['x']), (e: unknown) => e instanceof DBusError && e.type === INVALID_ARGS)
  await call('CloseNotification', 'u', [id])
  assert.deepEqual(closed, [id])
  await until('NotificationClosed', () => signals.length === 1)
  assert.deepEqual(signals[0], [id, 3])
  const [xml] = await app.call(
    'org.freedesktop.Notifications',
    '/org/freedesktop/Notifications',
    'org.freedesktop.DBus.Introspectable',
    'Introspect',
  )
  assert.match(String(xml), /<method name="Notify">/)
  app.close()
  server.stop()
})
