/**
 * Worker thread of PatchWorkerPool: sets its own OS thread's priority first thing, then encodes the patches it is sent
 * (the native QOI cascade, or JPEG), one at a time.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { encodePatch, setThreadNice } from './patch-encoder.js'
import type { WorkerReply, WorkerRequest } from './PatchWorkerPool.js'

const port = parentPort!

function reply(message: WorkerReply, transfer: ArrayBuffer[] = []) {
  port.postMessage(message, transfer)
}

// the thread id, or minus errno if the nice level could not be set (the worker then just runs at normal priority)
reply({ type: 'ready', tid: setThreadNice(workerData.nice) })

port.on('message', ({ id, pixels, width, height, opaque, lossy }: WorkerRequest) => {
  try {
    const patch = encodePatch(pixels, width, height, opaque, lossy)
    // the native encoder gives the bytes their own ArrayBuffer, so they are transferred, not copied
    reply({ type: 'patch', id, patch }, [patch.data.buffer as ArrayBuffer])
  } catch (e: any) {
    reply({ type: 'error', id, message: e?.message ?? String(e) })
  }
})
