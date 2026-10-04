/**
 * A fixed number of warm video encoders, lent to one surface at a time. The pool size caps how many surfaces are
 * streamed as video at once. Size 0 means no video at all (no GPU acceleration): everything stays on lossless patches.
 * If an encoder can't be created, the pool reports the failure once and from then on behaves as size 0.
 */
export class EncoderPool<E extends { destroy(): void }> {
  private readonly free: E[] = []
  private readonly leased = new Set<E>()
  private readonly extra = new Set<E>()
  private failed = false

  constructor(
    private readonly create: () => E,
    private readonly configuredSize: number,
    private readonly onFailure?: (error: Error) => void,
  ) {}

  /** How many surfaces can be streamed as video at most; 0 if there is no video encoder. */
  get size(): number {
    return this.failed ? 0 : this.configuredSize
  }

  /** Create all encoders up front, so the first video frame doesn't pay for setting one up. */
  warm(): void {
    try {
      while (this.size > 0 && this.free.length + this.leased.size - this.extra.size < this.size) {
        this.free.push(this.create())
      }
    } catch (e: any) {
      this.fail(e)
    }
  }

  private fail(error: Error) {
    if (!this.failed) {
      this.failed = true
      this.onFailure?.(error)
    }
  }

  /** how many more surfaces can get an encoder */
  get available(): number {
    return this.failed ? 0 : this.size - (this.leased.size - this.extra.size)
  }

  /** An encoder, or undefined if all are in use (or there are none). */
  acquire(): E | undefined {
    this.warm()
    const encoder = this.free.pop()
    if (encoder) {
      this.leased.add(encoder)
    }
    return encoder
  }

  /**
   * An encoder even if all are in use, for surfaces that can't be sent as patches at all (undefined only if there is
   * no video encoder). One created beyond the pool size is destroyed when released.
   */
  acquireAlways(): E | undefined {
    const encoder = this.acquire()
    if (encoder || this.size === 0) {
      return encoder
    }
    try {
      const extra = this.create()
      this.extra.add(extra)
      this.leased.add(extra)
      return extra
    } catch (e: any) {
      this.fail(e)
      return undefined
    }
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
