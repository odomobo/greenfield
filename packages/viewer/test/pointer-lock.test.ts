import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PointerLock } from '../src/pointer-lock.js'
import { wheelClick } from '../src/wheel.js'

function setup(options: { refuse?: boolean } = {}) {
  const log: string[] = []
  const sent: any[] = []
  let locked = false
  let refuse = options.refuse ?? false
  const lock = new PointerLock(
    {
      request: () => {
        log.push('request')
        if (refuse) {
          return Promise.reject(new Error('needs a gesture'))
        }
        locked = true
      },
      exit: () => {
        log.push('exit')
        locked = false
      },
      locked: () => locked,
    },
    (message) => sent.push(message),
  )
  return {
    lock,
    log,
    sent,
    allow: () => (refuse = false),
    browserEnds: () => {
      locked = false
      lock.changed()
    },
  }
}

describe('PointerLock', () => {
  it('requests the lock when the app locks, sends relative motion, and unlocks when the app lets go', () => {
    const t = setup()
    assert.equal(t.lock.movement(1, 1, 0), false)
    t.lock.serverLock(true, false)
    t.lock.changed()
    assert.deepEqual(t.log, ['request'])
    assert.equal(t.lock.movement(3, -2, 10.4), true)
    assert.deepEqual(t.sent, [{ type: 'pointer.relative', dx: 3, dy: -2, time: 10 }])
    t.lock.serverLock(false, false)
    assert.deepEqual(t.log, ['request', 'exit'])
    // the change that follows our own exit isn't the browser ending it
    t.lock.changed()
    assert.equal(t.sent.length, 1)
    assert.equal(t.lock.movement(1, 1, 0), false)
  })

  it('tells the server when the browser ends the lock (Escape)', () => {
    const t = setup()
    t.lock.serverLock(true, false)
    t.browserEnds()
    assert.deepEqual(t.sent, [{ type: 'pointer.unlock' }])
    t.browserEnds()
    assert.equal(t.sent.length, 1)
  })

  it('tries again on the next click if the browser refused', async () => {
    const t = setup({ refuse: true })
    t.lock.serverLock(true, false)
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(t.log, ['request'])
    t.lock.gesture()
    assert.deepEqual(t.log, ['request', 'request'])
    // refused again, then the browser allows it
    await Promise.resolve()
    await Promise.resolve()
    t.allow()
    t.lock.gesture()
    t.lock.changed()
    assert.deepEqual(t.log, ['request', 'request', 'request'])
    // locked now: more clicks don't ask again
    t.lock.gesture()
    assert.equal(t.log.length, 3)
  })

  it('also retries after a pointerlockerror event', () => {
    const t = setup()
    t.lock.serverLock(true, false)
    // the browser said no (pointerlockerror) and it isn't locked
    t.browserEnds()
    t.lock.serverLock(true, false)
    t.browserEnds()
    t.lock.serverLock(true, false)
    assert.equal(t.log.length, 3)
    t.lock.failed()
    t.browserEnds()
    t.lock.gesture()
    // nothing wanted anymore after the browser ended it: no request
    assert.equal(t.log.length, 3)
  })

  it('leaves confined pointers to the server', () => {
    const t = setup()
    t.lock.serverLock(true, true)
    assert.deepEqual(t.log, [])
    assert.equal(t.lock.movement(1, 1, 0), false)
  })
})

describe('wheelClick', () => {
  it('recognises mouse wheel clicks in pixel mode', () => {
    assert.equal(wheelClick(0, 100), 120)
    assert.equal(wheelClick(0, -200), -240)
  })

  it('leaves touchpad scrolling and other delta modes alone', () => {
    assert.equal(wheelClick(0, 37), 0)
    assert.equal(wheelClick(0, 0), 0)
    assert.equal(wheelClick(1, 3), 0)
  })
})
