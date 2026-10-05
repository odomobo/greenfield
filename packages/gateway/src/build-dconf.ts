/**
 * Generates nebula's dconf profile and defaults database (see nebula-settings.ts) into `dist/dconf`. Part of the
 * build; the install script runs it again where nebula is installed, since the profile holds the database's path.
 */
import { dconfDir, writeDconfProfile } from './nebula-settings'

console.log(`dconf profile: ${writeDconfProfile(dconfDir)}`)
