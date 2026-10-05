import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { JitterBuffer } from '../src/audio/jitter-buffer.js'

const SAMPLE_RATE = 48000
const BLOCK = 128
const PACKET = 960
const FREQUENCY = 440
const AMPLITUDE = 0.5
/** the steepest a sine of this frequency and amplitude gets, per sample */
const SINE_SLOPE = (2 * Math.PI * FREQUENCY * AMPLITUDE) / SAMPLE_RATE
/** what no click may exceed: the sine's own slope with room for rate changes and the fades' gain slope */
const CLICK_LIMIT = SINE_SLOPE * 1.5 + 0.01

const sine = (frame: number) => AMPLITUDE * Math.sin((2 * Math.PI * FREQUENCY * frame) / SAMPLE_RATE)

/** A source of a continuous sine, handed out in packets. */
class Source {
  next = 0
  packet(frames = PACKET): [Float32Array, Float32Array] {
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      left[i] = sine(this.next + i)
      right[i] = -sine(this.next + i)
    }
    this.next += frames
    return [left, right]
  }
}

/** Plays blocks and collects what came out, left channel. */
class Player {
  readonly output: number[] = []
  private produced = 0
  constructor(readonly buffer: JitterBuffer) {}

  block() {
    const left = new Float32Array(BLOCK)
    const right = new Float32Array(BLOCK)
    this.buffer.read(left, right)
    this.output.push(...left)
    return [left, right]
  }

  /**
   * Runs for this many output frames, the source producing `rate` source frames per output frame, delivered in
   * packets as they complete.
   */
  run(source: Source, frames: number, rate = 1, deliver = true) {
    for (let played = 0; played < frames; played += BLOCK) {
      if (deliver) {
        this.produced += BLOCK * rate
        while (this.produced >= PACKET) {
          this.buffer.push(...source.packet())
          this.produced -= PACKET
        }
      }
      this.block()
    }
  }
}

/** The largest jump between consecutive output samples from `from` on. */
function maxStep(samples: number[], from = 0): number {
  let max = 0
  for (let i = Math.max(1, from); i < samples.length; i++) {
    max = Math.max(max, Math.abs(samples[i] - samples[i - 1]))
  }
  return max
}

