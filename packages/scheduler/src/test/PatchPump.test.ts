import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Patch, PatchFormat } from '@gfld/scene-protocol'
import type {
  EncodedPatch,
  PatchSink,
  PatchSource,
  Rect,
  SendTier,
  StreamingEncodePool,
} from '@nebula/session-contracts'
import { PatchPump } from '../PatchPump.js'

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })
const settle = () => new Promise((resolve) => setImmediate(resolve))

function fakeEncoded(data: Uint8Array): EncodedPatch {
  return { format: PatchFormat.QOI, channels: 4, data }
}

class FakeSink implements PatchSink {
  active = true
  patches: { surface: string; patch: Patch; tier: SendTier }[] = []

  sendPatch(surface: string, patch: Patch, tier: SendTier, done: (sent: boolean) => void) {
    this.patches.push({ surface, patch, tier })
    done(true)
  }
}

class FakeStreamingPool implements StreamingEncodePool {
  canAccept = true
  onCapacity?: () => void

  async encode() {
    return fakeEncoded(new Uint8Array([1]))
  }
}

test('the pump encodes one patch of a surface at a time: its patches reach the sink in capture order', async () => {
  const sink = new FakeSink()
  const encodings: ((encoded: EncodedPatch) => void)[] = []
  const streaming = new FakeStreamingPool()
  const pump = new PatchPump(sink, () => new Promise<EncodedPatch>((resolve) => encodings.push(resolve)), streaming, {
    error: () => undefined,
  })
  const rects = [r(0, 0, 100, 100), r(10, 10, 5, 5)]
  let serial = 0
  let encoding = false
  let unsent = 0
  const source: PatchSource = {
    key: 'a',
    destroyed: false,
    sendTier: 'normal',
    get hasQueuedPatches() {
      return serial < rects.length
    },
    get mayCapture() {
      return !encoding
    },
    capturePatch() {
      encoding = true
      unsent++
      const rect = rects[serial++]
      return {
        rect,
        pixels: new Uint8Array(4),
        opaque: false,
        surfaceSize: { width: 100, height: 100 },
        serial,
        epoch: 0,
        tier: 'normal',
        lossy: false,
      }
    },
    patchSending: () => undefined,
    encodeDone() {
      encoding = false
      pump.schedule(source)
    },
    itemDone() {
      unsent--
    },
    isCurrent: () => true,
  }
  pump.schedule(source)
  assert.equal(encodings.length, 1, 'one at a time')
  encodings[0](fakeEncoded(new Uint8Array([1])))
  await settle()
  assert.equal(sink.patches.length, 1)
  assert.equal(encodings.length, 2, 'the next once the first was handed to the sink')
  encodings[1](fakeEncoded(new Uint8Array([2])))
  await settle()
  assert.deepEqual(
    sink.patches.map(({ patch }) => patch.contentSerial),
    [1, 2],
  )
  assert.equal(unsent, 0)
  assert.equal(pump.normalEncoding, 0)
})
