import { destroyWlResourceSilently, flush, sendEvents, WlClient } from './wayland-server.js'
import { performance } from 'node:perf_hooks'

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

/**
 * Frame callback pacing shared by all surfaces of the session, driven by the attached viewer.
 */
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

export class FrameFeedback {
  private serverProcessingDurations: number[] = []
  private destroyed = false
  private avgServerProcessingDuration = 0

  constructor(
    private wlClient: WlClient,
    private messageInterceptors: Record<number, any>,
  ) {}

  destroy() {
    this.destroyed = true
  }

  commitNotify(frameCallbacksIds: number[]): void {
    feedbackClockQueue.push({
      callback: (time) => {
        if (this.destroyed) {
          return
        }
        this.sendFrameDoneEventsWithCallbacks(time, frameCallbacksIds)
      },
      frameCallbackDelay: viewerIsPacing()
        ? Math.floor(Math.max(this.avgServerProcessingDuration, viewerPacing.decodeDuration))
        : DETACHED_FRAME_CALLBACK_DELAY,
    })
  }

  encodingDone(commitTimestamp: number): void {
    this.serverProcessingDurations.push(performance.now() - commitTimestamp)
    if (this.serverProcessingDurations.length > 60) {
      this.serverProcessingDurations.shift()
    }
    let serverProcessingDurationSum = 0
    for (const serverProcessingDuration of this.serverProcessingDurations) {
      serverProcessingDurationSum += serverProcessingDuration
    }
    this.avgServerProcessingDuration = serverProcessingDurationSum / this.serverProcessingDurations.length
  }

  sendFrameDoneEventsWithCallbacks(frameDoneTimestamp: number, frameCallbackIds: number[]) {
    for (const frameCallbackId of frameCallbackIds) {
      this.sendFrameDoneEvent(frameDoneTimestamp, frameCallbackId)
      delete this.messageInterceptors[frameCallbackId]
    }

    // this.syncChildren.forEach((syncChild) => syncChild.sendDoneEvents(frameDoneTimestamp))
  }

  private sendFrameDoneEvent(frameDoneTimestamp: number, callbackResourceId: number) {
    const doneSize = 12 // id+size+opcode+time arg
    const deleteSize = 12 // id+size+opcode+id arg

    const messagesBuffer = new ArrayBuffer(doneSize + deleteSize)

    // send done event to callback
    const doneBufu32 = new Uint32Array(messagesBuffer)
    const doneBufu16 = new Uint16Array(messagesBuffer)
    doneBufu32[0] = callbackResourceId
    doneBufu16[2] = 0 // done opcode
    doneBufu16[3] = doneSize
    doneBufu32[2] = frameDoneTimestamp >>> 0

    // send delete id event to display
    const deleteBufu32 = new Uint32Array(messagesBuffer, doneSize)
    const deleteBufu16 = new Uint16Array(messagesBuffer, doneSize)
    deleteBufu32[0] = 1
    deleteBufu16[2] = 1 // delete opcode
    deleteBufu16[3] = deleteSize
    deleteBufu32[2] = callbackResourceId

    sendEvents(this.wlClient, doneBufu32, new Uint32Array([]))
    flush(this.wlClient)

    destroyWlResourceSilently(this.wlClient, callbackResourceId)
  }

  sendBufferReleaseEvent(bufferResourceId: number) {
    const releaseSize = 8 // id+size+opcode
    const releaseBuffer = new ArrayBuffer(releaseSize)
    const releaseBufu32 = new Uint32Array(releaseBuffer)
    const releaseBufu16 = new Uint16Array(releaseBuffer)
    releaseBufu32[0] = bufferResourceId
    releaseBufu16[2] = 0 // release opcode
    releaseBufu16[3] = releaseSize
    sendEvents(this.wlClient, releaseBufu32, new Uint32Array([]))
    flush(this.wlClient)
  }
}
