import { test } from 'node:test'
import assert from 'node:assert/strict'
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

test('terminating the session ends its launched apps', async () => {
  const apps = new Apps('wayland-test')
  const pid = await apps.launch('Sleeper', 'sleep', ['30'])
  apps.terminate()
  await waitFor(() => apps.pids.length === 0, 'the app to end')
  assert.throws(() => process.kill(pid, 0))
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
  apps.terminate()
  await waitFor(() => apps.pids.length === 0, 'the app to end')
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
