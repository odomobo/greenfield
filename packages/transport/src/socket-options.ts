/**
 * Socket tuning for the viewer connection, from the small native nebula-socket-addon (native/src/socket_options.c).
 * Both return 0 or an errno.
 */
type SocketAddon = {
  /** TCP_NOTSENT_LOWAT */
  setTcpNotSentLowat(fd: number, bytes: number): number
  /** SO_SNDBUF */
  setSocketSendBuffer(fd: number, bytes: number): number
}

// eslint-disable-next-line @typescript-eslint/no-var-requires -- a native addon, installed next to the compiled code
const addon = require('./addons/nebula-socket-addon') as SocketAddon

export const { setTcpNotSentLowat, setSocketSendBuffer } = addon
