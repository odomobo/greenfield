import { destroyWlResourceSilently, flush, sendEvents, WlClient } from './wayland-server.js'
import { ProcessingDuration, scheduleFrameCallback } from './FramePacing.js'

export { onViewerFeedback, setViewerAttached } from './FramePacing.js'

export class FrameFeedback {
  private destroyed = false
  private readonly processingDuration = new ProcessingDuration()

  constructor(
    private wlClient: WlClient,
    private messageInterceptors: Record<number, any>,
  ) {}

  destroy() {
    this.destroyed = true
  }

  commitNotify(frameCallbacksIds: number[]): void {
    scheduleFrameCallback(this.processingDuration.average, (time) => {
      if (this.destroyed) {
        return
      }
      this.sendFrameDoneEventsWithCallbacks(time, frameCallbacksIds)
    })
  }

  encodingDone(commitTimestamp: number): void {
    this.processingDuration.record(commitTimestamp)
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
