/**
 * Socket tuning helpers, importable without loading the rest of the proxy (used by the gateway's web process).
 */
import westfieldAddon from './addons/wayland-server-addon'

export const { setTcpNotSentLowat, setSocketSendBuffer } = westfieldAddon
