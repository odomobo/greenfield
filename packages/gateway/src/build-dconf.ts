/**
 * Generates nebula's settings for apps (see nebula-settings.ts): the dconf profile and defaults database into
 * `dist/dconf`, `kdeglobals` into `dist/xdg-apps`. Part of the build; the install script runs it again where nebula is
 * installed, since the profile holds the database's path.
 */
import { appsConfigDir, dconfDir, writeAppsConfig, writeDconfProfile } from './nebula-settings'

console.log(`dconf profile: ${writeDconfProfile(dconfDir)}`)
console.log(`kdeglobals: ${writeAppsConfig(appsConfigDir)}`)
