/**
 * Choosing the video encoder (see "GPU acceleration and encoders" in ROADMAP.md). Without GPU acceleration there is no
 * video at all: everything is sent as PNG patches (`none`).
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, readdirSync } from 'node:fs'

/** What a session can be started with. */
export type SessionEncoder = 'none' | 'nvh264' | 'vaapih264'
/** What `--encoder` accepts. */
export type EncoderOption = 'auto' | SessionEncoder
export const ENCODER_OPTIONS: readonly EncoderOption[] = ['auto', 'none', 'nvh264', 'vaapih264']

/** The machine's facts that `auto` looks at, replaceable in tests. */
export type EncoderProbes = {
  /** a render node (/dev/dri/renderD*) that can be opened */
  hasRenderNode(): boolean
  /** an NVIDIA GPU device node (/dev/nvidia0, ...) */
  hasNvidiaDevice(): boolean
  /** GStreamer has the element (gst-inspect-1.0) */
  hasGstElement(name: string): boolean
}

export const systemProbes: EncoderProbes = {
  hasRenderNode() {
    try {
      return readdirSync('/dev/dri').some((name) => {
        if (!name.startsWith('renderD')) {
          return false
        }
        try {
          accessSync(`/dev/dri/${name}`, constants.R_OK | constants.W_OK)
          return true
        } catch {
          return false
        }
      })
    } catch {
      return false
    }
  },
  hasNvidiaDevice() {
    try {
      return readdirSync('/dev').some((name) => /^nvidia\d+$/.test(name))
    } catch {
      return false
    }
  },
  hasGstElement(name) {
    try {
      execFileSync('gst-inspect-1.0', ['--exists', name], { stdio: 'ignore', timeout: 10_000 })
      return true
    } catch {
      return false
    }
  },
}

/** The encoder `auto` picks: vaapih264, else nvh264, else none. */
export function detectEncoder(probes: EncoderProbes = systemProbes): SessionEncoder {
  if (probes.hasRenderNode() && probes.hasGstElement('vaapih264enc')) {
    return 'vaapih264'
  }
  if (probes.hasNvidiaDevice() && probes.hasGstElement('nvh264enc')) {
    return 'nvh264'
  }
  return 'none'
}

/** Resolve the option to what sessions get, and say which. */
export function resolveEncoder(
  option: EncoderOption,
  log: (message: string) => void,
  probes: EncoderProbes = systemProbes,
): SessionEncoder {
  if (option !== 'auto') {
    log(`Video encoder: ${option} (--encoder).`)
    return option
  }
  const encoder = detectEncoder(probes)
  log(
    encoder === 'none'
      ? 'Video encoder: none (no GPU acceleration found, everything is sent as PNG patches).'
      : `Video encoder: ${encoder} (detected).`,
  )
  return encoder
}
