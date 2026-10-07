/**
 * Unix sockets with fd passing (native/poll/src/fd_passing.c), importable without loading the rest of the proxy: the
 * gateway's web process and its sessions talk to the login helpers with them, which hand over connections as fds
 * (see packages/login). Node's own sockets can't pass fds, so these work on raw fds: wait for readability with
 * `startPoll`, read with `receiveWithFds`, and wrap a received connection in a `net.Socket({ fd })`.
 */
import pollAddon from './addons/proxy-poll-addon'

export type PollHandle = pollAddon.PollHandle

export const { startPoll, stopPoll, unixConnect, acceptConnection, sendWithFd, receiveWithFds, setCloseOnExec, closeFd } =
  pollAddon
