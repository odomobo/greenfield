import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseKeyboardConfig, systemKeyboardConfig } from '../keyboard-config.js'

const FILE = `# KEYBOARD CONFIGURATION FILE
XKBMODEL="pc105"
XKBLAYOUT="de"
XKBVARIANT='nodeadkeys'
XKBOPTIONS="caps:escape,compose:ralt" # comment
BACKSPACE="guess"
`

test('parses /etc/default/keyboard', () => {
  assert.deepEqual(parseKeyboardConfig(FILE), {
    model: 'pc105',
    layout: 'de',
    variant: 'nodeadkeys',
    options: 'caps:escape,compose:ralt',
  })
})

test('empty values are left out, so the default applies', () => {
  assert.deepEqual(parseKeyboardConfig('XKBLAYOUT="us"\nXKBVARIANT=""\nXKBOPTIONS=\n'), { layout: 'us' })
})

test('XKB_DEFAULT_* overrides the file, a missing file is the default', () => {
  const config = systemKeyboardConfig({ XKB_DEFAULT_LAYOUT: 'fr' }, () => FILE)
  assert.equal(config.layout, undefined)
  assert.equal(config.variant, 'nodeadkeys')
  assert.deepEqual(
    systemKeyboardConfig({}, () => {
      throw new Error('ENOENT')
    }),
    {},
  )
})
