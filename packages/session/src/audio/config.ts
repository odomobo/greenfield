/**
 * The configuration of a session's own PipeWire (see pipewire.ts): static files, the same for every session, generated
 * by the build into `dist/audio-config` (build-audio.ts) like the dconf defaults. Per-session things (the sockets, the state)
 * live in the session's runtime directory instead and are chosen with environment variables.
 *
 * Written for PipeWire 1.0.x and WirePlumber 0.4.x (Ubuntu 24.04). WirePlumber 0.5 has another configuration format
 * (the Lua configuration here would not be read), a newer one needs `wireplumber` files for it.
 *
 * What each daemon gets, and why it is the way it is:
 *
 * - `pipewire.conf` (the core): not the stock configuration but a minimal one. It has the `access` module (without
 *   it, no client may see the graph, which includes WirePlumber and `pw-dump`), a dummy driver (so the graph runs
 *   without hardware) and one object: a null audio sink named `nebula`, no hardware behind it. No D-Bus (`rt`, the
 *   portal, jackdbus-detect and so on would talk to the user's buses).
 * - `pipewire-pulse.conf`: the PulseAudio protocol server. Its socket is `native` in `PULSE_RUNTIME_PATH`.
 * - `xdg/wireplumber/`: WirePlumber finds its configuration in `$XDG_CONFIG_HOME/wireplumber` before the system's
 *   (`/usr/share/wireplumber`), file by file, so we override only what we must:
 *   - `wireplumber.conf` without the bluetooth part,
 *   - the ALSA, V4L2 and libcamera monitors (hardware, which the session must never touch, and the device
 *     reservation protocol on the user's session bus) are replaced by empty files, and `90-enable-all.lua` no longer
 *     enables them,
 *   - the Flatpak portal access check is off (it needs the session bus, and WirePlumber exits without one).
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** The name of the session's null sink, the default output; its monitor is what is captured (`nebula.monitor`). */
export const SINK_NAME = 'nebula'

const pipewireConf = `# nebula: the core of a session's own PipeWire (generated, see packages/session/src/audio/config.ts)
context.properties = {
    core.daemon = true
    core.name = pipewire-0
    link.max-buffers = 16
    support.dbus = false
}
context.spa-libs = {
    audio.convert.* = audioconvert/libspa-audioconvert
    support.*       = support/libspa-support
}
context.modules = [
    { name = libpipewire-module-protocol-native }
    { name = libpipewire-module-metadata }
    { name = libpipewire-module-access args = { } }
    { name = libpipewire-module-spa-device-factory }
    { name = libpipewire-module-spa-node-factory }
    { name = libpipewire-module-client-node }
    { name = libpipewire-module-client-device }
    { name = libpipewire-module-adapter }
    { name = libpipewire-module-link-factory }
    { name = libpipewire-module-session-manager }
]
context.objects = [
    { factory = spa-node-factory
        args = {
            factory.name = support.node.driver
            node.name = Dummy-Driver
            node.group = pipewire.dummy
            priority.driver = 20000
        }
    }
    { factory = adapter
        args = {
            factory.name = support.null-audio-sink
            node.name = ${SINK_NAME}
            node.description = "nebula"
            media.class = Audio/Sink
            object.linger = true
            audio.position = [ FL FR ]
            audio.rate = 48000
            monitor.channel-volumes = true
            monitor.passthrough = true
        }
    }
]
`

const pipewirePulseConf = `# nebula: the PulseAudio protocol server of a session's own PipeWire (generated)
context.properties = {
    support.dbus = false
}
context.spa-libs = {
    audio.convert.* = audioconvert/libspa-audioconvert
    support.*       = support/libspa-support
}
context.modules = [
    { name = libpipewire-module-protocol-native }
    { name = libpipewire-module-client-node }
    { name = libpipewire-module-adapter }
    { name = libpipewire-module-metadata }
    { name = libpipewire-module-protocol-pulse }
]
pulse.properties = {
    # relative: in PULSE_RUNTIME_PATH, the session's own directory
    server.address = [ "unix:native" ]
}
`

const wireplumberConf = `# nebula: WirePlumber without bluetooth (generated)
context.properties = {
  log.level = 2
  wireplumber.script-engine = lua-scripting
}
context.spa-libs = {
  audio.convert.* = audioconvert/libspa-audioconvert
  support.*       = support/libspa-support
}
context.modules = [
  { name = libpipewire-module-protocol-native }
  { name = libpipewire-module-client-node }
  { name = libpipewire-module-client-device }
  { name = libpipewire-module-adapter }
  { name = libpipewire-module-metadata }
  { name = libpipewire-module-session-manager }
  { name = libpipewire-module-spa-node-factory }
]
wireplumber.components = [
  { name = libwireplumber-module-lua-scripting, type = module }
  { name = main.lua, type = config/lua }
  { name = policy.lua, type = config/lua }
]
`

const emptyLua = '-- nebula: disabled, a session has no hardware (generated)\n'

const defaultAccessConfig = `-- nebula: the Flatpak portal check needs the D-Bus session bus (generated)
default_access.enabled = false
default_access.properties = {}
default_access.rules = {}
`

const enableAll = `-- nebula: the stock 90-enable-all.lua without the hardware monitors (generated)
load_module("metadata")

-- Default client access policy
default_access.enable()

-- Track/store/restore user choices about devices
device_defaults.enable()

-- Track/store/restore user choices about streams
stream_defaults.enable()

-- Link nodes by stream role and device intended role
load_script("intended-roles.lua")

-- Automatically suspends idle nodes after 3 seconds
load_script("suspend-node.lua")

-- Allows loading objects on demand via metadata
load_script("sm-objects.lua")
`

/** Relative path -> contents */
export function audioConfigFiles(): Record<string, string> {
  const lua = 'xdg/wireplumber/main.lua.d'
  return {
    'pipewire.conf': pipewireConf,
    'pipewire-pulse.conf': pipewirePulseConf,
    'xdg/wireplumber/wireplumber.conf': wireplumberConf,
    [`${lua}/30-alsa-monitor.lua`]: emptyLua,
    [`${lua}/30-libcamera-monitor.lua`]: emptyLua,
    [`${lua}/30-v4l2-monitor.lua`]: emptyLua,
    [`${lua}/50-alsa-config.lua`]: emptyLua,
    [`${lua}/50-libcamera-config.lua`]: emptyLua,
    [`${lua}/50-v4l2-config.lua`]: emptyLua,
    [`${lua}/50-default-access-config.lua`]: defaultAccessConfig,
    [`${lua}/90-enable-all.lua`]: enableAll,
  }
}

/** Where the generated files are: `dist/audio-config`. */
export const audioConfigDir = path.resolve(__dirname, '../audio-config')

/** Writes the configuration files into `dir` (renaming temporary files, so a running session never sees half a file). */
export function writeAudioConfig(dir: string): void {
  const suffix = `.${process.pid}.tmp`
  for (const [relative, contents] of Object.entries(audioConfigFiles())) {
    const file = path.join(dir, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file + suffix, contents)
    renameSync(file + suffix, file)
  }
}
