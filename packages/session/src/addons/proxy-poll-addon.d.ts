declare namespace nodePoll {
  export type PollHandle = unknown

  export function startPoll(fd: number, handlePollEvent: (status: number, events: number) => void): PollHandle

  export function stopPoll(pollHandle: PollHandle)

  // fd passing (native/poll/src/fd_passing.c). Sockets made here are non-blocking and close-on-exec; errors are
  // returned as -errno.

  /** A connected Unix stream socket's fd, or -errno. */
  export function unixConnect(path: string): number

  /** The next connection on a listening socket, -EAGAIN if there is none, or -errno. */
  export function acceptConnection(listenFd: number): number

  /** Send data (with passFd on its first byte, unless -1) without blocking: the bytes sent, or -errno. */
  export function sendWithFd(fd: number, data: Buffer, passFd: number): number

  /** What there is to read (an empty buffer: EOF) and the fds that came with it, -EAGAIN if nothing, or -errno. */
  export function receiveWithFds(fd: number, maxBytes: number): { data: Buffer; fds: number[] } | number

  /** Set FD_CLOEXEC: 0 or -errno. */
  export function setCloseOnExec(fd: number): number

  /** close(2): 0 or -errno. */
  export function closeFd(fd: number): number
}

export = nodePoll
