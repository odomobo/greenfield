/**
 * A fixed number of warm video encoders, lent to one surface at a time. The pool size caps how many surfaces are
 * streamed as video at once; when it's empty, busy surfaces stay on lossless patches.
 */
export class EncoderPool<E extends { destroy(): void }> {
  private readonly free: E[] = []
  private readonly leased = new Set<E>()
  private readonly extra = new Set<E>()

  constructor(
    private readonly create: () => E,
    readonly size: number,
  ) {}

  /** Create all encoders up front, so the first video frame doesn't pay for setting one up. */
  warm(): void {
    while (this.free.length + this.leased.size - this.extra.size < this.size) {
      this.free.push(this.create())
    }
  }

  /** how many more surfaces can get an encoder */
  get available(): number {
    return this.size - (this.leased.size - this.extra.size)
  }

  /** An encoder, or undefined if all are in use. */
  acquire(): E | undefined {
    this.warm()
    const encoder = this.free.pop()
    if (encoder) {
      this.leased.add(encoder)
    }
    return encoder
  }

  /**
   * An encoder even if all are in use, for surfaces that can't be sent as patches at all. One created beyond the pool
   * size is destroyed when released.
   */
  acquireAlways(): E {
    const encoder = this.acquire()
    if (encoder) {
      return encoder
    }
    const extra = this.create()
    this.extra.add(extra)
    this.leased.add(extra)
    return extra
  }

  release(encoder: E): void {
    if (!this.leased.delete(encoder)) {
      return
    }
    if (this.extra.delete(encoder)) {
      encoder.destroy()
      return
    }
    this.free.push(encoder)
  }
}
