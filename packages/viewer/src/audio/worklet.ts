/**
 * The AudioWorklet of the session's audio: runs on the audio thread, fed decoded audio by the main thread (see
 * player.ts) and plays it through the jitter buffer (jitter-buffer.ts), which holds all the logic.
 *
 * Messages in: `{ type: 'audio', left, right }` (Float32Arrays, transferred), `{ type: 'stop' }` (fade out and drop
 * what is buffered: muting, a new stream).
 * Messages out: `{ type: 'stats', ...JitterBufferStats }`, about every 100 ms.
 */
import { JitterBuffer } from './jitter-buffer'

// the worklet scope's globals (not in the DOM library)
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

/** the name the main thread creates the node with */
const PROCESSOR_NAME = 'nebula-audio'
const STATS_EVERY_BLOCKS = 40

class NebulaAudioProcessor extends AudioWorkletProcessor {
  private readonly buffer = new JitterBuffer({ sampleRate })
  private blocks = 0

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent) => {
      const message = event.data
      if (message.type === 'audio') {
        this.buffer.push(message.left, message.right)
      } else if (message.type === 'stop') {
        this.buffer.stop()
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]
    const left = output[0]
    // stereo is what is asked for (outputChannelCount); the browser mixes it down for the device
    const right = output[1] ?? new Float32Array(left.length)
    this.buffer.read(left, right)
    if (++this.blocks % STATS_EVERY_BLOCKS === 0) {
      this.port.postMessage({ type: 'stats', ...this.buffer.stats })
    }
    return true
  }
}

registerProcessor(PROCESSOR_NAME, NebulaAudioProcessor)
