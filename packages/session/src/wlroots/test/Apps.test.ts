import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Apps, ProcessInfo } from '../Apps.js'

/** A made-up process tree: pid -> parent and name. */
function processTree(tree: Record<number, [number, string]>): ProcessInfo {
  return (pid) => (tree[pid] ? { ppid: tree[pid][0], name: tree[pid][1] } : undefined)
}

const waitFor = async (condition: () => boolean, what: string) => {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > 5000) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('a launched app runs with the session display, and is forgotten once it exits', async () => {
  const apps = new Apps('wayland-test')
  const pid = await apps.launch('Shell', 'sh', ['-c', 'test "$WAYLAND_DISPLAY" = wayland-test && test "$EXTRA" = 1'], {
    EXTRA: '1',
  })
  assert.deepEqual(apps.pids, [pid])
  await waitFor(() => apps.pids.length === 0, 'the app to exit')
})

test('launching something that does not exist fails', async () => {
  const apps = new Apps('wayland-test')
  await assert.rejects(apps.launch('Nothing', '/nonexistent/program', []))
  assert.deepEqual(apps.pids, [])
})

test('terminating the session ends its launched apps, and resolves once they are gone', async () => {
  const apps = new Apps('wayland-test')
  const pid = await apps.launch('Sleeper', 'sleep', ['30'])
  const start = Date.now()
  await apps.terminate(5000)
  assert.deepEqual(apps.pids, [])
  assert.throws(() => process.kill(pid, 0))
  assert.ok(Date.now() - start < 2000, 'waited for the kill timeout although the app quit')
})

test('apps that ignore SIGTERM are killed once their time is up', async () => {
  const apps = new Apps('wayland-test')
  // the shell ignores SIGTERM, and so does the sleep it becomes
  const pid = await apps.launch('Stubborn', 'sh', ['-c', 'trap "" TERM; exec sleep 30'])
  // (give the shell time to set its trap)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const start = Date.now()
  await apps.terminate(300)
  assert.deepEqual(apps.pids, [])
  assert.throws(() => process.kill(pid, 0))
  assert.ok(Date.now() - start >= 300, 'killed before its time was up')
})

test('clients of launched apps, and of their child processes, belong to them', async () => {
  const tree: Record<number, [number, string]> = {}
  const apps = new Apps('wayland-test', processTree(tree))
  const pid = await apps.launch('Sleeper', 'sleep', ['30'])
  // pid 77: a helper process the app started
  tree[77] = [pid, 'helper']
  apps.clientConnected(1, pid)
  apps.clientConnected(2, 77)
  assert.deepEqual(apps.pids, [pid])
  apps.clientDisconnected(1)
  apps.clientDisconnected(2)
  // launched apps stay known until they exit, without any Wayland connection
  assert.deepEqual(apps.pids, [pid])
  await apps.terminate()
  assert.deepEqual(apps.pids, [])
})

test('an app that connects on its own is known while it has connections', () => {
  // 500: started from a terminal (400) that isn't ours
  const apps = new Apps('wayland-test', processTree({ 500: [400, 'gedit'], 400: [1, 'bash'] }))
  apps.clientConnected(1, 500)
  apps.clientConnected(2, 500)
  assert.deepEqual(apps.pids, [500])
  apps.clientDisconnected(1)
  assert.deepEqual(apps.pids, [500])
  apps.clientDisconnected(2)
  assert.deepEqual(apps.pids, [])
})

test('clients without a process, or of the session process itself, are not apps', () => {
  const apps = new Apps('wayland-test', processTree({}))
  apps.clientConnected(1, 0)
  apps.clientConnected(2, process.pid)
  assert.deepEqual(apps.pids, [])
  apps.clientDisconnected(1)
  apps.clientDisconnected(3)
})

test('X11 apps get the session X11 display, and only when there is one', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gfld-apps-'))
  try {
    const displayOf = async (apps: Apps, name: string) => {
      const file = path.join(dir, name)
      await apps.launch(name, 'sh', ['-c', `printf %s "\${DISPLAY-unset}" > ${file}.tmp && mv ${file}.tmp ${file}`])
      await waitFor(() => existsSync(file), `${name} to write its DISPLAY`)
      return readFileSync(file, 'utf8')
    }
    const apps = new Apps('wayland-test')
    apps.x11Display = ':7'
    assert.equal(await displayOf(apps, 'with-x11'), ':7')
    // without one, apps keep what the session process has (the gateway's session process has no DISPLAY)
    assert.equal(await displayOf(new Apps('wayland-test'), 'without-x11'), process.env.DISPLAY ?? 'unset')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an X11 window counts like a Wayland connection, and the app started in a terminal is ended with the session', () => {
  // 500: an X11 app started from a terminal (400) that is one of ours
  const apps = new Apps('wayland-test', processTree({ 500: [400, 'xeyes'], 400: [1, 'bash'] }))
  const launched = (apps as any).apps as Map<number, any>
  launched.set(400, { pid: 400, name: 'foot', external: false, clients: new Set(), descendants: new Map() })
  apps.x11WindowMapped(7, 500)
  assert.deepEqual(apps.pids, [400])
  assert.deepEqual([...launched.get(400).descendants.values()], [500])
  apps.x11WindowGone(7)
  assert.equal(launched.get(400).descendants.size, 0)
  // unknown pid: nothing
  apps.x11WindowMapped(8, 0)
  assert.deepEqual(apps.pids, [400])
})

test('an X11 app that nobody launched is an app while its window is', () => {
  const apps = new Apps('wayland-test', processTree({ 500: [400, 'xeyes'], 400: [1, 'bash'] }))
  apps.x11WindowMapped(7, 500)
  assert.deepEqual(apps.pids, [500])
  apps.x11WindowGone(7)
  assert.deepEqual(apps.pids, [])
})
