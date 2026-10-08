/**
 * The session's audio, server side (part of the session process): its own PipeWire (pipewire.ts) with a null sink as
 * the default output, and, while a viewer is attached and wants audio, the capture of that sink's monitor as Opus,
 * sent to the viewer as AUDIO envelopes (see the scene protocol).
 *
 * The capture is a GStreamer pipeline in a child process, like the other GStreamer work: `pulsesrc` (through our own
 * pipewire-pulse) from the sink's monitor, `opusenc` in general purpose mode (`audio-type=generic`, music), fullband
 * stereo at 48 kHz, 112 kbps, 20 ms packets, `rtpopuspay` for the packet boundaries and timestamps and
 * `rtpstreampay` to carry them over the pipe. Muted, no viewer, or no audio: no pipeline runs, nothing is captured or
 * encoded. Everything that can go wrong is reported and the session carries on without audio.
 */
import { createLogger } from '../Logger.js'
import type { AudioEndpoint } from '../viewer/ViewerHost.js'
import type { ControlMessage } from '../viewer/ViewerTransport.js'
import type { AudioPacket } from '../viewer/protocol.js'
import { ChildProcess, spawn } from 'node:child_process'
import { findProgram } from '../shell/desktop-entries'
import { SINK_NAME } from './config'
import { daemonEnvironment, SessionPipeWire, withParentDeathSignal } from './pipewire'
import { RtpStreamParser } from './rtp-stream'

const logger = createLogger('audio')

export const OPUS_BITRATE = 112_000

/** The capture pipeline's arguments for `gst-launch-1.0`. */
export function capturePipeline(): string[] {
  return [
    '-q',
    'pulsesrc',
    `device=${SINK_NAME}.monitor`,
    'buffer-time=40000',
    'latency-time=20000',
    '!',
    'audio/x-raw,rate=48000,channels=2',
    '!',
    'audioconvert',
    '!',
    'audioresample',
    '!',
    'opusenc',
    'audio-type=generic',
    `bitrate=${OPUS_BITRATE}`,
    'frame-size=20',
    '!',
    'rtpopuspay',
    '!',
    'rtpstreampay',
    '!',
    'fdsink',
    'fd=1',
  ]
}

/** After this many failures in a row (it ran less than STABLE_MS each time) a capture is not restarted anymore. */
const MAX_CAPTURE_FAILURES = 5
const STABLE_MS = 10_000
const RESTART_DELAY_MS = 500

export class AudioService implements AudioEndpoint {
  private send?: (message: ControlMessage) => void
  private sendAudio?: (packet: AudioPacket) => void
  /** whether the viewer wants no audio; true until it says otherwise */
  private muted = true
  private available = false
  private pipewire?: SessionPipeWire
  private capture?: ChildProcess
  private captureStartedAt = 0
  private captureFailures = 0
  private restartTimer?: NodeJS.Timeout
  private stopped = false

  constructor(
    /** the session's audio directory (pipewire.ts) */
    private readonly dir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** The audio is up: the viewer's messages are served, a capture runs when wanted. */
  get isAvailable(): boolean {
    return this.available
  }

  /** The PID of the capture pipeline, if one runs. */
  get capturePid(): number | undefined {
    return this.capture?.pid
  }

  /** Start the session's PipeWire. Never throws; without it the session has no audio. */
  async start(): Promise<void> {
    const pipewire = new SessionPipeWire(this.dir, daemonEnvironment(this.env, this.dir))
    this.pipewire = pipewire
    pipewire.onFailed = () => this.setAvailable(false)
    let up = false
    try {
      up = await pipewire.start()
    } catch (e: any) {
      logger.error(`Session audio failed to start: ${e.message}`)
    }
    if (this.stopped) {
      return
    }
    if (findProgram('gst-launch-1.0', this.env) === undefined) {
      logger.info('Not installed, the session has no audio: gst-launch-1.0 (GStreamer).')
      up = false
    }
    if (!up) {
      pipewire.stop()
    }
    this.setAvailable(up)
  }

  /** The session ends: stop the capture and the daemons, by the PIDs we started. */
  stop(): void {
    this.stopped = true
    this.stopCapture()
    this.pipewire?.stop()
  }

  /** The process exits: kill what is left, remove the directory. */
  cleanUpAtExit(): void {
    this.stopCapture()
    this.pipewire?.killAndClean()
  }

  attach(send: (message: ControlMessage) => void, sendAudio: (packet: AudioPacket) => void): void {
    this.send = send
    this.sendAudio = sendAudio
    // the viewer says whether it wants audio first thing
    this.muted = true
    send({ type: 'audio.state', available: this.available })
    this.update()
  }

  detach(): void {
    this.send = undefined
    this.sendAudio = undefined
    this.muted = true
    this.update()
  }

  handleMessage(message: ControlMessage): void {
    if (message.type === 'audio.mute' && typeof message.muted === 'boolean') {
      this.muted = message.muted
      this.captureFailures = 0
      this.update()
    }
  }

  private setAvailable(available: boolean) {
    if (this.available === available) {
      return
    }
    this.available = available
    this.send?.({ type: 'audio.state', available })
    this.update()
  }

  /** Run the capture exactly while there is a viewer that wants audio. */
  private update() {
    const wanted = this.available && !this.stopped && this.sendAudio !== undefined && !this.muted
    if (wanted && this.capture === undefined && this.restartTimer === undefined) {
      this.startCapture()
    } else if (!wanted) {
      this.stopCapture()
    }
  }

  private startCapture() {
    const [command, args] = withParentDeathSignal('gst-launch-1.0', capturePipeline())
    const child = spawn(command, args, {
      env: daemonEnvironment(this.env, this.dir),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.capture = child
    this.captureStartedAt = Date.now()
    const parser = new RtpStreamParser()
    let errors = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      if (this.capture !== child) {
        return
      }
      try {
        for (const packet of parser.push(chunk)) {
          this.sendAudio?.({ seq: packet.seq, timestamp: packet.timestamp, opus: packet.payload })
        }
      } catch (e: any) {
        logger.error(`Audio capture produced garbage (${e.message}), restarting it.`)
        child.kill('SIGTERM')
      }
    })
    child.stderr!.on('data', (data: Buffer) => {
      errors = (errors + data.toString()).slice(-400)
    })
    child.on('error', (e) => logger.error(`Audio capture could not be started: ${e.message}`))
    child.on('exit', (code, signal) => {
      if (this.capture !== child) {
        // stopped on purpose
        return
      }
      this.capture = undefined
      const ranFor = Date.now() - this.captureStartedAt
      this.captureFailures = ranFor > STABLE_MS ? 1 : this.captureFailures + 1
      logger.error(
        `Audio capture exited (${signal ?? `code ${code}`}) after ${ranFor} ms: ${errors.trim().replace(/["\n]+/g, ' ')}`,
      )
      if (this.captureFailures >= MAX_CAPTURE_FAILURES) {
        logger.error('Audio capture keeps failing, giving up until the viewer mutes and unmutes.')
        return
      }
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined
        this.update()
      }, RESTART_DELAY_MS)
    })
  }

  private stopCapture() {
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    const child = this.capture
    this.capture = undefined
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      return
    }
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000)
    timer.unref()
    child.once('exit', () => clearTimeout(timer))
  }
}
