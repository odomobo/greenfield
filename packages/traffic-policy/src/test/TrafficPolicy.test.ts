import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LinkStats, SendTier, TrafficSource } from '@nebula/session-contracts'
import { BANDWIDTH_PERIOD_MS, LIMITED_PERIODS } from '../bandwidth.js'
import { BURST_MS, CLASS_PERIOD_MS } from '../priority.js'
import { TrafficPolicy } from '../TrafficPolicy.js'

/** A surface as traffic policy sees it: the test sets its measures. */
class FakeSource implements TrafficSource {
  hasContent = true
  settled = true
  predictedBacklogBytes = 0
  unencodedBytes = 0
  promoted = 0

  constructor(readonly key: string) {}

  onPromoted() {
    this.promoted++
  }
}

function setup() {
  let now = 0
  const infos: string[] = []
  const linkInfos: string[] = []
  const policy = new TrafficPolicy({
    logger: { info: (message) => infos.push(message) },
    linkLogger: { info: (message) => linkInfos.push(message) },
    now: () => now,
  })
  const link = { bandwidthLimited: false, linkBandwidth: undefined as number | undefined }
  return {
    policy,
    infos,
    linkInfos,
    link,
    connect() {
      policy.useLink(link)
    },
    advance(ms: number) {
      now += ms
    },
    surface(key: string) {
      const source = new FakeSource(key)
      return { source, traffic: policy.addSurface(source) }
    },
  }
}

/** Relentless for `ms`: busy all the time, a commit every 50 ms. */
function relentless(env: ReturnType<typeof setup>, traffic: ReturnType<typeof env.surface>['traffic'], ms: number) {
  traffic.setBusy(true)
  for (let t = 0; t < ms; t += 50) {
    env.advance(50)
    traffic.committed()
  }
}

test('a relentless surface is promoted by the time measure, logged with its last period', () => {
  const env = setup()
  const { traffic } = env.surface('a')
  assert.equal(traffic.surfaceClass, 'normal')
  relentless(env, traffic, 3 * CLASS_PERIOD_MS)
  assert.equal(traffic.surfaceClass, 'streaming')
  assert.ok(env.infos.some((message) => message.startsWith('Surface a is now streaming (last period: busy 100%')))
})

test('a quiet streaming surface is demoted only once it is settled', () => {
  const env = setup()
  const { source, traffic } = env.surface('a')
  relentless(env, traffic, 3 * CLASS_PERIOD_MS)
  traffic.setBusy(false)
  source.settled = false
  env.advance(2 * CLASS_PERIOD_MS)
  assert.equal(traffic.evaluate(), false)
  assert.equal(traffic.surfaceClass, 'streaming')
  source.settled = true
  assert.equal(traffic.evaluate(), true)
  assert.equal(traffic.surfaceClass, 'normal')
  assert.ok(env.infos.at(-1)!.startsWith('Surface a is now normal'))
})

test('bottleneck: only a streaming surface is link-bound, and only while the link is short', () => {
  const env = setup()
  const normal = env.surface('normal')
  const streaming = env.surface('streaming')
  relentless(env, streaming.traffic, 3 * CLASS_PERIOD_MS)
  assert.equal(streaming.traffic.surfaceClass, 'streaming')
  // no viewer: the link isn't short
  assert.equal(streaming.traffic.bottleneck, 'cpu')
  env.connect()
  assert.equal(streaming.traffic.bottleneck, 'cpu')
  env.link.bandwidthLimited = true
  assert.equal(streaming.traffic.bottleneck, 'link')
  assert.equal(normal.traffic.bottleneck, 'cpu')
  // video quality follows the link, whatever the class
  assert.equal(normal.traffic.videoQuality, 'low')
  env.policy.disconnect()
  assert.equal(streaming.traffic.bottleneck, 'cpu')
  assert.equal(streaming.traffic.videoQuality, 'high')
})

test("send tiers: a surface's class for its damage, settle for settling", () => {
  const env = setup()
  const { traffic } = env.surface('a')
  assert.deepEqual([traffic.sendTier(false), traffic.sendTier(true)], ['normal', 'settle'])
  relentless(env, traffic, 3 * CLASS_PERIOD_MS)
  assert.deepEqual([traffic.sendTier(false), traffic.sendTier(true)], ['streaming', 'settle'])
})

test('burst promotion: while the normal surfaces would need more than BURST_MS of the link, the largest is promoted', () => {
  const env = setup()
  env.connect()
  // 100 bytes per ms: BURST_MS is 20 KB
  env.link.linkBandwidth = 100
  const small = env.surface('small')
  small.source.predictedBacklogBytes = 40_000
  env.policy.checkBurst()
  assert.equal(small.traffic.surfaceClass, 'streaming', 'alone over the threshold')
  assert.equal(small.source.promoted, 1)
  // under the threshold; the streaming surface doesn't count
  const other = env.surface('other')
  other.source.predictedBacklogBytes = 10_000
  env.policy.checkBurst()
  assert.equal(other.traffic.surfaceClass, 'normal')
  // the largest is promoted first; then 10 KB of normal backlog is left
  const large = env.surface('large')
  large.source.predictedBacklogBytes = 4_000_000
  env.policy.checkBurst()
  assert.equal(large.traffic.surfaceClass, 'streaming')
  assert.equal(other.traffic.surfaceClass, 'normal')
  assert.ok(env.infos.some((message) => message.startsWith('Surface large is now streaming (a burst: ')))
  assert.ok(
    env.infos.includes("Surface large is now streaming (a burst: the normal surfaces' predicted backlog is 40100 ms)."),
  )
})

