import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { audioConfigFiles, SINK_NAME, writeAudioConfig } from '../audio/config'
import {
  appAudioVariables,
  AUDIO_DIR_PREFIX,
  audioDirectory,
  createAudioDirectory,
  daemonEnvironment,
} from '../audio/pipewire'
import { parseRtp, RtpStreamParser } from '../audio/rtp-stream'
import { capturePipeline, OPUS_BITRATE } from '../audio/service'

/** An RTP packet: version 2, payload type 111, with the given header flags. */
function rtp(seq: number, timestamp: number, payload: number[], options: { csrc?: number; padding?: number } = {}) {
  const csrc = options.csrc ?? 0
  const header = Buffer.alloc(12 + 4 * csrc)
  header[0] = 0x80 | (options.padding ? 0x20 : 0) | csrc
  header[1] = 111
  header.writeUInt16BE(seq, 2)
  header.writeUInt32BE(timestamp, 4)
  const padding = options.padding ? Buffer.alloc(options.padding, 0) : Buffer.alloc(0)
  if (padding.length) {
    padding[padding.length - 1] = padding.length
  }
  return Buffer.concat([header, Buffer.from(payload), padding])
}

/** RFC 4571 framing as `rtpstreampay` writes it */
const framed = (packet: Buffer) => Buffer.concat([Buffer.from([packet.length >> 8, packet.length & 0xff]), packet])

test('parseRtp reads the sequence number, the timestamp and the payload', () => {
  const packet = parseRtp(rtp(65535, 0xfffffff0, [9, 8, 7]))
  assert.equal(packet.seq, 65535)
  assert.equal(packet.timestamp, 0xfffffff0)
  assert.deepEqual([...packet.payload], [9, 8, 7])
})

test('parseRtp skips contributing sources and padding', () => {
  const packet = parseRtp(rtp(1, 2, [5, 6], { csrc: 2, padding: 4 }))
  assert.deepEqual([...packet.payload], [5, 6])
})

test('parseRtp rejects what is not RTP', () => {
  assert.throws(() => parseRtp(Buffer.from('hello world, this is no rtp')), /Not an RTP packet/)
  assert.throws(() => parseRtp(Buffer.alloc(5)), /Not an RTP packet/)
})

test('the stream parser returns whole packets, however the stream is cut', () => {
  const stream = Buffer.concat([1, 2, 3, 4].map((n) => framed(rtp(n, n * 960, [n, n, n]))))
  for (const chunkSize of [1, 2, 5, 17, 1000]) {
    const parser = new RtpStreamParser()
    const seqs: number[] = []
    for (let at = 0; at < stream.length; at += chunkSize) {
      for (const packet of parser.push(stream.subarray(at, at + chunkSize))) {
        assert.deepEqual([...packet.payload], [packet.seq, packet.seq, packet.seq])
        assert.equal(packet.timestamp, packet.seq * 960)
        seqs.push(packet.seq)
      }
    }
    assert.deepEqual(seqs, [1, 2, 3, 4], `chunks of ${chunkSize}`)
  }
})

test('the stream parser throws on garbage', () => {
  assert.throws(() => new RtpStreamParser().push(Buffer.from([0, 20, ...Buffer.alloc(20, 0x41)])), /Not an RTP packet/)
})

test('the capture pipeline reads the null sink monitor and encodes Opus in general purpose mode', () => {
  const pipeline = capturePipeline()
  const text = pipeline.join(' ')
  assert.ok(text.includes(`pulsesrc device=${SINK_NAME}.monitor`))
  assert.ok(text.includes('audio/x-raw,rate=48000,channels=2'))
  assert.ok(text.includes('opusenc audio-type=generic'))
  assert.ok(text.includes(`bitrate=${OPUS_BITRATE}`) && OPUS_BITRATE >= 96_000 && OPUS_BITRATE <= 128_000)
  assert.ok(text.includes('frame-size=20'))
  assert.ok(text.endsWith('rtpopuspay ! rtpstreampay ! fdsink fd=1'))
})

test('apps get the session directory in every variable that could lead them to another PipeWire or Pulse', () => {
  const dir = '/run/user/1000/nebula-audio-42'
  assert.deepEqual(appAudioVariables(dir), {
    PIPEWIRE_RUNTIME_DIR: dir,
    PULSE_RUNTIME_PATH: dir,
    PULSE_SERVER: `unix:${dir}/native`,
  })
})

