/**
 * Worker thread of StreamingPngPool: lowers its own OS thread's priority first thing, then encodes the patches it is
 * sent, one at a time.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { setThreadNice } from '../socket-options.js'
import { encodePngSync } from './png.js'
import type { WorkerReply, WorkerRequest } from './StreamingEncoder.js'

const port = parentPort!

function reply(message: WorkerReply, transfer: ArrayBuffer[] = []) {
  port.postMessage(message, transfer)
}

// the thread id, or minus errno if the nice level could not be set (the worker then just runs at normal priority)
reply({ type: 'ready', tid: setThreadNice(workerData.nice) })

port.on('message', ({ id, pixels, width, height }: WorkerRequest) => {
  try {
    const png = encodePngSync(pixels, width, height)
    // a fresh buffer of its own (Buffers can be slices of a shared pool), so it can be transferred
    const out = new Uint8Array(png.length)
    out.set(png)
    reply({ type: 'png', id, png: out }, [out.buffer])
  } catch (e: any) {
    reply({ type: 'error', id, message: e?.message ?? String(e) })
  }
})
