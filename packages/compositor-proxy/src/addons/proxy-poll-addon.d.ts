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
}

export = nodePoll
