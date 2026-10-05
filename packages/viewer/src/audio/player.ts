/**
 * The session's audio in the browser: Opus packets from the server (AUDIO envelopes) -> WebCodecs `AudioDecoder` ->
 * an AudioWorklet with the jitter buffer (worklet.ts, jitter-buffer.ts) -> the speakers. Playback only.
 *
 * - Browsers start audio only after a user gesture: the AudioContext is created (and resumed) on the first pointer or
 *   key event, and again on every later one while it is suspended. Until it runs, the viewer tells the server it is
 *   muted (nothing is sent that we couldn't play), and says so again once it runs.
 * - The mute toggle is the user's: remembered per viewer (localStorage) and sent to the server whenever it changes
 *   and on every (re)connection. A muted server sends nothing and captures nothing.
 * - The decoder gets a fresh start whenever the stream restarts (reconnecting, unmuting): the server's packet
 *   sequence and timestamps start anew then.
 */
import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, audioPacketsLost, AudioPacket, ViewerMessage } from '../protocol'
import { audioStore } from '../state'
import type { JitterBufferStats } from './jitter-buffer'
import workletUrl from './worklet.ts?worker&url'

const MUTED_KEY = 'nebula-audio-muted'
/**
 * The frames a fresh Opus decoder puts out first that aren't audio yet: the encoder's lookahead (Opus's usual pre-skip,
 * 6.5 ms at 48 kHz). Every stream starts with a new decoder (the server's encoder starts anew too), and these frames
 * would start it with a crackle.
 */
const OPUS_PRE_SKIP_FRAMES = 312
/** the duration of one Opus packet, in microseconds (the protocol's 20 ms) */
const PACKET_MICROSECONDS = 20_000

function loadMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === '1'
  } catch {
    return false
  }
}

function saveMuted(muted: boolean) {
  try {
    localStorage.setItem(MUTED_KEY, muted ? '1' : '0')
  } catch {
    // private window or blocked storage: not remembered
  }
}

/** Whether this browser can play the session's audio at all (WebCodecs needs a secure context). */
function audioSupported(): boolean {
  return (
    typeof AudioDecoder !== 'undefined' &&
    typeof EncodedAudioChunk !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined'
  )
}

export type AudioDebug = {
  contextState: string
  muted: boolean
  available: boolean
  /** what the server was last told */
  sentMuted: boolean | undefined
  /** packets received (also while muted, in flight) and milliseconds since the last one arrived */
  packets: number
  sinceLastPacketMs: number | undefined
  lost: number
  decodedFrames: number
  /** the largest sample decoded since the stream (re)started */
  peak: number
  decoderErrors: number
  buffer: JitterBufferStats | undefined
}

export class AudioPlayer {
  private context?: AudioContext
  private node?: AudioWorkletNode
  /** the node is connected and the context runs */
  private running = false
  private decoder?: AudioDecoder
  private decodedPackets = 0
  private lastSeq?: number
  private muted = loadMuted()
  private available = false
  private readonly supported = audioSupported()
  private sentMuted?: boolean
  private bufferStats?: JitterBufferStats
  private packets = 0
  private lastPacketAt?: number
  private lost = 0
  private decodedFrames = 0
  /** frames of the current decoder's output still to drop (its warm-up) */
  private skipFrames = 0
  private peak = 0
  private decoderErrors = 0

  constructor(private readonly send: (message: ViewerMessage) => void) {
    this.publish()
  }

  /** Create or resume the audio context on user input; returns the function that stops listening. */
  install(): () => void {
    const onGesture = () => this.unlock()
    const events = ['pointerdown', 'keydown', 'touchend'] as const
    for (const name of events) {
      window.addEventListener(name, onGesture, { capture: true })
    }
    return () => {
      for (const name of events) {
        window.removeEventListener(name, onGesture, { capture: true })
      }
    }
  }

  /** A (new) connection to the session opened: the server starts from scratch. */
  onOpen(): void {
    this.sentMuted = undefined
    this.available = false
    this.resetStream()
    this.publish()
    this.sync()
  }

  /** The server says whether the session has audio. */
  setAvailable(available: boolean): void {
    this.available = available
    this.publish()
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    saveMuted(muted)
    // the click that unmutes is a user gesture
    this.unlock()
    this.publish()
    this.sync()
  }

  toggleMuted(): void {
    this.setMuted(!this.muted)
  }

  /** Called on user input: browsers allow audio from then on. */
  unlock(): void {
    if (!this.supported) {
      return
    }
    if (this.context === undefined) {
      this.createContext()
    } else if (this.context.state !== 'running') {
      this.context.resume().catch(() => undefined)
    }
  }

