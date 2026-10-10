import type {
  CapturedPatch,
  EncodedPatch,
  PatchEncode,
  PatchSink,
  PatchSource,
  SendTier,
  StreamingEncodePool,
} from '@nebula/session-contracts'

/** Patches of normal surfaces encoding at once (on libuv's thread pool). */
export const MAX_NORMAL_ENCODES = 4

/**
 * Encodes queued patches when there is room: the surface may capture (nothing of it encoding, its stream ready), and an
 * encoder is free in the surface's class's pool. Patches wait in their surface's queue (where new damage merges into
 * them) instead of in a send buffer. A surface encodes one patch at a time, so its patches reach the sink in capture
 * order (a newer patch can overlap an older one, and the older one must not be drawn over it).
 */
export class PatchPump {
  private readonly ready: Record<SendTier, Set<PatchSource>> = {
    normal: new Set(),
    streaming: new Set(),
    settle: new Set(),
  }
  private normalEncodes = 0
  private pumping = false
  private again = false

  constructor(
    private readonly sink: PatchSink,
    private readonly encodeNormal: PatchEncode,
    private readonly streaming: StreamingEncodePool,
    private readonly logger: { error(message: string): void },
    private readonly maxNormalEncodes = MAX_NORMAL_ENCODES,
  ) {
    streaming.onCapacity = () => this.pump()
  }

  /** normal patches encoding right now */
  get normalEncoding(): number {
    return this.normalEncodes
  }

  schedule(surface: PatchSource): void {
    this.ready[surface.sendTier].add(surface)
    this.pump()
  }

  pump(): void {
    if (this.pumping) {
      // a pump is running up the stack (a synchronous callback): it goes round again
      this.again = true
      return
    }
    this.pumping = true
    try {
      do {
        this.again = false
        // settling shares the low priority pool with the streaming class, after it
        this.pumpClass('streaming')
        this.pumpClass('settle')
        this.pumpClass('normal')
      } while (this.again)
    } finally {
      this.pumping = false
    }
  }

  private hasCapacity(tier: SendTier): boolean {
    return tier === 'normal' ? this.normalEncodes < this.maxNormalEncodes : this.streaming.canAccept
  }

  private pumpClass(tier: SendTier) {
    const set = this.ready[tier]
    while (this.sink.active && this.hasCapacity(tier)) {
      const next = set.values().next()
      if (next.done) {
        return
      }
      const surface = next.value
      set.delete(surface)
      if (surface.destroyed || !surface.hasQueuedPatches) {
        continue
      }
      if (surface.sendTier !== tier) {
        // its class changed since it was scheduled, or it has damage again (or none left)
        this.ready[surface.sendTier].add(surface)
        this.again = true
        continue
      }
      if (!surface.mayCapture) {
        // scheduled again when its encode is done or its stream is ready
        continue
      }
      const captured = surface.capturePatch()
      if (surface.hasQueuedPatches) {
        // back of the line, for fairness between surfaces
        this.ready[surface.sendTier].add(surface)
        this.again ||= surface.sendTier !== tier
      }
      if (captured === undefined) {
        continue
      }
      this.encode(surface, captured)
    }
  }

  private encode(surface: PatchSource, captured: CapturedPatch) {
    const tier = captured.tier
    let released = false
    const done = () => {
      if (!released) {
        released = true
        surface.itemDone(captured)
      }
    }
    let encoding: Promise<EncodedPatch>
    if (tier === 'normal') {
      this.normalEncodes++
      encoding = this.encodeNormal(captured.pixels, captured.rect.width, captured.rect.height, captured.opaque)
      const finished = () => {
        this.normalEncodes--
        this.pump()
      }
      encoding.then(finished, finished)
    } else {
      encoding = this.streaming.encode(
        captured.pixels,
        captured.rect.width,
        captured.rect.height,
        captured.opaque,
        captured.lossy,
      )
    }
    encoding.then(
      (encoded) => {
        if (!surface.isCurrent(captured.epoch) || !this.sink.active) {
          surface.encodeDone(captured)
          done()
          return
        }
        surface.patchSending(captured, encoded)
        this.sink.sendPatch(
          surface.key,
          { contentSerial: captured.serial, surfaceSize: captured.surfaceSize, rect: captured.rect, ...encoded },
          tier,
          done,
        )
        surface.encodeDone(captured)
      },
      (error: Error) => {
        this.logger.error(`Patch encoding of ${surface.key} failed: ${error.message}`)
        surface.encodeDone(captured)
        done()
      },
    )
  }
}
