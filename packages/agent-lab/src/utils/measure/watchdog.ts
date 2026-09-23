/**
 * 看门狗：在一次等待窗口里只看增量——进窗口前记一次基线，之后每采样一次就比一次，
 * 够阈值就给出中止候选。上一段攒下的次数不算到这一段头上。纯测量：不碰 Node 模块、不发请求。
 */
import type {
  Finding,
  Observation,
  WatchdogAbort,
  WatchdogBaseline,
} from '../../types/agent-lab.js'
import type { ResolvedDetectorSettings, WatchdogSignal } from '../../types/internal.js'
import { canonicalJson } from '../canonical-json.js'

import { collectToolCalls, normalizeObservation } from './normalize.js'

/** 数出这一刻的三类打转信号：同一工具连续重复、同一目录页重复读、单轮工具调用密度。 */
function signalCounts(
  observation: Observation,
  settings: ResolvedDetectorSettings
): readonly WatchdogSignal[] {
  const { thresholds } = settings
  const catalogToolNames = new Set(settings.catalogToolNames)
  const calls = collectToolCalls(observation)
  const repeatCounts = new Map<string, number>()
  const catalogCounts = new Map<string, number>()
  let previousRetryKey: string | null = null
  let consecutiveRetryCount = 0
  for (const call of calls) {
    const input = canonicalJson(call.input)
    const retryKey = `${call.name}\u0000${input}`
    consecutiveRetryCount = retryKey === previousRetryKey ? consecutiveRetryCount + 1 : 1
    repeatCounts.set(retryKey, Math.max(repeatCounts.get(retryKey) ?? 0, consecutiveRetryCount))
    previousRetryKey = retryKey
    if (catalogToolNames.has(call.name))
      catalogCounts.set(input, (catalogCounts.get(input) ?? 0) + 1)
  }

  const signals: WatchdogSignal[] = []
  for (const [key, count] of repeatCounts) {
    signals.push({
      detectorId: 'tool-retry-loop',
      key: `retry:${key}`,
      count,
      abortAt: thresholds.retryAbort,
      reason: `同一工具与参数在本次等待窗口连续重复 ${count} 次`,
    })
  }
  for (const [key, count] of catalogCounts) {
    signals.push({
      detectorId: 'toolmap-read-loop',
      key: `toolmap:${key}`,
      count,
      abortAt: thresholds.toolMapReadAbort,
      reason: `同一工具目录页在本次等待窗口读取 ${count} 次`,
    })
  }
  for (const turn of normalizeObservation(observation).turns) {
    signals.push({
      detectorId: 'turn-tool-density',
      key: `turn:${turn.id}`,
      count: turn.toolCalls.length,
      abortAt: thresholds.turnDensityAbort,
      reason: `单轮工具调用在本次等待窗口达到 ${turn.toolCalls.length} 次`,
    })
  }
  return signals
}

/** 一条判词的去重钥匙：探测器 id 加摘要，同一句话只算一次。 */
function findingKey(finding: Finding): string {
  return `${finding.detectorId}\u0000${finding.summary}`
}

/** 进等待窗口前记一次基线：只记门探测器的信号计数与已经出过的判词。 */
export function createWatchdogBaseline(
  observation: Observation,
  findings: readonly Finding[],
  activeDetectorIds: ReadonlySet<string>,
  settings: ResolvedDetectorSettings
): WatchdogBaseline {
  return {
    counts: Object.fromEntries(
      signalCounts(observation, settings)
        .filter((signal) => activeDetectorIds.has(signal.detectorId))
        .map((signal) => [signal.key, signal.count])
    ),
    findingKeys: findings
      .filter((finding) => activeDetectorIds.has(finding.detectorId))
      .map(findingKey),
  }
}

/**
 * 看这一刻要不要掐断：先看三类信号相对基线的增量够不够阈值，再看有没有新出现的 fail 级门判词。
 * 没有就返回 `null`，继续等。
 */
export function selectAbortCandidate(
  observation: Observation,
  findings: readonly Finding[],
  baseline: WatchdogBaseline,
  activeDetectorIds: ReadonlySet<string>,
  settings: ResolvedDetectorSettings
): WatchdogAbort | null {
  for (const signal of signalCounts(observation, settings).filter((item) =>
    activeDetectorIds.has(item.detectorId)
  )) {
    const delta = signal.count - (baseline.counts[signal.key] ?? 0)
    if (delta >= signal.abortAt) return { detectorId: signal.detectorId, reason: signal.reason }
  }
  const baselineFindings = new Set(baseline.findingKeys)
  const fatal = findings.find(
    (item) =>
      activeDetectorIds.has(item.detectorId) &&
      item.severity === 'fail' &&
      !baselineFindings.has(findingKey(item))
  )
  return fatal ? { detectorId: fatal.detectorId, reason: fatal.summary } : null
}
