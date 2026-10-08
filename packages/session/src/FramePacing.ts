import { performance } from 'node:perf_hooks'

/**
 * Frame callback pacing shared by all surfaces of the session, driven by the attached viewer. No native code.
 *
 * A surface's frame callbacks are held while it isn't ready for a new frame (its slots are full of damage: it has as
 * many items between capture and the socket as it may), and released at the next tick of the frame clock once it is.
 * So an app slows down to what can be sent (the transport's congestion control and the viewer's backlog decide when
 * items go out, see ARCHITECTURE.md). But a surface sent as patches never below MIN_FRAME_RATE: after MAX_FRAME_HOLD_MS the
 * callback goes anyway, and the app's next frame is queued as damage, read when a slot frees (a slow repaint may then
 * show parts of different frames, but the app keeps responding). Not one streamed as video: a video frame is the whole
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

let tickInterval = tickIntervalFor(0)
const callbacks = new FrameCallbackQueue()

/**
 * The frame clock: ticks every `tickInterval` ms, scheduled against exact deadlines (timers only have whole
 * milliseconds: an interval timer of 33.3 ms would tick every 33). A changed interval applies from the next tick; a
 * clock that fell behind (a busy event loop) starts over from now instead of catching up with a burst of ticks.
 */
let nextTickAt = performance.now()
function scheduleTick() {
  nextTickAt += tickInterval
  const now = performance.now()
  if (nextTickAt < now - tickInterval) {
    nextTickAt = now
  }
  setTimeout(
    () => {
      const interval = tickInterval
      callbacks.tick(interval, performance.now() >>> 0)
      scheduleTick()
    },
    Math.max(0, nextTickAt - now),
  )
}
scheduleTick()

const viewerPacing = {
  attached: false,
  lastFeedbackTimestamp: 0,
}

export function setViewerAttached(attached: boolean): void {
  viewerPacing.attached = attached
  viewerPacing.lastFeedbackTimestamp = performance.now()
  if (!attached) {
    tickInterval = DETACHED_TICK_INTERVAL
  }
}

export function onViewerFeedback(refreshInterval: number): void {
  viewerPacing.lastFeedbackTimestamp = performance.now()
  if (refreshInterval > 0) {
    tickInterval = tickIntervalFor(refreshInterval)
  }
}

function viewerIsPacing(): boolean {
  return viewerPacing.attached && performance.now() - viewerPacing.lastFeedbackTimestamp < VIEWER_FEEDBACK_TIMEOUT
}

/**
 * Call back on a later tick of the frame clock once `ready()` (the surface is ready for a new frame) is true, or after
 * MAX_FRAME_HOLD_MS anyway if `mayForce()` (the surface isn't streamed as video); throttled without a pacing viewer.
 * The callback gets the frame time (ms).
 */
export function scheduleFrameCallback(
  ready: () => boolean,
  callback: (time: number) => void,
  mayForce: () => boolean = () => true,
): void {
  callbacks.schedule(viewerIsPacing() ? 0 : DETACHED_FRAME_CALLBACK_DELAY, ready, callback, mayForce)
}
