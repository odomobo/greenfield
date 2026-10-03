import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { initSurfaceBufferEncoding } from '../../SurfaceBufferEncoding.js'
import wlSurfaceInterceptor from '../../protocol/wl_surface_interceptor.js'

/** wl_surface's request names in opcode order, from the protocol the proxy is generated from. */
function wlSurfaceRequests(): string[] {
  const xml = readFileSync(resolve(__dirname, '../../../../../protocol/wayland.xml'), 'utf8')
  const start = xml.indexOf('<interface name="wl_surface"')
  const surface = xml.substring(start, xml.indexOf('</interface>', start))
  return [...surface.matchAll(/<request name="([a-z_]+)"/g)].map((match) => match[1])
}

/** A wire message carrying these int arguments (after the 8 byte header). */
function message(...args: number[]) {
  const buffer = new Int32Array([0, 0, ...args]).buffer
  return { buffer, fds: [], bufferOffset: 8, consumed: 0, size: buffer.byteLength }
}

test('wl_surface requests are handled under their opcodes', () => {
  initSurfaceBufferEncoding()
  const requests = wlSurfaceRequests()
  const handle = (request: string, ...args: number[]) => {
    const opcode = requests.indexOf(request)
    assert.notEqual(opcode, -1, `${request} is not a wl_surface request`)
    const surface: any = {}
    const handler = (wlSurfaceInterceptor.prototype as any)[`R${opcode}`]
    assert.ok(handler, `no handler for ${request} (R${opcode})`)
    handler.call(surface, message(...args))
    return surface
  }

  assert.deepEqual(handle('damage', 1, 2, 3, 4).pendingDamage, [
    { rect: { x: 1, y: 2, width: 3, height: 4 }, bufferCoordinates: false },
  ])
  assert.deepEqual(handle('damage_buffer', 5, 6, 7, 8).pendingDamage, [
    { rect: { x: 5, y: 6, width: 7, height: 8 }, bufferCoordinates: true },
  ])
  assert.equal(handle('set_buffer_scale', 2).pendingBufferScale, 2)
  assert.equal(handle('set_buffer_transform', 3).pendingBufferTransform, 3)
})
