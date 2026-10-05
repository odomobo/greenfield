/**
 * The viewer's audio jitter buffer: pure sample math, no browser APIs, so it is unit tested; the AudioWorklet
 * (worklet.ts) only calls `push` with decoded audio and `read` to fill its output.
 *
 * Simple on purpose:
 * - A fixed target level (default 70 ms). Playback starts once the buffer holds the target.
 * - The server's capture clock and the browser's audio clock differ a little. The buffer's level (smoothed) is held at
 *   the target by playing at a slightly different rate, plain linear interpolation, at most +-0.1% (about 1.7 cents
 *   of pitch, inaudible). No prediction, no time stretching.
 * - Underrun: when the buffer is about to run dry, the audio fades out over a few milliseconds (10 ms, real samples,
 *   so no click), then it is silent until the buffer holds the target again (rebuffering), then fades in.
 * - Stop (muting, a new stream): the same fade out, then what was buffered before the stop is dropped and the next
 *   stream starts like the first, with a fade in. Never a jump to silence: that is a click.
 * - Backlog: over the maximum (300 ms, e.g. after the tab was in the background, or a network stall that released a
 *   burst) the excess is dropped, with a short crossfade (5 ms) from where we were to where we continue.
 * - No packet loss concealment: a lost packet is simply not there.
 *
 * Positions are frame counts since the start (a double, exact up to 2^53); the read position is fractional.
 */

export type JitterBufferOptions = {
  sampleRate: number
  /** the level to hold and to rebuffer to (ms) */
  targetMs: number
  /** above this the excess is dropped (ms) */
  maxMs: number
  /** the length of the fade out when running dry and of the fade in when starting again (ms) */
  fadeMs: number
  /** the length of the crossfade over a drop (ms) */
  crossfadeMs: number
  /** the largest rate change, as a fraction (0.001 is 0.1%) */
  maxRateAdjust: number
  /** the level error (ms) at which the rate change reaches its maximum */
  rateRangeMs: number
  /** the time constant of the level smoothing the rate follows (s) */
  smoothingSeconds: number
}

export const defaultJitterBufferOptions: JitterBufferOptions = {
  sampleRate: 48000,
  targetMs: 160,
  maxMs: 360,
  fadeMs: 10,
  crossfadeMs: 5,
  maxRateAdjust: 0.001,
  rateRangeMs: 30,
  smoothingSeconds: 0.5,
}

/** buffering: silent, waiting for the target; fading-in, playing; fading-out: about to run dry */
export type JitterBufferState = 'buffering' | 'fading-in' | 'playing' | 'fading-out'

export type JitterBufferStats = {
  state: JitterBufferState
  /** frames waiting */
  level: number
  /** the rate relative to real time of the last block (1: not adjusted) */
  rate: number
  /** times the buffer ran dry */
  underruns: number
  /** times a backlog was dropped, and the frames dropped by that */
  drops: number
  droppedFrames: number
  /** frames pushed and frames played so far (the read position, not counting the fractions) */
  pushedFrames: number
  playedFrames: number
}

/** frames of slack beyond the block and the fade when deciding the buffer is about to run dry */
const UNDERRUN_MARGIN_FRAMES = 16

export class JitterBuffer {
  private readonly options: JitterBufferOptions
  private readonly capacity: number
  private readonly left: Float32Array
  private readonly right: Float32Array
  private readonly targetFrames: number
  private readonly maxFrames: number
  private readonly fadeFrames: number
  private readonly crossfadeFrames: number
  private readonly rangeFrames: number

  private writePos = 0
  private readPos = 0
  private state: JitterBufferState = 'buffering'
  private gain = 0
  private smoothedLevel = 0
  private rate = 1
  /** a drop in progress: the frames still to crossfade, and how far ahead we jump when done */
  private crossfadeLeft = 0
  private crossfadeSkip = 0
  /** frames pushed before `stop()`: dropped once its fade out is done */
  private discardUntil = 0
  private underruns = 0
  private drops = 0
  private droppedFrames = 0

  constructor(options: Partial<JitterBufferOptions> = {}) {
    this.options = { ...defaultJitterBufferOptions, ...options }
    const frames = (ms: number) => Math.round((this.options.sampleRate * ms) / 1000)
    this.targetFrames = frames(this.options.targetMs)
    this.maxFrames = frames(this.options.maxMs)
    this.fadeFrames = Math.max(1, frames(this.options.fadeMs))
    this.crossfadeFrames = Math.max(1, frames(this.options.crossfadeMs))
    this.rangeFrames = Math.max(1, frames(this.options.rateRangeMs))
    // a power of two with room for the maximum, a burst on top of it and the crossfade lookahead
    let capacity = 1024
    while (capacity < this.maxFrames * 2 + this.targetFrames) {
      capacity *= 2
    }
    this.capacity = capacity
    this.left = new Float32Array(capacity)
    this.right = new Float32Array(capacity)
  }

  get level(): number {
    return this.writePos - this.readPos
  }

  get stats(): JitterBufferStats {
    return {
      state: this.state,
      level: this.level,
      rate: this.rate,
      underruns: this.underruns,
      drops: this.drops,
      droppedFrames: this.droppedFrames,
      pushedFrames: this.writePos,
      playedFrames: Math.floor(this.readPos),
    }
  }

