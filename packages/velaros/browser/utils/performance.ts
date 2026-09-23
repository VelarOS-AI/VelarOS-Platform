import { gzipSync } from 'node:zlib'

import { isEmpty, isFiniteNumber, isNull, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserParsedTraceRecording } from '../types/runtime.js'

import { BrowserTuning } from './tuning'

/** 把原始 trace 事件序列化成 .json.gz 字节，供落盘归档（可被 DevTools 面板直接打开）。 */
export function serializeBrowserTraceToGzip(recording: BrowserParsedTraceRecording): Buffer {
  return gzipSync(JSON.stringify({ traceEvents: recording.rawEvents }))
}

/** trace 的自动停止时长归一；没给就用缺省窗口。 */
export function resolveAutoStopMs(value: LooseOptional<number>): number {
  if (isNull(value) || value === 0) return 0
  if (!isPresent(value)) return BrowserTuning.performance.traceAutoStopMs
  if (!isFiniteNumber(value) || value < 0) return BrowserTuning.performance.traceAutoStopMs
  return Math.min(60_000, Math.max(1_000, Math.round(value)))
}

/** 从解析结果里取出一个 insight；insightSetId 或 insightName 不存在时把可用值一并报出。 */
export function readBrowserTraceInsight(
  recording: BrowserParsedTraceRecording,
  insightSetId: string,
  insightName: string
): unknown {
  const insights = recording.parsedTrace.insights
  if (!insights || insights.size === 0) {
    throw new AppError('VALIDATION', '这次 trace 没有可用的性能 insights。')
  }

  const insightSet = insights.get(insightSetId)
  if (!insightSet) {
    throw new AppError(
      'VALIDATION',
      `insightSetId 不存在：${insightSetId}。可用值：${[...insights.keys()].join(', ')}`
    )
  }

  const insight = insightSet.model[insightName]
  if (!insight) {
    const available = Object.keys(insightSet.model).join(', ')
    throw new AppError('VALIDATION', `insight 不存在：${insightName}。可用值：${available}`)
  }

  return insight
}

/**
 * 从 DevTools trace 摘要里抽出每个 insight set 的顶层 Core Web Vitals。
 *
 * 摘要格式稳定:`## insight set id: X` 分段,顶层指标是 2 空格缩进的 `- LCP: …`
 * (4 空格缩进的是 LCP breakdown 子项,不取)。抽成紧凑一行,保证 summary 被折叠时
 * 关键数值仍可见,避免 agent 反复 recall 去 summary blob 里挖 CLS/INP。
 */
export function extractKeyMetricsFromSummary(summary: string): string {
  const sections: string[] = []
  let currentSet: Nullable<string> = null
  let metrics: string[] = []

  const flush = (): void => {
    if (currentSet && !isEmpty(metrics)) {
      sections.push(`${currentSet}: ${metrics.join(', ')}`)
    }
    metrics = []
  }

  for (const line of summary.split('\n')) {
    const setPrefix = '## insight set id:'
    if (line.startsWith('##')) {
      const header = line.slice(2).trimStart()
      if (header.startsWith(setPrefix.slice(3))) {
        const setId = header.slice(setPrefix.length - 3).trim()
        if (setId) {
          flush()
          currentSet = setId
          continue
        }
      }
    }
    // 顶层 CWV:恰好 2 空格 + `-NAME: value`(排除 4 空格的 breakdown 子项)。
    if (!line.startsWith('  -')) continue
    const metric = line.slice(3).trimStart()
    const separator = metric.indexOf(':')
    if (separator < 0) continue
    const name = metric.slice(0, separator).trimEnd()
    if (!['LCP', 'CLS', 'INP', 'FCP', 'TTFB'].includes(name)) continue
    let value = metric.slice(separator + 1).trim()
    let suffixCursor = 0
    while (suffixCursor < value.length) {
      const comma = value.indexOf(',', suffixCursor)
      if (comma < 0) break
      const suffix = value.slice(comma + 1).trimStart()
      if (
        suffix.startsWith('event:') ||
        suffix.startsWith('nodeId:') ||
        suffix.startsWith('bounds:')
      ) {
        value = value.slice(0, comma).trimEnd()
        break
      }
      suffixCursor = comma + 1
    }
    if (value) metrics.push(`${name} ${value}`)
  }
  flush()

  return !isEmpty(sections) ? sections.join(' | ') : '(未从摘要解析到 Core Web Vitals)'
}
