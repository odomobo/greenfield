/**
 * PNG encoding of streaming surfaces' patches on a few worker threads at the lowest OS priority (see "Encode scheduling"
 * in ROADMAP.md): relentless encoding only gets the CPU nothing else wants. The workers do the whole encode, row
 * filtering and `deflateSync`, on their own threads, so their nice level applies to all of it.
 */
import { Worker } from 'node:worker_threads'
import path from 'node:path'

/** How many streaming patches are encoded at once (one worker thread each). */
export const STREAMING_ENCODE_WORKERS = 2
/** Nice level of the worker threads (19 is the lowest priority). */
export const STREAMING_ENCODE_NICE = 19

export type WorkerRequest = { id: number; pixels: Uint8Array; width: number; height: number }
export type WorkerReply =
  | { type: 'ready'; tid: number }
  | { type: 'png'; id: number; png: Uint8Array }
  | { type: 'error'; id: number; message: string }

type Job = {
  request: WorkerRequest
  resolve: (png: Uint8Array) => void
  reject: (error: Error) => void
}

type Slot = {
  worker: Worker
  job?: Job
  ready: Promise<number>
}

const defaultWorkerFile = path.join(__dirname, 'png-worker.js')

/** The pixels as something that can be transferred without touching memory that belongs to someone else. */
function transferable(pixels: Uint8Array): { pixels: Uint8Array; transfer: ArrayBuffer[] } {
  if (
    pixels.buffer instanceof ArrayBuffer &&
    pixels.byteOffset === 0 &&
    pixels.byteLength === pixels.buffer.byteLength
  ) {
    return { pixels, transfer: [pixels.buffer] }
  }
  // a slice of a larger (e.g. pooled) buffer
  const copy = new Uint8Array(pixels)
  return { pixels: copy, transfer: [copy.buffer] }
}

export class StreamingPngPool {
  private readonly slots: Slot[] = []
  private readonly queue: Job[] = []
  private nextId = 1
  private cursor = 0
  private destroyed = false
  private warned = false
  /** called when capacity frees up (a job finished) */
  onCapacity?: () => void

  constructor(
    private readonly logger: { error(message: string): void },
    readonly workers = STREAMING_ENCODE_WORKERS,
    private readonly nice = STREAMING_ENCODE_NICE,
    private readonly workerFile = defaultWorkerFile,
  ) {
    for (let i = 0; i < workers; i++) {
      this.slots.push(this.spawn())
    }
  }

  /**
   * Whether another patch may be captured for this pool: each worker has one patch encoding and at most one waiting,
   * so patches never pile up here (they wait as queued rectangles in their surface, where new damage merges into them).
   */
  get canAccept(): boolean {
    return this.outstanding < this.workers * 2
  }

  /** patches encoding or waiting for a worker */
  get outstanding(): number {
    return this.queue.length + this.slots.filter((slot) => slot.job !== undefined).length
  }

  /** The OS thread ids of the workers (as in /proc/self/task/<tid>), once they have set their nice level. */
  threadIds(): Promise<number[]> {
    return Promise.all(this.slots.map((slot) => slot.ready))
  }

  /** Encode RGBA pixels as a PNG, the same bytes as `encodePng`. The pixels' buffer is transferred when possible. */
  encode(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
    if (this.destroyed) {
      return Promise.reject(new Error('The streaming encoder was destroyed.'))
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ request: { id: this.nextId++, pixels: rgba, width, height }, resolve, reject })
      this.dispatch()
    })
  }

  destroy(): void {
    this.destroyed = true
    for (const slot of this.slots) {
      void slot.worker.terminate()
      slot.job?.reject(new Error('The streaming encoder was destroyed.'))
    }
    for (const job of this.queue.splice(0)) {
      job.reject(new Error('The streaming encoder was destroyed.'))
    }
  }

  private spawn(): Slot {
    const worker = new Worker(this.workerFile, { workerData: { nice: this.nice } })
    worker.unref()
    const slot: Slot = {
      worker,
      ready: new Promise<number>((resolve) => {
        worker.once('message', (reply: WorkerReply) => {
          if (reply.type === 'ready') {
            if (reply.tid < 0 && !this.warned) {
              this.warned = true
              this.logger.error(
                `Could not lower the priority of the streaming encode threads (errno ${-reply.tid}), they run at normal priority.`,
              )
            }
            resolve(reply.tid)
          }
        })
      }),
    }
    worker.on('message', (reply: WorkerReply) => {
      if (reply.type === 'ready') {
        return
      }
      const job = slot.job
      if (job === undefined || job.request.id !== reply.id) {
        return
      }
      slot.job = undefined
      if (reply.type === 'png') {
        job.resolve(reply.png)
      } else {
        job.reject(new Error(reply.message))
      }
      this.dispatch()
      this.onCapacity?.()
    })
    worker.on('error', (error) => {
      this.logger.error(`Streaming encode worker failed: ${error.message}`)
      const job = slot.job
      slot.job = undefined
      job?.reject(error)
      this.replace(slot)
    })
    worker.on('exit', () => {
      if (!this.destroyed && this.slots.includes(slot)) {
        const job = slot.job
        slot.job = undefined
        job?.reject(new Error('The streaming encode worker exited.'))
        this.replace(slot)
      }
    })
    return slot
  }

  private replace(slot: Slot) {
    const index = this.slots.indexOf(slot)
    if (index < 0 || this.destroyed) {
      return
    }
    void slot.worker.terminate()
    this.slots[index] = this.spawn()
    this.dispatch()
    this.onCapacity?.()
  }

  private dispatch() {
    while (this.queue.length) {
      let slot: Slot | undefined
      for (let i = 0; i < this.slots.length; i++) {
        const candidate = this.slots[(this.cursor + i) % this.slots.length]
        if (candidate.job === undefined) {
          slot = candidate
          this.cursor = (this.cursor + i + 1) % this.slots.length
          break
        }
      }
      if (slot === undefined) {
        return
      }
      const job = this.queue.shift()!
      slot.job = job
      const { pixels, transfer } = transferable(job.request.pixels)
      const message: WorkerRequest = { ...job.request, pixels }
      try {
        slot.worker.postMessage(message, transfer)
      } catch {
        // not transferable (e.g. memory owned by native code): copy it
        try {
          slot.worker.postMessage({ ...message, pixels: new Uint8Array(pixels) })
        } catch (e) {
          slot.job = undefined
          job.reject(e as Error)
        }
      }
    }
  }
}
