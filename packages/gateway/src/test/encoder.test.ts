import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectEncoder, EncoderProbes, resolveEncoder } from '../encoder'

function probes(have: { render?: boolean; nvidia?: boolean; elements?: string[] }): EncoderProbes {
  return {
    hasRenderNode: () => have.render ?? false,
    hasNvidiaDevice: () => have.nvidia ?? false,
    hasGstElement: (name) => have.elements?.includes(name) ?? false,
  }
}

test('auto prefers vaapih264 with a render node and the element', () => {
  assert.equal(
    detectEncoder(probes({ render: true, nvidia: true, elements: ['vaapih264enc', 'nvh264enc'] })),
    'vaapih264',
  )
})

test('auto falls back to nvh264 with an NVIDIA device and the element', () => {
  assert.equal(detectEncoder(probes({ render: true, nvidia: true, elements: ['nvh264enc'] })), 'nvh264')
  assert.equal(detectEncoder(probes({ nvidia: true, elements: ['nvh264enc'] })), 'nvh264')
})

test('auto resolves to none without the device or the element', () => {
  assert.equal(detectEncoder(probes({})), 'none')
  assert.equal(detectEncoder(probes({ render: true, elements: [] })), 'none', 'render node but no element')
  assert.equal(detectEncoder(probes({ elements: ['vaapih264enc', 'nvh264enc'] })), 'none', 'elements but no device')
})

test('an explicit encoder is used as given and the choice is logged', () => {
  const lines: string[] = []
  const log = (line: string) => lines.push(line)
  assert.equal(resolveEncoder('nvh264', log, probes({})), 'nvh264')
  assert.equal(resolveEncoder('none', log, probes({ render: true, elements: ['vaapih264enc'] })), 'none')
  assert.equal(resolveEncoder('auto', log, probes({})), 'none')
  assert.equal(lines.length, 3)
  assert.match(lines[2], /none/)
})
