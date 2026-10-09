import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as contracts from '../index.js'

test('the entry point loads and has no runtime exports yet (types only)', () => {
  assert.deepEqual(Object.keys(contracts), [])
})