test('the daemons run with private config, state and cache, no bus of the user, and nothing foreign', () => {
  const dir = '/run/user/1000/nebula-audio-42'
  const env = daemonEnvironment(
    {
      PATH: '/usr/bin',
      HOME: '/home/user',
      XDG_RUNTIME_DIR: '/run/user/1000',
      XDG_CONFIG_HOME: '/home/user/.config',
      XDG_STATE_HOME: '/home/user/.local/state',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      PIPEWIRE_REMOTE: 'user-remote',
      PIPEWIRE_CORE: 'user-core',
      PIPEWIRE_CONFIG_DIR: '/home/user/pw',
      PULSE_SERVER: 'unix:/run/user/1000/pulse/native',
      PULSE_SINK: 'speakers',
      WIREPLUMBER_CONFIG_DIR: '/home/user/wp',
    },
    dir,
    '/opt/nebula/audio-config',
  )
  assert.equal(env.PIPEWIRE_RUNTIME_DIR, dir)
  assert.equal(env.PULSE_RUNTIME_PATH, dir)
  assert.equal(env.PULSE_SERVER, `unix:${dir}/native`)
  assert.equal(env.XDG_CONFIG_HOME, '/opt/nebula/audio-config/xdg')
  assert.equal(env.XDG_STATE_HOME, `${dir}/state`)
  assert.equal(env.XDG_CACHE_HOME, `${dir}/cache`)
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${dir}/no-bus`)
  for (const name of [
    'PIPEWIRE_REMOTE',
    'PIPEWIRE_CORE',
    'PIPEWIRE_CONFIG_DIR',
    'PULSE_SINK',
    'WIREPLUMBER_CONFIG_DIR',
  ]) {
    assert.equal(env[name], undefined, name)
  }
  assert.equal(env.HOME, '/home/user')
  assert.equal(env.PATH, '/usr/bin')
})

test('the audio directory is private, named for the session, and stale ones of dead sessions are removed', () => {
  const runtime = mkdtempSync(path.join(os.tmpdir(), 'nebula-audio-test-'))
  try {
    const dead = path.join(runtime, `${AUDIO_DIR_PREFIX}2147483646`)
    const other = path.join(runtime, 'pulse')
    mkdirSync(dead)
    mkdirSync(other)
    const dir = createAudioDirectory(runtime)
    assert.equal(dir, audioDirectory(runtime))
    assert.ok(dir.startsWith(path.join(runtime, AUDIO_DIR_PREFIX)))
    assert.ok(existsSync(path.join(dir, 'state')) && existsSync(path.join(dir, 'cache')))
    assert.equal(statSync(dir).mode & 0o077, 0, 'no access for group and others')
    assert.ok(!existsSync(dead), 'a dead session left its directory')
    assert.ok(existsSync(other), 'other entries are not touched')
  } finally {
    rmSync(runtime, { recursive: true, force: true })
  }
})

test('the generated configuration disables hardware and D-Bus, and defines the null sink', () => {
  const files = audioConfigFiles()
  const core = files['pipewire.conf']
  assert.ok(core.includes(`node.name = ${SINK_NAME}`) && core.includes('support.null-audio-sink'))
  assert.ok(core.includes('libpipewire-module-access'), 'without the access module no client sees the graph')
  assert.ok(!/alsa|bluez|v4l2|libcamera|portal|jackdbus|module-rt/.test(core), 'no hardware, portal or rtkit')
  assert.ok(files['pipewire-pulse.conf'].includes('server.address = [ "unix:native" ]'))
  const wireplumber = files['xdg/wireplumber/wireplumber.conf']
  assert.ok(!wireplumber.includes('bluetooth.lua'))
  for (const monitor of ['alsa', 'v4l2', 'libcamera']) {
    assert.ok(!files[`xdg/wireplumber/main.lua.d/30-${monitor}-monitor.lua`].includes('enable'))
    assert.ok(`xdg/wireplumber/main.lua.d/50-${monitor}-config.lua` in files)
  }
  assert.ok(!/alsa_monitor|v4l2_monitor|libcamera_monitor/.test(files['xdg/wireplumber/main.lua.d/90-enable-all.lua']))
  assert.ok(files['xdg/wireplumber/main.lua.d/50-default-access-config.lua'].includes('enabled = false'))
})

test('writeAudioConfig writes every file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nebula-audio-config-'))
  try {
    writeAudioConfig(dir)
    for (const [relative, contents] of Object.entries(audioConfigFiles())) {
      assert.equal(readFileSync(path.join(dir, relative), 'utf8'), contents)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
