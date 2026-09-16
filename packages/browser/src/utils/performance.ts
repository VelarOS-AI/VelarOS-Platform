import { gzipSync } from 'node:zlib'

import { isFiniteNumber, isNull, isPresent } from '@velaros-ai/core'
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
