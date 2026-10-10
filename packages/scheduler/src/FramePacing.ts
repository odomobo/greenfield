import { performance } from 'node:perf_hooks'
import type { FrameCallbackScheduler, ViewerPacing } from '@nebula/session-contracts'

/**
 * Frame callback pacing shared by all surfaces of the session, driven by the attached viewer. No native code.
 *
 * A surface's frame callbacks are held while it isn't ready for a new frame (its stream in the transport isn't ready:
 * more than a chunk of its data is still unsent), and released at the next tick of the frame clock once it is. So an
 * app draws at the rate its output leaves (the transport's congestion control and the viewer's backlog decide when
 * items go out, see ARCHITECTURE.md). But a surface sent as patches never below MIN_FRAME_RATE: after MAX_FRAME_HOLD_MS
 * the callback goes anyway, and the app's next frame is queued as damage, read when its stream is ready (a slow repaint
 * may then show parts of different frames, but the app keeps responding). Not one streamed as video: a video frame is the whole
 * surface at once, it never shows a partial repaint to get ahead of. Without a viewer apps are throttled.
 */

/**
 * Without a viewer (or one that stopped reporting), apps are throttled to roughly this frame callback interval so they
 * keep working but don't burn CPU rendering frames nobody sees.
 */
const DETACHED_FRAME_CALLBACK_DELAY = 1000
const VIEWER_FEEDBACK_TIMEOUT = 1500
const DETACHED_TICK_INTERVAL = 100
/**
 * The frame clock ticks at most this often (Hz): everything an app draws goes over the network, and 30 frames a second
 * is enough for smooth motion, so apps aren't asked for more (moving windows, the cursor and the shell are the
 * browser's, at the display's own rate). A viewer whose display refreshes less often slows it down to its rate.
 */
export const MAX_FRAME_RATE = 30
const MIN_TICK_INTERVAL = 1000 / MAX_FRAME_RATE
/**
 * Apps get frame callbacks at least this often (Hz), even while their surface isn't ready: a page that takes the link
 * seconds to send keeps updating (scrolling, typing) meanwhile, at the cost of tearing.
 */
export const MIN_FRAME_RATE = 10
export const MAX_FRAME_HOLD_MS = 1000 / MIN_FRAME_RATE

/** The frame clock's interval (ms) for a viewer whose display refreshes every `refreshInterval` ms (0: unknown). */
export function tickIntervalFor(refreshInterval: number): number {
  return Math.max(MIN_TICK_INTERVAL, refreshInterval > 0 ? refreshInterval : 0)
}

type PendingCallback = {
  callback: (time: number) => void
  /** ms left of the minimum wait (only without a pacing viewer) */
  frameCallbackDelay: number
  /** ms left until it goes even if the surface isn't ready (counted after the minimum wait) */
  holdLeft: number
  /** whether the surface is ready for a new frame */
  ready: () => boolean
  /** whether it may go after its longest hold even if not ready */
  mayForce: () => boolean
}

/** The frame callbacks waiting for a tick of the frame clock. */
export class FrameCallbackQueue {
  private queue: PendingCallback[] = []

  get length(): number {
    return this.queue.length
  }

  schedule(
    delay: number,
    ready: () => boolean,
    callback: (time: number) => void,
    mayForce: () => boolean = () => true,
    maxHold = MAX_FRAME_HOLD_MS,
  ): void {
    this.queue.push({ callback, frameCallbackDelay: delay, holdLeft: maxHold, ready, mayForce })
  }

  /**
   * One tick of the frame clock: call back everything whose delay has passed and that is ready, or has been held for
   * its longest hold and may be forced.
   */
  tick(tickInterval: number, time: number): void {
    if (this.queue.length === 0) {
      return
    }
    const current = this.queue
    this.queue = []
    const waiting: PendingCallback[] = []
    for (const pending of current) {
      if (pending.frameCallbackDelay > 0) {
        pending.frameCallbackDelay -= tickInterval
      } else {
        pending.holdLeft -= tickInterval
      }
      if (pending.frameCallbackDelay <= 0 && (pending.ready() || (pending.holdLeft <= 0 && pending.mayForce()))) {
        pending.callback(time)
      } else {
        waiting.push(pending)
      }
    }
    // callbacks may have scheduled new ones meanwhile (in this.queue)
    this.queue = waiting.concat(this.queue)
  }
}

/**
 * The session's frame pacing: the frame clock and the frame callbacks waiting for it, driven by the attached viewer.
 *
 * The frame clock ticks every `tickInterval` ms, scheduled against exact deadlines (timers only have whole
 * milliseconds: an interval timer of 33.3 ms would tick every 33). A changed interval applies from the next tick; a
 * clock that fell behind (a busy event loop) starts over from now instead of catching up with a burst of ticks.
 */
export class FramePacing implements FrameCallbackScheduler, ViewerPacing {
  private tickInterval = tickIntervalFor(0)
  private readonly callbacks = new FrameCallbackQueue()
  private nextTickAt = performance.now()
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private attached = false
  private lastFeedbackTimestamp = 0

  constructor() {
    this.scheduleTick()
  }

  /** Stops the frame clock. */
  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
  }

  setViewerAttached(attached: boolean): void {
    this.attached = attached
    this.lastFeedbackTimestamp = performance.now()
    if (!attached) {
      this.tickInterval = DETACHED_TICK_INTERVAL
    }
  }

  onViewerFeedback(refreshInterval: number): void {
    this.lastFeedbackTimestamp = performance.now()
    if (refreshInterval > 0) {
      this.tickInterval = tickIntervalFor(refreshInterval)
    }
  }

  /**
   * Call back on a later tick of the frame clock once `ready()` (the surface is ready for a new frame) is true, or
   * after MAX_FRAME_HOLD_MS anyway if `mayForce()` (the surface isn't streamed as video); throttled without a pacing
   * viewer. The callback gets the frame time (ms).
   */
  schedule(ready: () => boolean, callback: (time: number) => void, mayForce: () => boolean = () => true): void {
    this.callbacks.schedule(this.viewerIsPacing() ? 0 : DETACHED_FRAME_CALLBACK_DELAY, ready, callback, mayForce)
  }

  private viewerIsPacing(): boolean {
    return this.attached && performance.now() - this.lastFeedbackTimestamp < VIEWER_FEEDBACK_TIMEOUT
  }

  private scheduleTick() {
    if (this.stopped) {
      return
    }
    this.nextTickAt += this.tickInterval
    const now = performance.now()
    if (this.nextTickAt < now - this.tickInterval) {
      this.nextTickAt = now
    }
    this.timer = setTimeout(
      () => {
        this.callbacks.tick(this.tickInterval, performance.now() >>> 0)
        this.scheduleTick()
      },
      Math.max(0, this.nextTickAt - now),
    )
  }
}
