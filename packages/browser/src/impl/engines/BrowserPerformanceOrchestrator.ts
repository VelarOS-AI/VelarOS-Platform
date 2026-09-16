import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { isEmpty, isFiniteNumber, isNull, isPresent, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { BrowserHeapSnapshotOptions, BrowserHeapSnapshotResult, BrowserPerformanceInsightOptions, BrowserPerformanceInsightResult, BrowserPerformanceTraceStartOptions, BrowserPerformanceTraceStartResult, BrowserPerformanceTraceStopResult, BrowserSiteContext } from '../../types/browser.js'
import type { BrowserPageDriverEmulationState } from '../../types/driver'
import type { BrowserPageDriverKernel,BrowserPerformanceTraceState } from '../../types/runtime.js'
import { serializeBrowserTraceToGzip } from '../../utils/performance'
import { BrowserTuning } from '../../utils/tuning'
import { resolveBrowserWorkspacePath } from '../../utils/workspace-paths'

import { BrowserPerformanceTraceEngine } from './BrowserPerformanceTraceEngine'

/**
 * 性能域执行体：trace 录制/分析与堆快照。
 *
 * 方法默认在 runtime 的 actionQueue 内被调用（analyzeInsight 除外，纯内存读）。
 */
export interface BrowserPerformanceOrchestratorApi {
  /** 开始录性能 trace。 */
  startTrace(sessionId: string, context: BrowserSiteContext, options: BrowserPerformanceTraceStartOptions, abortSignal?: AbortSignal): Promise<BrowserPerformanceTraceStartResult>
  /** 停止 + 解析 + 落盘。 */
  stopTrace(sessionId: string, context: BrowserSiteContext, abortSignal?: AbortSignal): Promise<BrowserPerformanceTraceStopResult>
  /** 对最近一次 trace 的指定 insight 输出详细分析（纯内存读，不进队列）。 */
  analyzeInsight(sessionId: string, options: BrowserPerformanceInsightOptions, abortSignal?: AbortSignal): Promise<BrowserPerformanceInsightResult>
  /** 采集 V8 堆快照并落盘（分析建议交给 memlab 等外部工具）。 */
  captureHeapSnapshot(sessionId: string, context: BrowserSiteContext, options: BrowserHeapSnapshotOptions, abortSignal?: AbortSignal): Promise<BrowserHeapSnapshotResult>
  /** 应用退出/运行时重建时清理登记表；录制中的 collector 随 driver/webContents 销毁而终止。 */
  dispose(): void
}

export class BrowserPerformanceOrchestrator implements BrowserPerformanceOrchestratorApi {
  private readonly traces = new Map<string, BrowserPerformanceTraceState>()

  constructor(
    private readonly kernel: BrowserPageDriverKernel,
    private readonly traceEngine = new BrowserPerformanceTraceEngine()
  ) {}

  public async startTrace(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPerformanceTraceStartOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserPerformanceTraceStartResult> {
    abortSignal?.throwIfAborted()
    const existing = this.traces.get(sessionId)
    if (existing?.running) {
      throw new AppError('VALIDATION', '性能 trace 已在录制中，请先 stop_trace。')
    }

    const reload = options.reload ?? true
    const autoStopMs = this.resolveAutoStopMs(options.autoStopMs)
    const pageSession = await this.kernel.getLivePageDriverSession(sessionId, abortSignal)
    const { driver } = pageSession
    if (!driver.startTracing || !driver.stopTracing) {
      throw new AppError('VALIDATION', '当前浏览器页面 driver 不支持性能 trace。')
    }

    const pageState = await this.kernel.refreshPageDriverSessionState(
      sessionId,
      pageSession,
      context.url
    )
    const originUrl = pageState.url || context.url
    if (reload) {
      await driver.navigateTo('about:blank')
    }
    await driver.startTracing()
    this.traces.set(sessionId, {
      running: true,
      startedAt: Date.now(),
      url: originUrl,
    })

    if (reload) {
      try {
        await driver.navigateTo(originUrl)
        await driver
          .waitForNetworkIdle?.({
            idleMs: BrowserTuning.performance.reloadNetworkIdleMs,
            timeoutMs: BrowserTuning.performance.reloadNetworkIdleTimeoutMs,
          })
          ?.catch(() => {
            // arch-guard:silent-catch-ok 网络空闲等待是 trace 质量提示，不改变导航已经成功的事实。
          })
      } catch (error) {
        // 回跳失败时终止录制，避免 trace 状态悬挂。
        this.traces.delete(sessionId)
        await driver.stopTracing().catch(() => {
          // arch-guard:silent-catch-ok 停止失败不能覆盖上方导航错误；trace 状态已从本地表移除。
        })
        throw error
      }
    }

    if (autoStopMs > 0) {
      await this.kernel.delay(autoStopMs)
      abortSignal?.throwIfAborted()
      const stopped = await this.stopTrace(sessionId, context, abortSignal)
      return { status: 'completed' as const, ...stopped }
    }

    const state = this.traces.get(sessionId)!
    return {
      status: 'recording' as const,
      url: state.url,
      startedAt: state.startedAt,
      note: '录制中：执行需要分析的页面操作，然后调用 stop_trace 结束并获取分析结果。',
    }
  }

  /** 停止 + 解析 + 落盘。 */
  public async stopTrace(
    sessionId: string,
    context: BrowserSiteContext,
    abortSignal?: AbortSignal
  ): Promise<BrowserPerformanceTraceStopResult> {
    abortSignal?.throwIfAborted()
    const state = this.traces.get(sessionId)
    if (!state?.running) {
      throw new AppError('VALIDATION', '当前没有正在录制的性能 trace。')
    }

    const pageSession = await this.kernel.getLivePageDriverSession(sessionId, abortSignal)
    if (!pageSession.driver.stopTracing) {
      this.traces.delete(sessionId)
      throw new AppError('EXECUTION_FAILED', '浏览器页面连接已断开，trace 录制丢失。')
    }
    const events = await pageSession.driver.stopTracing()
    const emulation: Nullable<BrowserPageDriverEmulationState> = toNullable(
      pageSession.driver.getEmulationState?.()
    )

    const recording = await this.traceEngine.parse(events, {
      cpuThrottling: emulation?.cpuThrottlingRate,
      networkThrottling:
        emulation && emulation.networkThrottling !== 'none'
          ? emulation.networkThrottling
          : undefined,
    })

    // 原始 trace 落盘：可直接拖进 DevTools Performance 面板复查。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const relativePath = `artifacts/performance/trace-${stamp}.json.gz`
    const resolvedRoot = resolve(context.workspaceRoot)
    const tracePath = resolve(resolvedRoot, relativePath)
    await mkdir(dirname(tracePath), { recursive: true })
    await writeFile(tracePath, serializeBrowserTraceToGzip(recording))

    const summary = await this.traceEngine.formatSummary(recording)
    const durationMs = Date.now() - state.startedAt
    this.traces.set(sessionId, {
      ...state,
      running: false,
      recording,
    })

    return {
      url: state.url,
      keyMetrics: extractKeyMetricsFromSummary(summary),
      summary,
      insightSetIds: recording.insightSetIds,
      rawTracePath: tracePath,
      rawTraceRelativePath: relativePath,
      durationMs,
      capturedAt: Date.now(),
    }
  }

  /** 对最近一次 trace 的指定 insight 输出详细分析（纯内存读，不进队列）。 */
  public async analyzeInsight(
    sessionId: string,
    options: BrowserPerformanceInsightOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserPerformanceInsightResult> {
    abortSignal?.throwIfAborted()
    const state = this.traces.get(sessionId)
    if (!state?.recording) {
      throw new AppError(
        'VALIDATION',
        '当前会话还没有已完成的性能 trace，请先 start_trace 录制。'
      )
    }

    const output = await this.traceEngine.formatInsight(
      state.recording,
      options.insightSetId,
      options.insightName
    )
    return {
      insightSetId: options.insightSetId,
      insightName: options.insightName,
      output,
      capturedAt: Date.now(),
    }
  }

  /** 采集 V8 堆快照并落盘（分析建议交给 memlab 等外部工具）。 */
  public async captureHeapSnapshot(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserHeapSnapshotOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserHeapSnapshotResult> {
    abortSignal?.throwIfAborted()

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const artifact = await resolveBrowserWorkspacePath(
      context.workspaceRoot,
      options.path?.trim() || `artifacts/memory/heap-${stamp}.heapsnapshot`,
      '堆快照路径'
    )
    const { path: resolvedPath, relativePath } = artifact
    await mkdir(dirname(resolvedPath), { recursive: true })

    const chunks: string[] = []
    const sink = (chunk: string): void => {
      chunks.push(chunk)
    }

    const pageSession = await this.kernel.getLivePageDriverSession(sessionId, abortSignal)
    if (!pageSession.driver.captureHeapSnapshot) {
      throw new AppError('VALIDATION', '当前浏览器页面 driver 不支持堆快照。')
    }
    await pageSession.driver.captureHeapSnapshot(sink)
    const url = pageSession.driver.getURL() || context.url

    const payload = chunks.join('')
    await writeFile(resolvedPath, payload, 'utf8')

    return {
      url,
      path: resolvedPath,
      relativePath,
      bytes: Buffer.byteLength(payload),
      capturedAt: Date.now(),
    }
  }

  /** 应用退出/运行时重建时清理登记表；录制中的 collector 随 driver/webContents 销毁而终止。 */
  public dispose(): void {
    this.traces.clear()
  }

  private resolveAutoStopMs(value: LooseOptional<number>): number {
    if (isNull(value) || value === 0) return 0
    if (!isPresent(value)) return BrowserTuning.performance.traceAutoStopMs
    if (!isFiniteNumber(value) || value < 0) return BrowserTuning.performance.traceAutoStopMs
    return Math.min(60_000, Math.max(1_000, Math.round(value)))
  }
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
      if (suffix.startsWith('event:') || suffix.startsWith('nodeId:') || suffix.startsWith('bounds:')) {
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
