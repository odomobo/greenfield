/**
 * A simulated network path between the session and a viewer, on a virtual clock, for testing the congestion
 * controller. No sockets, no timers: every scenario runs as fast as the CPU allows.
 *
 * Model: the server hands data items to a bottleneck (FIFO, configurable rate, unbounded buffer: bufferbloat). An item
 * leaves the bottleneck after waiting for the items ahead of it plus its own transmission time, then arrives at the
 * viewer after the forward propagation delay (half the base RTT, plus optional jitter; arrivals stay in order, like
 * TCP). The viewer acks on arrival (optionally batched to the next 16 ms frame), applies items at a configurable rate,
 * and sends a fresh ack when its backlog shrinks while its last report was over the hold threshold. Acks take the
 * return propagation delay. Control messages bypass the controller and go first.
 */
import { CongestionController, CongestionState } from '@nebula/congestion'

export type Source = {
  /** size of the next data item, or undefined if there is none now */
  peek(now: number): number | undefined
  take(now: number): void
  /** when the next item will be produced (for sources that produce over time), or Infinity */
  nextProduction(now: number): number
}

/** Always has an item. */
export function saturating(size: (i: number) => number): Source {
  let i = 0
  return {
    peek: () => size(i),
    take: () => void i++,
    nextProduction: () => Infinity,
  }
}

/** Produces items of `itemSize` at `bytesPerMs`; they queue (unbounded) until sent. */
export function constantRate(bytesPerMs: number, itemSize: number, start = 0): Source {
  const interval = itemSize / bytesPerMs
  let produced = 0
  let taken = 0
  const count = (now: number) => Math.max(0, Math.floor((now - start) / interval) + 1)
  return {
    peek: (now) => {
      produced = count(now)
      return produced > taken ? itemSize : undefined
    },
    take: () => void taken++,
    nextProduction: (now) => start + count(now) * interval,
  }
}

/** Bursts of items with idle gaps, from a fixed script: [time, item sizes][] */
export function scripted(bursts: { at: number; sizes: number[] }[]): Source {
  const queue: number[] = []
  let next = 0
  const produce = (now: number) => {
    while (next < bursts.length && bursts[next].at <= now) {
      queue.push(...bursts[next].sizes)
      next++
    }
  }
  return {
    peek: (now) => {
      produce(now)
      return queue[0]
    },
    take: () => void queue.shift(),
    nextProduction: () => (next < bursts.length ? bursts[next].at : Infinity),
  }
}

export type LinkConfig = {
  /** bottleneck rate in bytes per ms at time t (1 Mbit/s = 125 bytes/ms) */
  rate: (t: number) => number
  /** base round-trip time (propagation only) in ms at time t */
  baseRtt: (t: number) => number
  /** forward jitter: uniformly random in [-jitter, +jitter] ms */
  jitterMs?: number
  /** acks leave the viewer at the next multiple of this (ms), like a browser frame; 0: immediately */
  ackBatchMs?: number
  /** the viewer applies items at this rate (bytes per ms); Infinity: right after it acks them */
  applyRate?: number
  /** control messages: produced at these times */
  controlAt?: number[]
  seed?: number
  /** called after every ack the controller processed (for debugging) */
  trace?: (now: number, controller: CongestionController) => void
  /** called at the end of every pump: whether data waits, held back by the controller */
  onPump?: (now: number, held: boolean, controller: CongestionController) => void
  /** called for every item handed to the network */
  onTransmit?: (now: number, size: number) => void
}

export type ItemRecord = {
  size: number
  sendTime: number
  /** time spent waiting at the bottleneck behind earlier items */
  queueDelay: number
  departure: number
  stateAtSend: CongestionState
}

export type SimResult = {
  items: ItemRecord[]
  /** time spent by control messages between being produced and being handed to the network */
  controlDelays: number[]
  /** the viewer's actual backlog (bytes received, not applied) after each arrival */
  backlogSamples: { time: number; bytes: number }[]
  /** state of the controller over time: [time, state] at every change */
  states: { time: number; state: CongestionState }[]
  minRttSamples: { time: number; minRtt: number }[]
  controller: CongestionController
}

