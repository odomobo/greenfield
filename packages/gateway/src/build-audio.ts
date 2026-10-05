/**
 * Generates the configuration of the sessions' own PipeWire (see audio/config.ts) into `dist/audio-config`. Part of the
 * build; the files don't depend on where nebula is installed.
 */
import { audioConfigDir, writeAudioConfig } from './audio/config'

writeAudioConfig(audioConfigDir)
console.log(`audio configuration: ${audioConfigDir}`)
