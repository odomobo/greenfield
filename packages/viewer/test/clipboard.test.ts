import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ClipboardSync, isPasteChord } from '../src/clipboard.js'

const chord = (code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) => ({
  code,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
  metaKey: mods.meta ?? false,
})

/** a clipboard the test controls; writes fail while `blocked` */
function fakeClipboard(initial = '') {
  const api = {
    text: initial,
    blocked: false,
    reads: 0,
    readError: false,
    async readText() {
      api.reads++
      if (api.readError) {
        throw new Error('NotAllowedError')
      }
      return api.text
    },
    async writeText(text: string) {
      if (api.blocked) {
        throw new Error('NotAllowedError')
      }
      api.text = text
    },
  }
  return api
}

describe('isPasteChord', () => {
  it('is Ctrl+V, Ctrl+Shift+V and Shift+Insert', () => {
    assert.equal(isPasteChord(chord('KeyV', { ctrl: true })), true)
    assert.equal(isPasteChord(chord('KeyV', { ctrl: true, shift: true })), true)
    assert.equal(isPasteChord(chord('Insert', { shift: true })), true)
  })

  it('is nothing else', () => {
    assert.equal(isPasteChord(chord('KeyV')), false)
    assert.equal(isPasteChord(chord('KeyV', { ctrl: true, alt: true })), false)
    assert.equal(isPasteChord(chord('KeyV', { meta: true })), false)
    assert.equal(isPasteChord(chord('Insert')), false)
    assert.equal(isPasteChord(chord('Insert', { ctrl: true })), false)
    assert.equal(isPasteChord(chord('KeyC', { ctrl: true })), false)
  })
})

describe('ClipboardSync', () => {
  it('writes an app text to the browser clipboard', async () => {
    const api = fakeClipboard()
    const sync = new ClipboardSync(api, () => assert.fail('nothing to send'))
    sync.remoteText('from the app')
    await sync.retryPending()
    assert.equal(api.text, 'from the app')
  })

  it('keeps a write the browser refused and retries it at the next user input', async () => {
    const api = fakeClipboard()
    api.blocked = true
    const sync = new ClipboardSync(api, () => assert.fail('nothing to send'))
    sync.remoteText('later')
    await sync.retryPending()
    assert.equal(api.text, '')
    api.blocked = false
    await sync.retryPending()
    assert.equal(api.text, 'later')
  })

  it('sends the browser text before a paste, once', async () => {
    const api = fakeClipboard('from the browser')
    const sent: string[] = []
    const sync = new ClipboardSync(api, (text) => sent.push(text))
    await sync.beforePaste()
    assert.deepEqual(sent, ['from the browser'])
    await sync.beforePaste()
    assert.deepEqual(sent, ['from the browser'])
    api.text = 'changed'
    await sync.beforePaste()
    assert.deepEqual(sent, ['from the browser', 'changed'])
  })

  it('does not send back what an app just set', async () => {
    const api = fakeClipboard()
    const sent: string[] = []
    const sync = new ClipboardSync(api, (text) => sent.push(text))
    sync.remoteText('app text')
    await sync.retryPending()
    await sync.beforePaste()
    assert.deepEqual(sent, [])
  })

  it('writes a refused app text at the paste instead of sending the older browser text', async () => {
    const api = fakeClipboard('old browser text')
    api.blocked = true
    const sent: string[] = []
    const sync = new ClipboardSync(api, (text) => sent.push(text))
    sync.remoteText('newer app text')
    await sync.retryPending()
    api.blocked = false
    await sync.beforePaste()
    assert.equal(api.text, 'newer app text')
    assert.deepEqual(sent, [])
    assert.equal(api.reads, 0)
  })

  it('goes ahead when the browser refuses to be read, or has nothing', async () => {
    const api = fakeClipboard('')
    const sent: string[] = []
    const sync = new ClipboardSync(api, (text) => sent.push(text))
    await sync.beforePaste()
    api.text = 'x'
    api.readError = true
    await sync.beforePaste()
    assert.deepEqual(sent, [])
  })

  it('takes the text of a paste event where there is no readText', async () => {
    const sent: string[] = []
    const sync = new ClipboardSync({}, (text) => sent.push(text))
    assert.equal(sync.canRead, false)
    const done = sync.beforePaste()
    sync.onPasteEvent('from the event')
    await done
    assert.deepEqual(sent, ['from the event'])
    // a paste from the browser's menu has no key press waiting
    sync.onPasteEvent('from the menu')
    assert.deepEqual(sent, ['from the event', 'from the menu'])
  })
})
