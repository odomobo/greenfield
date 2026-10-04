import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { modifiersOf } from '../src/modifiers.js'

const event = (...held: string[]) => ({ getModifierState: (key: string) => held.includes(key) })

describe('modifiersOf', () => {
  it('reports what the browser says is held or locked', () => {
    assert.deepEqual(modifiersOf(event('Control', 'Shift', 'CapsLock')), {
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
      altGr: false,
      capsLock: true,
      numLock: false,
    })
    assert.deepEqual(modifiersOf(event('Alt', 'Meta', 'NumLock')), {
      ctrl: false,
      shift: false,
      alt: true,
      meta: true,
      altGr: false,
      capsLock: false,
      numLock: true,
    })
  })

  it('reports AltGr alone, not the Ctrl+Alt Windows adds to it', () => {
    assert.deepEqual(modifiersOf(event('Control', 'Alt', 'AltGraph', 'Shift')), {
      ctrl: false,
      shift: true,
      alt: false,
      meta: false,
      altGr: true,
      capsLock: false,
      numLock: false,
    })
  })
})
