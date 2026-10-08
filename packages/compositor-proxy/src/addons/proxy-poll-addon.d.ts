declare namespace nodePoll {
  export type PollHandle = unknown

  export function startPoll(fd: number, handlePollEvent: (status: number, events: number) => void): PollHandle

  export function stopPoll(pollHandle: PollHandle)

  /** TCP_NOTSENT_LOWAT, returns 0 or errno */
  export function setTcpNotSentLowat(fd: number, bytes: number): number

  /** SO_SNDBUF, returns 0 or errno */
  export function setSocketSendBuffer(fd: number, bytes: number): number

  /**
   * Set the nice level of the calling thread only. Returns the thread's id (as in /proc/self/task/<tid>) or, on
   * failure, minus errno. A thread can lower its priority but never raise it again.
   */
  export function setThreadNice(nice: number): number

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

  /** PR_SET_DUMPABLE 0 for the calling process (no core dumps, no ptrace or /proc access by the same user): 0 or -errno. */
  export function setNotDumpable(): number
}

export = nodePoll
