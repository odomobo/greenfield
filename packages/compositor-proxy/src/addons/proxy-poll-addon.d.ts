declare namespace nodePoll {
  export type PollHandle = unknown

  export function startPoll(fd: number, handlePollEvent: (status: number, events: number) => void): PollHandle

  export function stopPoll(pollHandle: PollHandle)

  /** TCP_NOTSENT_LOWAT, returns 0 or errno */
  export function setTcpNotSentLowat(fd: number, bytes: number): number

  /** SO_SNDBUF, returns 0 or errno */
  export function setSocketSendBuffer(fd: number, bytes: number): number
}

export = nodePoll
