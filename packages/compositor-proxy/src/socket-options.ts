/**
 * Socket tuning helpers, importable without loading the rest of the proxy (used by the gateway's web process). They
 * live in the small poll addon, which doesn't link libwayland.
 */
import pollAddon from './addons/proxy-poll-addon'

export const { setTcpNotSentLowat, setSocketSendBuffer } = pollAddon