  /** An audio packet arrived. */
  handlePacket(packet: AudioPacket): void {
    this.packets++
    this.lastPacketAt = performance.now()
    if (this.silenced) {
      return
    }
    if (this.lastSeq !== undefined) {
      this.lost += audioPacketsLost(this.lastSeq, packet.seq)
    }
    this.lastSeq = packet.seq
    try {
      const decoder = this.decoder ?? this.createDecoder()
      decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: this.decodedPackets++ * PACKET_MICROSECONDS,
          data: packet.opus,
        }),
      )
    } catch (e) {
      this.decoderFailed(e)
    }
  }

  debug(): AudioDebug {
    return {
      contextState: this.context?.state ?? 'none',
      muted: this.muted,
      available: this.available,
      sentMuted: this.sentMuted,
      packets: this.packets,
      sinceLastPacketMs: this.lastPacketAt === undefined ? undefined : performance.now() - this.lastPacketAt,
      lost: this.lost,
      decodedFrames: this.decodedFrames,
      peak: this.peak,
      decoderErrors: this.decoderErrors,
      buffer: this.bufferStats,
    }
  }

  /** whether packets are of no use now: the user muted, or we can't play yet */
  private get silenced(): boolean {
    return this.muted || !this.running
  }

  private publish() {
    audioStore.update({
      muted: this.muted,
      available: this.available,
      supported: this.supported,
      running: this.running,
    })
  }

  /** Tell the server what we want, if that changed. */
  private sync() {
    const muted = this.silenced || !this.supported
    if (muted === this.sentMuted) {
      return
    }
    this.sentMuted = muted
    this.send({ type: 'audio.mute', muted })
    if (muted) {
      this.resetStream()
    }
  }

  private createContext() {
    let context: AudioContext
    try {
      // 48 kHz is what the stream is; a device with another rate is resampled by the browser
      context = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE, latencyHint: 'playback' })
    } catch (e) {
      console.error('No audio context', e)
      return
    }
    this.context = context
    context.onstatechange = () => this.onContextState()
    context.audioWorklet
      .addModule(workletUrl)
      .then(() => {
        const node = new AudioWorkletNode(context, 'nebula-audio', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [AUDIO_CHANNELS],
        })
        node.port.onmessage = (event) => {
          if (event.data?.type === 'stats') {
            this.bufferStats = event.data
          }
        }
        node.connect(context.destination)
        this.node = node
        this.onContextState()
      })
      .catch((e) => console.error('The audio worklet failed to load', e))
    this.onContextState()
    if (context.state !== 'running') {
      context.resume().catch(() => undefined)
    }
  }

  private onContextState() {
    const running = this.context?.state === 'running' && this.node !== undefined
    if (running === this.running) {
      return
    }
    this.running = running
    this.publish()
    this.sync()
  }

  private createDecoder(): AudioDecoder {
    const decoder = new AudioDecoder({
      output: (data) => this.onDecoded(data),
      error: (e) => this.decoderFailed(e),
    })
    decoder.configure({ codec: 'opus', sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: AUDIO_CHANNELS })
    this.decoder = decoder
    this.skipFrames = OPUS_PRE_SKIP_FRAMES
    return decoder
  }

  private onDecoded(data: AudioData) {
    const frames = data.numberOfFrames
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    data.copyTo(left, { planeIndex: 0, format: 'f32-planar' })
    if (data.numberOfChannels > 1) {
      data.copyTo(right, { planeIndex: 1, format: 'f32-planar' })
    } else {
      right.set(left)
    }
    data.close()
    this.decodedFrames += frames
    for (let i = 0; i < frames; i++) {
      this.peak = Math.max(this.peak, Math.abs(left[i]))
    }
    if (this.silenced || this.decoder === undefined) {
      return
    }
    const skip = Math.min(this.skipFrames, frames)
    this.skipFrames -= skip
    if (skip === frames) {
      return
    }
    const outLeft = skip > 0 ? left.slice(skip) : left
    const outRight = skip > 0 ? right.slice(skip) : right
    this.node?.port.postMessage({ type: 'audio', left: outLeft, right: outRight }, [outLeft.buffer, outRight.buffer])
  }

  private decoderFailed(error: unknown) {
    this.decoderErrors++
    if (this.decoderErrors <= 3) {
      console.error('The audio decoder failed', error)
    }
    this.closeDecoder()
  }

  private closeDecoder() {
    const decoder = this.decoder
    this.decoder = undefined
    try {
      if (decoder !== undefined && decoder.state !== 'closed') {
        decoder.close()
      }
    } catch {
      // already closed
    }
  }

  /** Forget the stream: decoder state, packet numbering, and what is queued for playback (faded out, no click). */
  private resetStream() {
    this.closeDecoder()
    this.decodedPackets = 0
    this.lastSeq = undefined
    this.peak = 0
    this.node?.port.postMessage({ type: 'stop' })
  }
}