  /** Forget everything (a new stream, e.g. after muting or reconnecting): silent until the target is reached. */
  reset(): void {
    this.writePos = 0
    this.readPos = 0
    this.state = 'buffering'
    this.gain = 0
    this.smoothedLevel = 0
    this.rate = 1
    this.crossfadeLeft = 0
    this.discardUntil = 0
  }

  /**
   * End the current stream without a click (muting, a new stream): fade out what is playing, then drop what was pushed
   * before this call. What is pushed after it is the next stream: buffered to the target and faded in.
   */
  stop(): void {
    this.discardUntil = this.writePos
    if (this.state === 'buffering') {
      // nothing audible: drop it now
      this.discardStopped()
    } else {
      // playing, fading in or already fading out: the fade out starts from the current gain
      this.state = 'fading-out'
    }
  }

  private discardStopped() {
    if (this.discardUntil > this.readPos) {
      this.readPos = this.discardUntil
      this.crossfadeLeft = 0
    }
  }

  /** Append decoded audio, one array per channel (the same length). */
  push(left: Float32Array, right: Float32Array): void {
    const n = Math.min(left.length, right.length)
    for (let i = 0; i < n; i++) {
      const at = (this.writePos + i) & (this.capacity - 1)
      this.left[at] = left[i]
      this.right[at] = right[i]
    }
    this.writePos += n
    // never let the oldest frames be overwritten while they could still be read (only reached when nothing reads)
    const overflow = this.level - (this.capacity - this.crossfadeFrames - 2)
    if (overflow > 0) {
      this.readPos += overflow
      this.droppedFrames += overflow
      this.crossfadeLeft = 0
    }
  }

  /** Fill the output blocks (the same length) with the next frames at the current playback rate. */
  read(outLeft: Float32Array, outRight: Float32Array): void {
    const n = Math.min(outLeft.length, outRight.length)
    if (this.state === 'buffering') {
      if (this.level >= this.targetFrames) {
        this.state = 'fading-in'
        this.gain = 0
        this.smoothedLevel = this.level
      } else {
        outLeft.fill(0, 0, n)
        outRight.fill(0, 0, n)
        return
      }
    }

    // follow the level with the rate: ahead of the target plays faster, behind it slower
    const alpha = Math.min(1, n / (this.options.sampleRate * this.options.smoothingSeconds))
    this.smoothedLevel += (this.level - this.smoothedLevel) * alpha
    const error = Math.max(-1, Math.min(1, (this.smoothedLevel - this.targetFrames) / this.rangeFrames))
    this.rate = 1 + error * this.options.maxRateAdjust

    if (this.crossfadeLeft === 0 && this.level > this.maxFrames) {
      // drop everything above the target, listening to the frames we'd skip to while we fade to them
      this.crossfadeSkip = Math.floor(this.level - this.targetFrames)
      this.crossfadeLeft = this.crossfadeFrames
      this.drops++
      this.droppedFrames += this.crossfadeSkip
      // the level is about to be the target; the rate shouldn't keep reacting to the old one
      this.smoothedLevel = this.targetFrames
    }

    if (
      (this.state === 'playing' || this.state === 'fading-in') &&
      this.level < n * this.rate + this.fadeFrames + UNDERRUN_MARGIN_FRAMES
    ) {
      // about to run dry: leave the fade-in unfinished if need be, the fade out starts from the current gain
      this.state = 'fading-out'
      this.underruns++
    }

    const mask = this.capacity - 1
    for (let i = 0; i < n; i++) {
      if (this.state === 'buffering') {
        outLeft[i] = 0
        outRight[i] = 0
        continue
      }
      if (this.readPos + 1 >= this.writePos) {
        // hard underrun (the fade didn't get its frames): silence until the target is reached again
        this.state = 'buffering'
        this.gain = 0
        this.discardStopped()
        outLeft[i] = 0
        outRight[i] = 0
        continue
      }
      const base = Math.floor(this.readPos)
      const fraction = this.readPos - base
      let l = this.left[base & mask] * (1 - fraction) + this.left[(base + 1) & mask] * fraction
      let r = this.right[base & mask] * (1 - fraction) + this.right[(base + 1) & mask] * fraction
      if (this.crossfadeLeft > 0) {
        const ahead = base + this.crossfadeSkip
        const t = 1 - this.crossfadeLeft / this.crossfadeFrames
        const l2 = this.left[ahead & mask] * (1 - fraction) + this.left[(ahead + 1) & mask] * fraction
        const r2 = this.right[ahead & mask] * (1 - fraction) + this.right[(ahead + 1) & mask] * fraction
        l += (l2 - l) * t
        r += (r2 - r) * t
        this.crossfadeLeft--
        if (this.crossfadeLeft === 0) {
          this.readPos += this.crossfadeSkip
        }
      }
      if (this.state === 'fading-out') {
        this.gain -= 1 / this.fadeFrames
        if (this.gain <= 0) {
          // faded out: silent from here, without moving on (after a stop the read position is the next stream's)
          this.gain = 0
          this.state = 'buffering'
          this.discardStopped()
          outLeft[i] = 0
          outRight[i] = 0
          continue
        }
      } else if (this.state === 'fading-in') {
        this.gain += 1 / this.fadeFrames
        if (this.gain >= 1) {
          this.gain = 1
          this.state = 'playing'
        }
      }
      outLeft[i] = l * this.gain
      outRight[i] = r * this.gain
      this.readPos += this.rate
    }
  }
}