/** mulberry32 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Event = { time: number; seq: number; run: () => void }

class EventQueue {
  private heap: Event[] = []
  private seq = 0

  push(time: number, run: () => void) {
    const event = { time, seq: this.seq++, run }
    const heap = this.heap
    heap.push(event)
    let i = heap.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (before(heap[parent], heap[i])) {
        break
      }
      ;[heap[parent], heap[i]] = [heap[i], heap[parent]]
      i = parent
    }
  }

  pop(): Event | undefined {
    const heap = this.heap
    if (heap.length === 0) {
      return undefined
    }
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < heap.length && before(heap[l], heap[m])) m = l
        if (r < heap.length && before(heap[r], heap[m])) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i], heap[m]]
        i = m
      }
    }
    return top
  }
}

function before(a: Event, b: Event) {
  return a.time < b.time || (a.time === b.time && a.seq < b.seq)
}

export const HOLD_BYTES = 1024 * 1024

export function simulate(config: LinkConfig, source: Source, durationMs: number): SimResult {
  const random = seededRandom(config.seed ?? 1)
  const controller = new CongestionController({ now: 0, random, backlogHoldBytes: HOLD_BYTES })
  const events = new EventQueue()
  const items: ItemRecord[] = []
  const controlDelays: number[] = []
  const backlogSamples: { time: number; bytes: number }[] = []
  const states: { time: number; state: CongestionState }[] = [{ time: 0, state: controller.state }]
  const minRttSamples: { time: number; minRtt: number }[] = []
  const jitter = config.jitterMs ?? 0
  const ackBatch = config.ackBatchMs ?? 0
  const applyRate = config.applyRate ?? Infinity

  let linkFreeAt = 0
  let lastArrival = 0
  let lastAckArrival = 0
  // viewer state
  let received = 0
  const pending: number[] = []
  let backlog = 0
  let lastReportedExcess = 0
  let applyFreeAt = 0
  // server state
  let wakeAt = Infinity
  const pendingControl: number[] = [...(config.controlAt ?? [])].sort((a, b) => a - b)

  const noteState = (now: number) => {
    const last = states[states.length - 1]
    if (last.state !== controller.state) {
      states.push({ time: now, state: controller.state })
    }
  }

  const largestPending = () => pending.reduce((max, size) => Math.max(max, size), 0)

  const sendAck = (now: number) => {
    const report = { received: received >>> 0, backlogBytes: backlog, largestPendingBytes: largestPending() }
    lastReportedExcess = report.backlogBytes - report.largestPendingBytes
    const leave = ackBatch > 0 ? Math.ceil(now / ackBatch) * ackBatch : now
    const arrive = Math.max(lastAckArrival, leave + config.baseRtt(leave) / 2)
    lastAckArrival = arrive
    events.push(arrive, () => {
      controller.onAck(report, arrive)
      config.trace?.(arrive, controller)
      noteState(arrive)
      minRttSamples.push({ time: arrive, minRtt: controller.min_rtt })
      pump(arrive)
    })
  }

  const arriveAtViewer = (size: number, now: number) => {
    received++
    pending.push(size)
    backlog += size
    backlogSamples.push({ time: now, bytes: backlog })
    // ack first, before applying (like the viewer's message handler)
    sendAck(now)
    const start = Math.max(now, applyFreeAt)
    const done = applyRate === Infinity ? start : start + size / applyRate
    applyFreeAt = done
    events.push(done, () => {
      pending.shift()
      backlog -= size
      if (lastReportedExcess > HOLD_BYTES) {
        sendAck(done)
      }
    })
  }

  const transmit = (size: number, now: number) => {
    const start = Math.max(now, linkFreeAt)
    const departure = start + size / config.rate(start)
    linkFreeAt = departure
    let arrival = departure + config.baseRtt(departure) / 2 + (jitter ? (random() * 2 - 1) * jitter : 0)
    arrival = Math.max(arrival, lastArrival, departure)
    lastArrival = arrival
    items.push({ size, sendTime: now, queueDelay: start - now, departure, stateAtSend: controller.state })
    events.push(arrival, () => arriveAtViewer(size, arrival))
  }

  const pump = (now: number) => {
    // control messages first, never gated
    while (pendingControl.length && pendingControl[0] <= now) {
      controlDelays.push(now - pendingControl.shift()!)
    }
    let held = false
    for (;;) {
      const size = source.peek(now)
      if (size === undefined) {
        controller.setDataWaiting(false)
        break
      }
      controller.setDataWaiting(true)
      if (!controller.canSend(size, now)) {
        held = true
        const at = controller.nextSendTime(size, now)
        if (at !== Infinity && at < wakeAt) {
          wakeAt = at
          events.push(at, () => {
            if (wakeAt === at) {
              wakeAt = Infinity
            }
            pump(at)
          })
        }
        break
      }
      source.take(now)
      controller.onSend(size, now)
      noteState(now)
      config.onTransmit?.(now, size)
      transmit(size, now)
    }
    config.onPump?.(now, held, controller)
    const next = source.nextProduction(now)
    if (next !== Infinity && next > now) {
      scheduleProduction(next)
    }
  }

  let productionAt = Infinity
  const scheduleProduction = (at: number) => {
    if (at >= productionAt) {
      return
    }
    productionAt = at
    events.push(at, () => {
      if (productionAt === at) {
        productionAt = Infinity
      }
      pump(at)
    })
  }

  for (const at of pendingControl) {
    events.push(at, () => pump(at))
  }
  events.push(0, () => pump(0))
  for (;;) {
    const event = events.pop()
    if (event === undefined || event.time > durationMs) {
      break
    }
    event.run()
  }
  return { items, controlDelays, backlogSamples, states, minRttSamples, controller }
}

// metrics -------------------------------------------------------------------------------------------------------------

/** Fraction of the link's capacity used in [from, to): bytes leaving the bottleneck over the capacity. */
export function utilization(result: SimResult, config: LinkConfig, from: number, to: number): number {
  let bytes = 0
  for (const item of result.items) {
    const start = item.departure - item.size / config.rate(item.departure)
    // the share of the item's transmission inside the window
    const overlap = Math.max(0, Math.min(item.departure, to) - Math.max(start, from))
    if (item.departure > start) {
      bytes += (item.size * overlap) / (item.departure - start)
    }
  }
  let capacity = 0
  for (let t = from; t < to; t += 1) {
    capacity += config.rate(t)
  }
  return bytes / capacity
}

export function itemsBetween(result: SimResult, from: number, to: number): ItemRecord[] {
  return result.items.filter((item) => item.sendTime >= from && item.sendTime < to)
}

export function maxQueueDelay(items: ItemRecord[]): number {
  return items.reduce((max, item) => Math.max(max, item.queueDelay), 0)
}

export const mbit = (megabits: number) => (megabits * 1_000_000) / 8 / 1000 // bytes per ms
