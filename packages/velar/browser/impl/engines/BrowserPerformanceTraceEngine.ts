import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Log } from '@velaros-ai/core/logger'

import type { BrowserParsedTraceRecording, BrowserTraceParseMetadata } from '../../types/runtime.js'
import { readBrowserTraceInsight } from '../../utils/performance'

import type * as DevtoolsPerformanceEngineModule from '#devtools-performance-engine'
import type {
  DevtoolsParsedTrace,
  DevtoolsTraceModel,
} from '#devtools-performance-engine'

/**
 * 性能 trace 解析引擎（吸收自 chrome-devtools-mcp 的 trace-processing/parse.ts，Apache-2.0）。
 *
 * 背后是 vendor 的 DevTools 官方 trace 引擎：负责把 CDP Tracing 采到的原始事件
 * 解析成 insights，并格式化成模型可读的摘要/insight 文本。
 * 引擎 ~2MB，首次调用时动态 import，避免拖慢主进程启动。
 */

type PerformanceEngineModule = typeof DevtoolsPerformanceEngineModule

const log = Log.tag('BrowserPerformanceTraceEngine')

/**
 * 性能 trace 解析引擎：把 CDP Tracing 采到的原始事件交给 vendor 的 DevTools 引擎，解析成 insights 并
 * 格式化成模型读得懂的摘要与单项分析。
 *
 * DevTools 的模型是有状态的：每次解析都会重置它的 processor，所以一个运行时持有一个实例，并在这里把解析串行化，
 * 免得两个会话解析到一半互相把对方的 processor 重置掉。vendor 引擎约 2 MB，首次用到时才动态加载。
 */
export interface BrowserPerformanceTraceEngineApi {
  /** 把原始 trace 事件交给 vendor 引擎解析成 insights。 */
  parse(events: unknown[], metadata?: BrowserTraceParseMetadata): Promise<BrowserParsedTraceRecording>
  /** 把解析结果格式化成整体摘要（含可用 insight 清单）。 */
  formatSummary(recording: BrowserParsedTraceRecording): Promise<string>
  /** 把某一个 insight 格式化成详细分析文本。 */
  formatInsight(recording: BrowserParsedTraceRecording, insightSetId: string, insightName: string): Promise<string>
}

export class BrowserPerformanceTraceEngine implements BrowserPerformanceTraceEngineApi {
  private engine: Nullable<DevtoolsTraceModel> = null
  private parseQueue: Promise<void> = Promise.resolve()
  /** vendor 引擎的懒加载句柄：一个运行时一份，不再挂在模块上。 */
  private engineModulePromise: Nullable<Promise<PerformanceEngineModule>> = null
  /** vendor 引擎的 i18n 只引导一次。 */
  private i18nBootstrapped = false

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
    const module = await this.loadEngineModule()
    const focus = module.AgentFocus.fromParsedTrace(recording.parsedTrace as DevtoolsParsedTrace)
    return new module.PerformanceTraceFormatter(focus, 'ALL').formatTraceSummary()
  }

  public async formatInsight(
    recording: BrowserParsedTraceRecording,
    insightSetId: string,
    insightName: string
  ): Promise<string> {
    const insight = readBrowserTraceInsight(recording, insightSetId, insightName)
    const module = await this.loadEngineModule()
    const focus = module.AgentFocus.fromParsedTrace(recording.parsedTrace as DevtoolsParsedTrace)
    return new module.PerformanceInsightFormatter(focus, insight, 'ALL').formatInsight()
  }

  /** 首次用到时才加载 vendor 引擎（约 2 MB），加载完顺手做一次 i18n 引导。 */
  private async loadEngineModule(): Promise<PerformanceEngineModule> {
    this.engineModulePromise ??= import(
      '#devtools-performance-engine'
    ).then((module) => {
      this.bootstrapEngineI18n(module)
      return module
    })
    return this.engineModulePromise
  }

  /**
   * i18n 引导（做法同 chrome-devtools-mcp 的 DevtoolsUtils）：
   * insight runner 依赖 i18nString，locale 未初始化时每个 runner 都会抛错
   * 并被引擎静默吞进 errors —— 表象是 insights.model 恒为空对象。
   */
  private bootstrapEngineI18n(module: PerformanceEngineModule): void {
    if (this.i18nBootstrapped) return
    module.I18n.DevToolsLocale.DevToolsLocale.instance({
      create: true,
      data: {
        navigatorLanguage: 'en-US',
        settingLanguage: 'en-US',
        lookupClosestDevToolsLocale: (locale) => locale,
      },
    })
    module.I18n.i18n.registerLocaleDataForTest('en-US', {})
    this.i18nBootstrapped = true
  }

  private async parseNow(
    events: unknown[],
    metadata: BrowserTraceParseMetadata
  ): Promise<BrowserParsedTraceRecording> {
    if (isEmpty(events)) {
      throw new AppError('EXECUTION_FAILED', '性能 trace 没有采集到任何事件。')
    }

    const module = await this.loadEngineModule()
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

