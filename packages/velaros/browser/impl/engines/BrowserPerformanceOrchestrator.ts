import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { AppError } from '@velaros-ai/core/error'
import { Log } from '@velaros-ai/core/logger'

import type {
  BrowserHeapSnapshotOptions,
  BrowserHeapSnapshotResult,
  BrowserPerformanceInsightOptions,
  BrowserPerformanceInsightResult,
  BrowserPerformanceTraceStartOptions,
  BrowserPerformanceTraceStartResult,
  BrowserPerformanceTraceStopResult,
  BrowserSiteContext,
} from '../../types/browser.js'
import type { BrowserPageDriverKernel, BrowserPerformanceTraceState } from '../../types/runtime.js'
import { extractKeyMetricsFromSummary, serializeBrowserTraceToGzip } from '../../utils/performance'
import { resolveAutoStopMs } from '../../utils/performance'
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
  startTrace(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserPerformanceTraceStartOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserPerformanceTraceStartResult>
  /** 停止 + 解析 + 落盘。 */
  stopTrace(
    sessionId: string,
    context: BrowserSiteContext,
    abortSignal?: AbortSignal
  ): Promise<BrowserPerformanceTraceStopResult>
  /** 对最近一次 trace 的指定 insight 输出详细分析（纯内存读，不进队列）。 */
  analyzeInsight(
    sessionId: string,
    options: BrowserPerformanceInsightOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserPerformanceInsightResult>
  /** 采集 V8 堆快照并落盘（分析建议交给 memlab 等外部工具）。 */
  captureHeapSnapshot(
    sessionId: string,
    context: BrowserSiteContext,
    options: BrowserHeapSnapshotOptions,
    abortSignal?: AbortSignal
  ): Promise<BrowserHeapSnapshotResult>
  /** 应用退出/运行时重建时清理登记表；录制中的 collector 随 driver/webContents 销毁而终止。 */
  dispose(): void
  /** 会话关闭时撤销 trace 登记并停止它自己的采集器。 */
  closeSession(sessionId: string): Promise<void>
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
    const state: BrowserPerformanceTraceState = {
      driver: null,
      running: true,
      startedAt: Date.now(),
      url: context.url,
    }
    this.traces.set(sessionId, state)
    try {
      const reload = options.reload ?? true
      const autoStopMs = resolveAutoStopMs(options.autoStopMs)
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
      abortSignal?.throwIfAborted()
      if (this.traces.get(sessionId) !== state)
        throw new AppError('CLOSED', '性能采集启动期间会话已关闭。')
      if (reload) {
        await driver.navigateTo('about:blank')
      }
      state.driver = driver
      await driver.startTracing()
      if (this.traces.get(sessionId) !== state) {
        await driver.stopTracing()
        throw new AppError('CLOSED', '性能采集启动期间会话已关闭。')
      }
      state.startedAt = Date.now()
      state.url = originUrl

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
        await this.kernel.delay(autoStopMs, abortSignal)
        abortSignal?.throwIfAborted()
        const stopped = await this.stopTrace(sessionId, context, abortSignal)
        return { status: 'completed' as const, ...stopped }
      }

      return {
        status: 'recording' as const,
        url: state.url,
        startedAt: state.startedAt,
        note: '录制中：执行需要分析的页面操作，然后调用 stop_trace 结束并获取分析结果。',
      }
    } catch (error) {
      if (this.traces.get(sessionId) === state) await this.closeSession(sessionId)
      throw error
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

    const driver = state.driver
    if (!driver?.stopTracing) {
      this.traces.delete(sessionId)
      throw new AppError('EXECUTION_FAILED', '浏览器页面连接已断开，trace 录制丢失。')
    }
    // stopTracing 无论成功失败都会释放 driver 的 collector；之后的解析/落盘失败也不能留下仍在录制的影子状态。
    state.running = false
    try {
      const events = await driver.stopTracing()
      const recording = await this.traceEngine.parse(events)
      if (this.traces.get(sessionId) !== state)
        throw new AppError('CLOSED', '性能采集处理期间会话已关闭。')

      // 原始 trace 落盘：可直接拖进 DevTools Performance 面板复查。
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const relativePath = `artifacts/performance/trace-${stamp}.json.gz`
      const { path: tracePath } = await resolveBrowserWorkspacePath(
        context.workspaceRoot,
        relativePath,
        '性能 trace 路径'
      )
      await mkdir(dirname(tracePath), { recursive: true })
      await writeFile(tracePath, serializeBrowserTraceToGzip(recording))

      const summary = await this.traceEngine.formatSummary(recording)
      const durationMs = Date.now() - state.startedAt
      if (this.traces.get(sessionId) !== state)
        throw new AppError('CLOSED', '性能采集处理期间会话已关闭。')
      state.recording = recording

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
    } catch (error) {
      if (this.traces.get(sessionId) === state) this.traces.delete(sessionId)
      throw error
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
      throw new AppError('VALIDATION', '当前会话还没有已完成的性能 trace，请先 start_trace 录制。')
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

  /** 应用退出或运行时重建时撤销全部登记并停止实际采集器。 */
  public dispose(): void {
    for (const sessionId of [...this.traces.keys()]) void this.closeSession(sessionId)
  }

  public async closeSession(sessionId: string): Promise<void> {
    const state = this.traces.get(sessionId)
    this.traces.delete(sessionId)
    if (!state?.running || !state.driver?.stopTracing) return
    state.running = false
    try {
      await state.driver.stopTracing()
    } catch (error) {
      // 会话拆卸仍须继续，采集器的 finally 负责撤销订阅。
      Log.tag('BrowserPerformanceOrchestrator').debug('关闭会话时停止性能采集失败', {
        sessionId,
        error: AppError.from(error).message,
      })
    }
  }
}
