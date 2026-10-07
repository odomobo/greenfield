import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionConfig } from '../session-config'
import { formatSiteSettings, parseSiteSettings } from '../site-settings'

test('session config: defaults without devFlags', () => {
  const { config, devFlags } = parseSessionConfig('{"version":1,"socketPath":"/x/viewer.sock","extra":true}')
  assert.equal(config.socketPath, '/x/viewer.sock')
  assert.deepEqual(devFlags, { timeScale: 1, linkKbps: 0, patchOrder: 'oldest', patchShape: 'bands' })
})

test('session config: an inherited listening socket instead of a path', () => {
  const { config } = parseSessionConfig('{"version":1,"listenFd":4}')
  assert.equal(config.listenFd, 4)
  assert.equal(config.socketPath, undefined)
})

test('session config: dev flags are filled in individually', () => {
  const { devFlags } = parseSessionConfig('{"version":1,"socketPath":"s","devFlags":{"timeScale":3,"patchShape":"tiles"}}')
  assert.deepEqual(devFlags, { timeScale: 3, linkKbps: 0, patchOrder: 'oldest', patchShape: 'tiles' })
})

test('session config: invalid records are rejected', () => {
  for (const text of [
    'nope',
    '[]',
    '{"version":2,"socketPath":"s"}',
    '{"version":1}',
    '{"version":1,"socketPath":"s","devFlags":{"timeScale":0}}',
    '{"version":1,"socketPath":"s","devFlags":{"patchOrder":"x"}}',
    '{"version":1,"socketPath":"s","siteSettingsPath":3}',
    '{"version":1,"socketPath":"s","listenFd":4}',
    '{"version":1,"listenFd":1}',
    '{"version":1,"listenFd":"4"}',
  ]) {
    assert.throws(() => parseSessionConfig(text))
  }
})

test('site settings', () => {
  assert.deepEqual(parseSiteSettings(''), { encoder: 'auto', renderDevice: '/dev/dri/renderD128' })
  assert.deepEqual(parseSiteSettings('# c\nencoder = none\n\nrender-device=/dev/dri/renderD129\n'), {
    encoder: 'none',
    renderDevice: '/dev/dri/renderD129',
  })
  assert.deepEqual(parseSiteSettings(formatSiteSettings({ encoder: 'vaapih264', renderDevice: '/d' })), {
    encoder: 'vaapih264',
    renderDevice: '/d',
  })
  assert.throws(() => parseSiteSettings('encoder = x264'))
  assert.throws(() => parseSiteSettings('colour = red'))
  assert.throws(() => parseSiteSettings('encoder'))
})