describe('JitterBuffer', () => {
  it('is silent until it holds the target, then plays what was pushed without clicks', () => {
    const buffer = new JitterBuffer()
    const player = new Player(buffer)
    const source = new Source()
    // 60 ms is below the 70 ms target
    buffer.push(...source.packet(PACKET * 3))
    player.block()
    assert.equal(buffer.stats.state, 'buffering')
    assert.ok(player.output.every((sample) => sample === 0))
    buffer.push(...source.packet(PACKET))
    player.run(source, SAMPLE_RATE, 1)
    assert.equal(buffer.stats.state, 'playing')
    assert.equal(buffer.stats.underruns, 0)
    assert.ok(maxStep(player.output) < CLICK_LIMIT, `step ${maxStep(player.output)}`)
    assert.ok(
      player.output.some((sample) => Math.abs(sample) > 0.4),
      'the sine is audible',
    )
  })

  it('fades in over a few milliseconds when it starts', () => {
    const buffer = new JitterBuffer()
    const player = new Player(buffer)
    const source = new Source()
    buffer.push(...source.packet(PACKET * 5))
    player.block()
    // 3 ms fade: the first frames are quiet, the signal is up to full level a few hundred frames in
    const firstStart = player.output.findIndex((sample) => sample !== 0)
    assert.ok(firstStart >= 0)
    assert.ok(Math.abs(player.output[firstStart]) < 0.05)
  })

  it('on an underrun fades out, stays silent, rebuffers to the target and fades in again, with no clicks', () => {
    const buffer = new JitterBuffer()
    const player = new Player(buffer)
    const source = new Source()
    player.run(source, SAMPLE_RATE / 2, 1)
    assert.equal(buffer.stats.state, 'playing')
    const beforeStall = player.output.length
    // the network stalls for 400 ms
    player.run(source, SAMPLE_RATE * 0.4, 1, false)
    assert.equal(buffer.stats.underruns, 1)
    assert.equal(buffer.stats.state, 'buffering')
    // the output played what was buffered, then went quiet, ending in zeros, without a jump
    const stalled = player.output.slice(beforeStall)
    assert.ok(stalled.slice(-2000).every((sample) => sample === 0))
    assert.ok(maxStep(player.output) < CLICK_LIMIT, `step ${maxStep(player.output)}`)
    let lastSound = -1
    stalled.forEach((sample, i) => {
      if (sample !== 0) {
        lastSound = i
      }
    })
    assert.ok(lastSound > 0.04 * SAMPLE_RATE && lastSound < 0.08 * SAMPLE_RATE, `ran dry after ${lastSound} frames`)
    // the fade out is a few ms long: full level 10 ms before the end, almost nothing in the last 0.5 ms
    const peak = (from: number, to: number) => Math.max(...stalled.slice(from, to).map(Math.abs))
    assert.ok(peak(lastSound - 480, lastSound - 240) > 0.4)
    assert.ok(peak(lastSound - 24, lastSound + 1) < 0.1)
    // the data resumes: a burst of the target's worth after the silence, then steady
    const resumeAt = player.output.length
    buffer.push(...source.packet(PACKET * 4))
    player.run(source, SAMPLE_RATE / 2, 1)
    assert.equal(buffer.stats.state, 'playing')
    assert.equal(buffer.stats.underruns, 1)
    assert.ok(maxStep(player.output, resumeAt) < CLICK_LIMIT, `step ${maxStep(player.output, resumeAt)}`)
    assert.ok(player.output.slice(resumeAt).some((sample) => Math.abs(sample) > 0.4))
  })

  it('plays slower when the level is below the target and faster when above, by at most 0.1%', () => {
    const slow = new JitterBuffer()
    const slowPlayer = new Player(slow)
    const slowSource = new Source()
    slowPlayer.run(slowSource, SAMPLE_RATE / 2, 1)
    // the source runs 0.05% slow: the level sinks below the target
    let slowest = 1
    for (let i = 0; i < 400; i++) {
      slowPlayer.run(slowSource, SAMPLE_RATE / 10, 0.9995)
      slowest = Math.min(slowest, slow.stats.rate)
    }
    assert.ok(slowest < 1, `rate ${slowest}`)
    assert.ok(slowest >= 0.999 - 1e-9, `rate ${slowest}`)
    assert.equal(slow.stats.underruns, 0)

    const fast = new JitterBuffer()
    const fastPlayer = new Player(fast)
    const fastSource = new Source()
    fastPlayer.run(fastSource, SAMPLE_RATE / 2, 1)
    let fastest = 1
    for (let i = 0; i < 400; i++) {
      fastPlayer.run(fastSource, SAMPLE_RATE / 10, 1.0005)
      fastest = Math.max(fastest, fast.stats.rate)
    }
    assert.ok(fastest > 1, `rate ${fastest}`)
    assert.ok(fastest <= 1.001 + 1e-9, `rate ${fastest}`)
    assert.equal(fast.stats.drops, 0)
  })

  it('keeps the level near the target for a drifting source, without underruns or drops, for a long time', () => {
    for (const rate of [0.9993, 0.9998, 1.0003, 1.0008]) {
      const buffer = new JitterBuffer()
      const player = new Player(buffer)
      const source = new Source()
      // 10 simulated minutes
      for (let i = 0; i < 600; i++) {
        player.run(source, SAMPLE_RATE, rate)
        player.output.length = 0
      }
      const stats = buffer.stats
      assert.equal(stats.underruns, 0, `rate ${rate}`)
      assert.equal(stats.drops, 0, `rate ${rate}`)
      // within a packet or two of the 70 ms target (3360 frames)
      assert.ok(Math.abs(stats.level - 3360) < 3 * PACKET, `rate ${rate} level ${stats.level}`)
    }
  })

  it('output at rate 1.0 is the input, sample for sample', () => {
    const buffer = new JitterBuffer({ maxRateAdjust: 0 })
    const player = new Player(buffer)
    const source = new Source()
    player.run(source, SAMPLE_RATE, 1)
    // find the delay by the first non-silent output, then compare the rest to the source
    const out = player.output
    const delay = Math.floor(out.findIndex((sample) => sample !== 0) / BLOCK) * BLOCK
    assert.ok(delay > 0)
    for (let i = delay + 1000; i < out.length; i += 7) {
      assert.ok(Math.abs(out[i] - sine(i - delay)) < 1e-4, `sample ${i}`)
    }
  })

  it('drops a backlog over 300 ms down to the target with a crossfade and no click', () => {
    const buffer = new JitterBuffer()
    const player = new Player(buffer)
    const source = new Source()
    player.run(source, SAMPLE_RATE / 2, 1)
    const before = player.output.length
    // a burst of 600 ms arrives at once (the tab was in the background)
    for (let i = 0; i < 30; i++) {
      buffer.push(...source.packet())
    }
    assert.ok(buffer.stats.level > 0.3 * SAMPLE_RATE)
    player.run(source, SAMPLE_RATE / 2, 1)
    const stats = buffer.stats
    assert.equal(stats.drops, 1)
    assert.ok(stats.droppedFrames > 0.2 * SAMPLE_RATE)
    // back near the target, not drained
    assert.ok(stats.level > 0.04 * SAMPLE_RATE && stats.level < 0.12 * SAMPLE_RATE, `level ${stats.level}`)
    assert.equal(stats.underruns, 0)
    assert.ok(maxStep(player.output, before) < CLICK_LIMIT, `step ${maxStep(player.output, before)}`)
    // the audio after the drop is the source's later part: the sine continues at the right phase
    // (the source's position is known: what plays now is the source frame just behind what is still buffered)
    const last = player.output.length - 1
    const playing = source.next - buffer.stats.level
    assert.ok(Math.abs(player.output[last] - sine(playing - 1)) < 0.02, 'continues at the right place of the source')
  })

  it('reset empties the buffer and goes back to buffering', () => {
    const buffer = new JitterBuffer()
    const player = new Player(buffer)
    const source = new Source()
    player.run(source, SAMPLE_RATE / 4, 1)
    assert.equal(buffer.stats.state, 'playing')
    buffer.reset()
    assert.equal(buffer.stats.state, 'buffering')
    assert.equal(buffer.level, 0)
    const [left] = player.block()
    assert.ok(left.every((sample) => sample === 0))
  })

  it('survives bursty delivery (every 7th packet 20 ms late, in order) without an underrun or a click', () => {
    const buffer = new JitterBuffer()
    const player = new Player(buffer)
    const source = new Source()
    const arrivals: { at: number; packet: [Float32Array, Float32Array] }[] = []
    let latest = 0
    for (let k = 0; k < 250; k++) {
      // arrival time in output frames: when the packet was complete, 20 ms later for some; never before the previous
      latest = Math.max(latest, (k + 1) * PACKET + (k % 7 === 6 ? PACKET : 0))
      arrivals.push({ at: latest, packet: source.packet() })
    }
    let next = 0
    for (let played = 0; played < SAMPLE_RATE * 4; played += BLOCK) {
      while (next < arrivals.length && arrivals[next].at <= played) {
        buffer.push(...arrivals[next++].packet)
      }
      player.block()
    }
    assert.equal(buffer.stats.underruns, 0)
    assert.ok(maxStep(player.output) < CLICK_LIMIT)
  })
})
