/** A native file descriptor plus its type. */
export type ProxyFD = {
  /**
   * The native FD
   */
  handle: number
  /**
   * 'unknown' means the FD was created by an external application, in which case 'type' should be updated to a more
   * concrete type before doing any operations on it.
   */
  type: 'pipe-read' | 'pipe-write' | 'shm' | 'unknown'
}
