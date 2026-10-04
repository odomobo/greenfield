import type { ViewerMessage } from './protocol'

/** What the browser offers (the canvas's Pointer Lock API), injectable for tests. */
export interface PointerLockHost {
  /** Request the lock; the browser may refuse (no user gesture yet), by rejecting or by a `pointerlockerror` event. */
  request(): Promise<void> | void

  exit(): void

  /** the canvas holds the browser's pointer lock */
  locked(): boolean
}

/**
 * Pointer lock for apps that lock the pointer (games, 3D apps; pointer-constraints-v1). The server says an app
 * locked a surface (`pointer.lock`); this requests the browser's lock and, while it holds, turns mouse movement into
 * relative motion messages. If the browser refuses (some need a user gesture) the request is repeated on the next click.
 * When the browser ends the lock by itself (Escape, the page lost focus) the server is told, which ends the app's
 * lock too. Confined pointers need nothing here: the server clamps positions.
 */
export class PointerLock {
  /** the app has a lock that we should hold */
  private wanted = false
  /** the browser refused: try again on the next click */
  private refused = false

  constructor(
    private readonly host: PointerLockHost,
    private readonly send: (message: ViewerMessage) => void,
  ) {}

  /** The server's `pointer.lock`. */
  serverLock(locked: boolean, confined: boolean): void {
    if (confined) {
      return
    }
    if (locked) {
      this.wanted = true
      this.request()
    } else {
      this.wanted = false
      this.refused = false
      if (this.host.locked()) {
        this.host.exit()
      }
    }
  }

  private request(): void {
    try {
      const result = this.host.request()
      if (result) {
        result.catch(() => {
          this.refused = true
        })
      }
    } catch {
      this.refused = true
    }
  }

  /** A click or tap on the canvas (a user gesture). */
  gesture(): void {
    if (this.wanted && this.refused && !this.host.locked()) {
      this.refused = false
      this.request()
    }
  }

  /** `pointerlockerror` */
  failed(): void {
    this.refused = true
  }

  /** `pointerlockchange` */
  changed(): void {
    if (this.host.locked()) {
      this.refused = false
    } else if (this.wanted) {
      // the browser ended it: Escape, or the page lost focus
      this.wanted = false
      this.send({ type: 'pointer.unlock' })
    }
  }

  /** Mouse movement: sent as relative motion and true if the pointer is locked, else false. */
  movement(dx: number, dy: number, time: number): boolean {
    if (!this.host.locked() || !this.wanted) {
      return false
    }
    if (dx !== 0 || dy !== 0) {
      this.send({ type: 'pointer.relative', dx, dy, time: Math.round(time) })
    }
    return true
  }
}
