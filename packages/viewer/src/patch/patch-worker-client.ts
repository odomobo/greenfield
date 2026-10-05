import type { Patch } from '../protocol'
import type { PatchDecodeReply, PatchDecodeRequest } from './patch-worker'
import PatchWorker from './patch-worker.ts?worker'

/** A decoded patch: its image, and for a JPEG with alpha the alpha as a second image (in its red channel). */
export type PatchImages = { bitmap: ImageBitmap; alpha?: ImageBitmap }

/** Decodes patches in a Web Worker (started on first use). */
export class PatchDecoderClient {
  private worker?: Worker
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (images: PatchImages) => void; reject: (error: Error) => void }>()

  decode(patch: Patch): Promise<PatchImages> {
    const worker = this.start()
    const id = this.nextId++
    // our own copy: `patch.data` is a view into the received message, which must not travel along with it
    const data = patch.data.slice()
    const request: PatchDecodeRequest = {
      id,
      format: patch.format,
      channels: patch.channels,
      width: patch.rect.width,
      height: patch.rect.height,
      data,
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage(request, [data.buffer])
    })
  }

  private start(): Worker {
    if (this.worker === undefined) {
      const worker = new PatchWorker()
      worker.onmessage = (event: MessageEvent<PatchDecodeReply>) => {
        const reply = event.data
        const pending = this.pending.get(reply.id)
        this.pending.delete(reply.id)
        if (pending === undefined) {
          if ('bitmap' in reply) {
            reply.bitmap.close()
            reply.alpha?.close()
          }
        } else if ('bitmap' in reply) {
          pending.resolve({ bitmap: reply.bitmap, alpha: reply.alpha })
        } else {
          pending.reject(new Error(reply.error))
        }
      }
      worker.onerror = (event) => {
        const error = new Error(`The patch decoder failed: ${event.message}`)
        for (const pending of this.pending.values()) {
          pending.reject(error)
        }
        this.pending.clear()
        worker.terminate()
        this.worker = undefined
      }
      this.worker = worker
    }
    return this.worker
  }
}
