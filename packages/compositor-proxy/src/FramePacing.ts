import { performance } from 'node:perf_hooks'

/**
 * Frame callback pacing shared by all surfaces of the session, driven by the attached viewer. No native code.
 *
 * A surface's frame callbacks are held while it has no free slot (it has as many items between capture and the socket
 * as it may), and released at the next tick of the frame clock once it has one. So an app slows down to what can be
 * sent (the transport's congestion control and the viewer's backlog decide when items go out, see ROADMAP.md). Without
 * a viewer apps are throttled.
 */

/**
 * Without a viewer (or one that stopped reporting), apps are throttled to roughly this frame callback interval so they
 * keep working but don't burn CPU rendering frames nobody sees.
 */
const DETACHED_FRAME_CALLBACK_DELAY = 1000
const VIEWER_FEEDBACK_TIMEOUT = 1500
const DETACHED_TICK_INTERVAL = 100
const DEFAULT_TICK_INTERVAL = 16.667

type PendingCallback = {
  callback: (time: number) => void
  /** ms left of the minimum wait (only without a pacing viewer) */
  frameCallbackDelay: number
  /** whether the surface has a free slot */
  ready: () => boolean
}

/** The frame callbacks waiting for a tick of the frame clock. */
export class FrameCallbackQueue {
  private queue: PendingCallback[] = []

  get length(): number {
    return this.queue.length
  }

  schedule(delay: number, ready: () => boolean, callback: (time: number) => void): void {
    this.queue.push({ callback, frameCallbackDelay: delay, ready })
  }

  /** One tick of the frame clock: call back everything whose delay has passed and that is ready. */
  tick(tickInterval: number, time: number): void {
    if (this.queue.length === 0) {
      return
    }
    const current = this.queue
    this.queue = []
    const waiting: PendingCallback[] = []
    for (const pending of current) {
      pending.frameCallbackDelay -= tickInterval
      if (pending.frameCallbackDelay <= 0 && pending.ready()) {
        pending.callback(time)
      } else {
        waiting.push(pending)
      }
    }
    // callbacks may have scheduled new ones meanwhile (in this.queue)
    this.queue = waiting.concat(this.queue)
  }
}

let tickInterval = DEFAULT_TICK_INTERVAL
let nextTickInterval = tickInterval
let feedbackClockTimer: NodeJS.Timeout | undefined
const callbacks = new FrameCallbackQueue()

function configureFramePipelineTicks(interval: number) {
  if (feedbackClockTimer) {
    return
  }

  tickInterval = interval
  feedbackClockTimer = setInterval(() => {
    callbacks.tick(tickInterval, performance.now() >>> 0)

    if (tickInterval !== nextTickInterval) {
      if (feedbackClockTimer) {
        clearInterval(feedbackClockTimer)
        feedbackClockTimer = undefined
      }
      configureFramePipelineTicks(nextTickInterval)
    }
  }, tickInterval)
}

configureFramePipelineTicks(nextTickInterval)

const viewerPacing = {
  attached: false,
  lastFeedbackTimestamp: 0,
}

export function setViewerAttached(attached: boolean): void {
  viewerPacing.attached = attached
  viewerPacing.lastFeedbackTimestamp = performance.now()
  if (!attached) {
    nextTickInterval = DETACHED_TICK_INTERVAL
  }
}

export function onViewerFeedback(refreshInterval: number): void {
  viewerPacing.lastFeedbackTimestamp = performance.now()
  if (refreshInterval > 0) {
    nextTickInterval = Math.floor(refreshInterval)
    if (Math.abs(tickInterval - nextTickInterval) > 500 && feedbackClockTimer) {
      clearInterval(feedbackClockTimer)
      feedbackClockTimer = undefined
      configureFramePipelineTicks(nextTickInterval)
    }
  }
}

function viewerIsPacing(): boolean {
  return viewerPacing.attached && performance.now() - viewerPacing.lastFeedbackTimestamp < VIEWER_FEEDBACK_TIMEOUT
}

/**
 * Call back on a later tick of the frame clock once `ready()` (the surface has a free slot) is true; throttled without
 * a pacing viewer. The callback gets the frame time (ms).
 */
export function scheduleFrameCallback(ready: () => boolean, callback: (time: number) => void): void {
  callbacks.schedule(viewerIsPacing() ? 0 : DETACHED_FRAME_CALLBACK_DELAY, ready, callback)
}
