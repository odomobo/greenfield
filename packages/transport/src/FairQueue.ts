/**
 * The fair-queueing mechanism of the transport's data items: deficit round-robin over the send tiers (weighted by
 * bytes, work-conserving), round-robin over the streams of a tier, and per-stream readiness. The tiers and their
 * weights are given to it (by traffic policy); it knows tier ids, not what they mean.
 */
import { cutChunk, payloadBytes } from './chunking.js'

/**
 * A send tier: its id, and its quantum, the bytes it may send per turn of the deficit round-robin (plus what it carried
 * over). The quanta's ratios are the tiers' weights. Tiers are given from the highest priority, the round-robin's order.
 */
export type TierConfig = { readonly id: string; readonly quantum: number }

/** A data item in the queue. The queue doesn't look into it. */
export interface QueuedItem {
  readonly tier: string
  /** its size as counted for readiness and the unsent bytes */
  readonly size: number
  /** its envelope (as sent whole, or cut into chunks) */
  envelope(): Uint8Array
  /** called once: sent true when handed to the socket, false if the transport closed before it was */
  readonly done?: (sent: boolean) => void
}

/** A data item being sent in chunks: its envelope and how much of it went out. */
type StartedItem = { readonly item: QueuedItem; readonly envelope: Uint8Array; readonly id: number; sent: number }

/** The next piece of a data item to hand to the socket. */
export type NextSend = {
  stream: string
  item: QueuedItem
  /** what to write: the whole envelope, or a CHUNK of it */
  data: Uint8Array
  /** its first piece (the item leaves its stream's chain) */
  first: boolean
  /** its last piece (the item is done once it's written) */
  last: boolean
}

export class FairQueue {
  /** the tiers from the highest priority */
  private readonly tiers: readonly string[]
  private readonly quantum = new Map<string, number>()
  /**
   * Unsent items per stream, in order; a stream's entry goes once nothing of it is waiting (its started item aside).
   * Map iteration order (insertion) is the round-robin order between streams: a stream goes to the back after each of
   * its items is sent. A stream's tier is the highest of its items' (see tierOf).
   */
  private readonly pending = new Map<string, QueuedItem[]>()
  /**
   * Items being sent in chunks, at most one per stream (its next item waits) and one per tier (a tier continues its
   * started item before it starts another). They are out of their stream's chain.
   */
  private readonly started = new Map<string, StartedItem>()
  private nextItemId = 0
  /** streams found not ready (see ready): told when they are (see takeReady) */
  private readonly waitingForReady = new Set<string>()
  /** deficit round-robin state: whose turn it is, whether it got its quantum for this turn, bytes carried over */
  private turn: string
  private quantumGiven = false
  private readonly deficit = new Map<string, number>()

  constructor(tiers: readonly TierConfig[]) {
    if (tiers.length === 0) {
      throw new Error('The transport needs at least one send tier.')
    }
    this.tiers = tiers.map(({ id }) => id)
    for (const { id, quantum } of tiers) {
      this.quantum.set(id, quantum)
      this.deficit.set(id, 0)
    }
    this.turn = this.tiers[0]
  }

  /** Whether any data item waits (queued or started). */
  get waiting(): boolean {
    return this.pending.size > 0 || this.started.size > 0
  }

  /** Whether any stream's items wait in the tier (the highest tier of a stream's items, see tierOf). */
  tierWaiting(tier: string): boolean {
    return this.findHead(tier) !== undefined
  }

  enqueue(stream: string, item: QueuedItem): void {
    if (!this.quantum.has(item.tier)) {
      throw new Error(`Unknown send tier ${item.tier}.`)
    }
    const chain = this.pending.get(stream)
    if (chain === undefined) {
      this.pending.set(stream, [item])
    } else {
      chain.push(item)
    }
  }

  /** The bytes of the stream's items not sent yet: its queued items and what's left of its started one. */
  unsentBytes(stream: string, exceptTier?: string): number {
    let bytes = 0
    const started = this.started.get(stream)
    if (started !== undefined && started.item.tier !== exceptTier) {
      bytes += started.envelope.length - started.sent
    }
    for (const item of this.pending.get(stream) ?? []) {
      if (item.tier !== exceptTier) {
        bytes += item.size
      }
    }
    return bytes
  }

  /** The unsent bytes (see unsentBytes) of all streams. */
  totalUnsentBytes(exceptTier?: string): number {
    let bytes = 0
    for (const stream of new Set([...this.pending.keys(), ...this.started.keys()])) {
      bytes += this.unsentBytes(stream, exceptTier)
    }
    return bytes
  }

  /**
   * Whether the stream is ready for its next item: at most one chunk of its data is left unsent (see unsentBytes). A
   * stream found not ready is remembered, and reported by takeReady once it is.
   */
  ready(stream: string, chunkSize: number, exceptTier?: string): boolean {
    const ready = this.unsentBytes(stream, exceptTier) <= chunkSize
    if (!ready) {
      this.waitingForReady.add(stream)
    }
    return ready
  }

  /** The streams found not ready (see ready) that are ready now (all of their data counted); forgets them. */
  takeReady(chunkSize: number): string[] {
    if (this.waitingForReady.size === 0) {
      return []
    }
    const ready: string[] = []
    for (const stream of this.waitingForReady) {
      if (this.unsentBytes(stream) <= chunkSize) {
        ready.push(stream)
      }
    }
    for (const stream of ready) {
      this.waitingForReady.delete(stream)
    }
    return ready
  }

