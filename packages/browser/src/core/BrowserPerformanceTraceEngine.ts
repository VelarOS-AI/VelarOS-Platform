import { gzipSync } from 'node:zlib'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type * as DevtoolsPerformanceEngineModule from '../../vendor/devtools-performance-engine/devtoolsPerformanceEngine.mjs'
import type {
  DevtoolsParsedTrace,
  DevtoolsTraceModel,
} from '../../vendor/devtools-performance-engine/devtoolsPerformanceEngine.mjs'

/**
 * 性能 trace 解析引擎（吸收自 chrome-devtools-mcp 的 trace-processing/parse.ts，Apache-2.0）。
 *
 * 背后是 vendor 的 DevTools 官方 trace 引擎：负责把 CDP Tracing 采到的原始事件
 * 解析成 insights，并格式化成模型可读的摘要/insight 文本。
 * 引擎 ~2MB，首次调用时动态 import，避免拖慢主进程启动。
 */

/** 一次 trace 录制的解析产物；rawEvents 供落盘，parsedTrace 供 insight 查询。 */
export interface BrowserParsedTraceRecording {
  parsedTrace: DevtoolsParsedTrace
  insightSetIds: string[]
  rawEvents: unknown[]
}

export interface BrowserTraceParseMetadata {
  cpuThrottling?: number
  networkThrottling?: string
}

type PerformanceEngineModule = typeof DevtoolsPerformanceEngineModule

let engineModulePromise: Nullable<Promise<PerformanceEngineModule>> = null
let i18nBootstrapped = false

const log = logRuntime.tag('BrowserPerformanceTraceEngine')

/**
 * i18n 引导（做法同 chrome-devtools-mcp 的 DevtoolsUtils）：
 * insight runner 依赖 i18nString，locale 未初始化时每个 runner 都会抛错
 * 并被引擎静默吞进 errors —— 表象是 insights.model 恒为空对象。
 */
function bootstrapEngineI18n(module: PerformanceEngineModule): void {
  if (i18nBootstrapped) return
  module.I18n.DevToolsLocale.DevToolsLocale.instance({
    create: true,
    data: {
      navigatorLanguage: 'en-US',
      settingLanguage: 'en-US',
      lookupClosestDevToolsLocale: (locale) => locale,
    },
  })
  module.I18n.i18n.registerLocaleDataForTest('en-US', {})
  i18nBootstrapped = true
}

async function loadEngineModule(): Promise<PerformanceEngineModule> {
  engineModulePromise ??= import(
    '../../vendor/devtools-performance-engine/devtoolsPerformanceEngine.mjs'
  ).then((module) => {
    bootstrapEngineI18n(module)
    return module
  })
  return engineModulePromise
}

/**
 * Per-runtime trace processor.
 *
 * DevTools' model is mutable: parsing resets its processor. Each Browser
 * runtime therefore owns one instance and this class serializes parse calls so
 * concurrent sessions cannot reset one another mid-parse.
 */
export class BrowserPerformanceTraceEngine {
  private engine: Nullable<DevtoolsTraceModel> = null
  private parseQueue: Promise<void> = Promise.resolve()

  public parse(
    events: unknown[],
    metadata: BrowserTraceParseMetadata = {}
  ): Promise<BrowserParsedTraceRecording> {
    const operation = this.parseQueue.then(() => this.parseNow(events, metadata))
    this.parseQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  public async formatSummary(recording: BrowserParsedTraceRecording): Promise<string> {
    return formatBrowserTraceSummary(recording)
  }

  public async formatInsight(
    recording: BrowserParsedTraceRecording,
    insightSetId: string,
    insightName: string
  ): Promise<string> {
    return formatBrowserTraceInsight(recording, insightSetId, insightName)
  }

  private async parseNow(
    events: unknown[],
    metadata: BrowserTraceParseMetadata
  ): Promise<BrowserParsedTraceRecording> {
    if (isEmpty(events)) {
      throw new AppError('EXECUTION_FAILED', '性能 trace 没有采集到任何事件。')
    }

    const module = await loadEngineModule()
    this.engine ??= module.TraceEngine.TraceModel.Model.createWithAllHandlers()
    this.engine.resetProcessor()
    try {
      await this.engine.parse(events, { metadata: { ...metadata } })
    } catch (error) {
      const reason = AppError.from(error).message
      log.warn('trace 引擎解析失败', { reason, events: events.length })
      throw new AppError('EXECUTION_FAILED', `性能 trace 解析失败：${reason}`)
    }

    const parsedTrace = this.engine.parsedTrace()
    if (!parsedTrace) {
      throw new AppError('EXECUTION_FAILED', '性能 trace 引擎没有返回解析结果。')
    }

    return {
      parsedTrace,
      insightSetIds: parsedTrace.insights ? [...parsedTrace.insights.keys()] : [],
      rawEvents: events,
    }
  }
}

const compatibilityTraceEngine = new BrowserPerformanceTraceEngine()

/**
 * @deprecated Prefer a host-owned `BrowserPerformanceTraceEngine`, or let
 * `BrowserPerformanceOrchestrator` own one per runtime.
 */
export function parseBrowserTraceEvents(
  events: unknown[],
  metadata: BrowserTraceParseMetadata = {}
): Promise<BrowserParsedTraceRecording> {
  return compatibilityTraceEngine.parse(events, metadata)
}

/** 生成整体 trace 摘要（含 available insights 清单与调用树/网络格式说明）。 */
export async function formatBrowserTraceSummary(
  recording: BrowserParsedTraceRecording
): Promise<string> {
  const module = await loadEngineModule()
  const focus = module.AgentFocus.fromParsedTrace(recording.parsedTrace)
  const formatter = new module.PerformanceTraceFormatter(focus, 'ALL')
  return formatter.formatTraceSummary()
}

/** 生成单个 insight 的详细分析文本。 */
export async function formatBrowserTraceInsight(
  recording: BrowserParsedTraceRecording,
  insightSetId: string,
  insightName: string
): Promise<string> {
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
    throw new AppError(
      'VALIDATION',
      `insight 不存在：${insightName}。可用值：${available}`
    )
  }

  const module = await loadEngineModule()
  const focus = module.AgentFocus.fromParsedTrace(recording.parsedTrace)
  const formatter = new module.PerformanceInsightFormatter(focus, insight, 'ALL')
  return formatter.formatInsight()
}

/** 把原始 trace 事件序列化成 .json.gz 字节，供落盘归档（可被 DevTools 面板直接打开）。 */
export function serializeBrowserTraceToGzip(recording: BrowserParsedTraceRecording): Buffer {
  return gzipSync(JSON.stringify({ traceEvents: recording.rawEvents }))
}