test('no burst promotion before the link was bandwidth-limited (its bandwidth is unknown), nor without a viewer', () => {
  const env = setup()
  const { source, traffic } = env.surface('a')
  source.predictedBacklogBytes = 1_000_000
  env.policy.checkBurst()
  assert.equal(traffic.surfaceClass, 'normal')
  env.connect()
  env.policy.checkBurst()
  assert.equal(traffic.surfaceClass, 'normal')
  env.link.linkBandwidth = 100
  env.policy.disconnect()
  env.policy.checkBurst()
  assert.equal(traffic.surfaceClass, 'normal')
  env.connect()
  env.policy.checkBurst()
  assert.equal(traffic.surfaceClass, 'streaming')
})

test('a burst skips a surface without content, and promotes no other in its place', () => {
  const env = setup()
  env.connect()
  env.link.linkBandwidth = 100
  const empty = env.surface('empty')
  empty.source.predictedBacklogBytes = 100_000
  empty.source.hasContent = false
  const other = env.surface('other')
  other.source.predictedBacklogBytes = 30_000
  env.policy.checkBurst()
  assert.equal(empty.traffic.surfaceClass, 'normal')
  assert.equal(other.traffic.surfaceClass, 'normal')
  assert.equal(empty.source.promoted + other.source.promoted, 0)
})

test('a removed surface no longer counts', () => {
  const env = setup()
  env.connect()
  env.link.linkBandwidth = 100
  const gone = env.surface('gone')
  gone.source.predictedBacklogBytes = 15_000
  const other = env.surface('other')
  other.source.predictedBacklogBytes = 10_000
  gone.traffic.remove()
  env.policy.checkBurst()
  assert.equal(other.traffic.surfaceClass, 'normal')
})

/** The transport's link stats, as the test sets them. */
class FakeLinkStats implements LinkStats {
  unsent = 0
  streamingWaiting = true
  onDataHeld: (held: boolean, now: number) => void = () => undefined

  totalUnsentBytes(exceptTier?: SendTier) {
    assert.equal(exceptTier, 'settle')
    return this.unsent
  }

  tierWaiting(tier: SendTier) {
    return tier === 'streaming' && this.streamingWaiting
  }
}

test("a connection's link is judged from the transport's link stats and the congestion estimate", () => {
  const env = setup()
  const { traffic } = env.surface('a')
  relentless(env, traffic, 3 * CLASS_PERIOD_MS)
  const stats = new FakeLinkStats()
  const start = 3 * CLASS_PERIOD_MS
  env.policy.connect(stats, { bandwidthEstimate: 1000 })
  // held back the whole time, but only while streaming items wait
  stats.streamingWaiting = false
  stats.onDataHeld(true, start)
  env.advance(LIMITED_PERIODS * BANDWIDTH_PERIOD_MS)
  assert.equal(traffic.bottleneck, 'cpu')
  stats.streamingWaiting = true
  stats.onDataHeld(true, start + LIMITED_PERIODS * BANDWIDTH_PERIOD_MS)
  env.advance(LIMITED_PERIODS * BANDWIDTH_PERIOD_MS)
  assert.equal(traffic.bottleneck, 'link')
  assert.equal(env.linkInfos.length, 1)
  assert.ok(env.linkInfos[0].startsWith('Bandwidth-limited: streaming surfaces go lossy (held back 100% of the period'))
})

test("the link judgment's predicted backlog: the transport's unsent bytes (except settling) and the surfaces' unencoded ones", () => {
  const env = setup()
  const { source, traffic } = env.surface('a')
  relentless(env, traffic, 3 * CLASS_PERIOD_MS)
  const start = 3 * CLASS_PERIOD_MS
  const stats = new FakeLinkStats()
  env.policy.connect(stats, { bandwidthEstimate: 1000 })
  // saturated: its bandwidth is known (and it's limited); wait until it may recover
  stats.onDataHeld(true, start)
  env.advance(LIMITED_PERIODS * BANDWIDTH_PERIOD_MS)
  assert.equal(traffic.bottleneck, 'link')
  stats.onDataHeld(false, start + LIMITED_PERIODS * BANDWIDTH_PERIOD_MS)
  // a backlog of BURST_MS at 1000 bytes per ms, half in the transport, half not encoded yet: it doesn't recover
  stats.unsent = (BURST_MS / 2) * 1000
  source.unencodedBytes = (BURST_MS / 2) * 1000
  env.advance(3 * BANDWIDTH_PERIOD_MS)
  assert.equal(traffic.bottleneck, 'link')
  source.unencodedBytes = 0
  env.advance(BANDWIDTH_PERIOD_MS)
  assert.equal(traffic.bottleneck, 'cpu')
  assert.ok(env.linkInfos.at(-1)!.startsWith('No longer bandwidth-limited'))
})