  /** Empty the queue: everything queued or started, to be reported unsent (queued items first, by stream). */
  clear(): QueuedItem[] {
    const unsent: QueuedItem[] = []
    for (const chain of this.pending.values()) {
      unsent.push(...chain)
    }
    this.pending.clear()
    unsent.push(...[...this.started.values()].map(({ item }) => item))
    this.started.clear()
    this.waitingForReady.clear()
    return unsent
  }

  private nextTier(tier: string): string {
    return this.tiers[(this.tiers.indexOf(tier) + 1) % this.tiers.length]
  }

  /** The tier a stream's items wait in: the highest of any of them (they're sent in order). */
  private tierOf(chain: QueuedItem[]): string {
    let rank = this.tiers.length - 1
    for (const item of chain) {
      rank = Math.min(rank, this.tiers.indexOf(item.tier))
    }
    return this.tiers[rank]
  }

  /** The tier a stream's items wait in, its started one included (they go in order). */
  private streamTier(stream: string): string {
    const chain = this.pending.get(stream) ?? []
    const started = this.started.get(stream)
    return this.tierOf(started ? [started.item, ...chain] : chain)
  }

  /**
   * What the tier sends next: its started item (one at a time), else the first stream of the tier in round-robin
   * order with nothing started, and its chain of items.
   */
  private findHead(
    tier: string,
  ): { stream: string; started: StartedItem } | { stream: string; chain: QueuedItem[] } | undefined {
    for (const [stream, started] of this.started) {
      if (this.streamTier(stream) === tier) {
        return { stream, started }
      }
    }
    for (const [stream, chain] of this.pending) {
      if (!this.started.has(stream) && this.tierOf(chain) === tier) {
        return { stream, chain }
      }
    }
    return undefined
  }

  /** The next chunk of a started item; the item is done with its last. */
  private nextChunk(stream: string, started: StartedItem, chunkSize: number): NextSend {
    const { data, end } = cutChunk(started.id, started.envelope, started.sent, chunkSize)
    return { stream, item: started.item, data, first: started.sent === 0, last: end >= started.envelope.length }
  }

  /**
   * The next data item (or chunk) to send, by deficit round-robin between the tiers, weighted by bytes: on its turn a
   * tier adds its quantum to its deficit and sends items (chunks) while the next fits in the deficit. A tier with
   * nothing waiting loses its turn and its deficit, so the others share the whole link. Items larger than `chunkSize`
   * go in chunks of it. If nothing is taken (nothing is waiting, or `allowed` refuses the next piece by its size), the
   * round-robin state stays as it was: the transport asks again whenever the congestion controller might allow more,
   * and those questions must not count as turns.
   */
  takeNext(chunkSize: number, allowed: (bytes: number) => boolean): NextSend | undefined {
    if (!this.waiting) {
      return undefined
    }
    const saved = { turn: this.turn, quantumGiven: this.quantumGiven, deficit: new Map(this.deficit) }
    const nothingTaken = () => {
      this.turn = saved.turn
      this.quantumGiven = saved.quantumGiven
      for (const [tier, deficit] of saved.deficit) {
        this.deficit.set(tier, deficit)
      }
      return undefined
    }
    // a deficit grows every turn, so even a huge item fits eventually
    for (let turns = 0; turns < 10_000; turns++) {
      const turn = this.turn
      const head = this.findHead(turn)
      if (head === undefined) {
        this.deficit.set(turn, 0)
        this.quantumGiven = false
        this.turn = this.nextTier(turn)
        continue
      }
      if (!this.quantumGiven) {
        this.quantumGiven = true
        this.deficit.set(turn, this.deficit.get(turn)! + this.quantum.get(turn)!)
      }
      let next: NextSend
      let start: (() => void) | undefined
      if ('started' in head) {
        next = this.nextChunk(head.stream, head.started, chunkSize)
      } else {
        const item = head.chain[0]
        const envelope = item.envelope()
        if (envelope.length <= chunkSize) {
          next = { stream: head.stream, item, data: envelope, first: true, last: true }
        } else {
          const started: StartedItem = { item, envelope, id: this.nextItemId, sent: 0 }
          next = this.nextChunk(head.stream, started, chunkSize)
          start = () => {
            this.nextItemId = (this.nextItemId + 1) >>> 0
            this.started.set(head.stream, started)
          }
        }
      }
      const cost = payloadBytes(next.data, next.first && next.last)
      if (cost <= this.deficit.get(turn)!) {
        if (!allowed(next.data.length)) {
          return nothingTaken()
        }
        this.deficit.set(turn, this.deficit.get(turn)! - cost)
        if (next.first) {
          // out of the chain: from here on it's sent
          const chain = this.pending.get(head.stream)!
          chain.shift()
          if (chain.length === 0) {
            this.pending.delete(head.stream)
          }
          start?.()
        }
        const started = this.started.get(head.stream)
        if (started !== undefined && !next.last) {
          started.sent += payloadBytes(next.data, false)
        }
        if (next.last) {
          this.started.delete(head.stream)
          // back of the line, for fairness between streams
          const chain = this.pending.get(head.stream)
          if (chain !== undefined) {
            this.pending.delete(head.stream)
            this.pending.set(head.stream, chain)
          }
        }
        return next
      }
      this.quantumGiven = false
      this.turn = this.nextTier(turn)
    }
    return nothingTaken()
  }
}
