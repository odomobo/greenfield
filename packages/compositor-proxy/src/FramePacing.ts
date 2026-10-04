import { performance } from 'node:perf_hooks'

/**
 * Frame callback pacing shared by all surfaces of the session, driven by the attached viewer. No native code.
 */

let tickInterval = 16.667
let nextTickInterval = tickInterval
let feedbackClockTimer: NodeJS.Timeout | undefined
type Feedback = { callback: (time: number) => void; frameCallbackDelay: number }
let feedbackClockQueue: Feedback[] = []

function configureFramePipelineTicks(interval: number) {
  if (feedbackClockTimer) {
    return
  }

  tickInterval = interval
  feedbackClockTimer = setInterval(() => {
    if (feedbackClockQueue.length) {
      const time = performance.now() >>> 0
      for (const feedback of feedbackClockQueue) {
        feedback.frameCallbackDelay -= tickInterval
        if (feedback.frameCallbackDelay <= 0) {
          feedback.callback(time)
        }
      }
      feedbackClockQueue = feedbackClockQueue.filter((feedback) => feedback.frameCallbackDelay > 0)
    }

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
  /** ms the viewer needs to decode a frame */
  decodeDuration: 0,
  lastFeedbackTimestamp: 0,
}

/**
 * Without a viewer (or one that stopped reporting), apps are throttled to roughly this frame callback interval so they
 * keep working but don't burn CPU rendering frames nobody sees.
 */
const DETACHED_FRAME_CALLBACK_DELAY = 1000
const VIEWER_FEEDBACK_TIMEOUT = 1500
const DETACHED_TICK_INTERVAL = 100

export function setViewerAttached(attached: boolean): void {
  viewerPacing.attached = attached
  viewerPacing.lastFeedbackTimestamp = performance.now()
  if (!attached) {
    nextTickInterval = DETACHED_TICK_INTERVAL
  }
}

export function onViewerFeedback(refreshInterval: number, decodeDuration: number): void {
  viewerPacing.lastFeedbackTimestamp = performance.now()
  viewerPacing.decodeDuration = decodeDuration
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
 * Call back on a later tick of the frame clock: once the server's processing (encoding) and the viewer's decoding of
 * a frame would be done, or throttled without a pacing viewer. The callback gets the frame time (ms).
 */
export function scheduleFrameCallback(avgServerProcessingDuration: number, callback: (time: number) => void): void {
  feedbackClockQueue.push({
    callback,
    frameCallbackDelay: viewerIsPacing()
      ? Math.floor(Math.max(avgServerProcessingDuration, viewerPacing.decodeDuration))
      : DETACHED_FRAME_CALLBACK_DELAY,
  })
}

/** Rolling average of how long the server takes from commit to encoded, per surface. */
export class ProcessingDuration {
  private readonly durations: number[] = []
  average = 0

  record(commitTimestamp: number): void {
    this.durations.push(performance.now() - commitTimestamp)
    if (this.durations.length > 60) {
      this.durations.shift()
    }
    let sum = 0
    for (const duration of this.durations) {
      sum += duration
    }
    this.average = sum / this.durations.length
  }
}
