import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, type Stats, writeSync } from 'node:fs'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
import { isMissingFileError, resolveBrowserWorkspacePath } from '../../utils/workspace-paths'

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

    const pageSession = await this.kernel.getLivePageDriverSession(sessionId, abortSignal)
    abortSignal?.throwIfAborted()
    const driver = pageSession.driver
    if (!driver.captureHeapSnapshot) {
      throw new AppError('VALIDATION', '当前浏览器页面 driver 不支持堆快照。')
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const requestedPath = options.path?.trim() || `artifacts/memory/heap-${stamp}.heapsnapshot`
    const artifact = await resolveBrowserWorkspacePath(
      context.workspaceRoot,
      requestedPath,
      '堆快照路径'
    )
    abortSignal?.throwIfAborted()
    await mkdir(dirname(artifact.path), { recursive: true })
    const temporaryRelativePath = join(
      dirname(artifact.relativePath),
      `.velaros-heap-${randomUUID()}.tmp`
    )
    // mkdir 与取 driver 都可能让出执行权；打开独占文件前重新核对真实路径和取消。
    await resolveBrowserWorkspacePath(context.workspaceRoot, requestedPath, '堆快照路径')
    const temporary = await resolveBrowserWorkspacePath(
      context.workspaceRoot,
      temporaryRelativePath,
      '堆快照暂存路径'
    )
    abortSignal?.throwIfAborted()
    const descriptor = openSync(temporary.path, 'wx')
    let identity: Stats | undefined
    let acceptingChunks = true
    let bytes = 0
    let carry = ''
    let url = context.url
    const failures: unknown[] = []
    const recordCancellation = (): void => {
      if (abortSignal?.aborted) failures.push(abortSignal.reason)
    }
    const write = (text: string): void => {
      const buffer = Buffer.from(text, 'utf8')
      let offset = 0
      while (offset < buffer.byteLength) {
        const written = writeSync(descriptor, buffer, offset, buffer.byteLength - offset)
        if (written <= 0) throw new AppError('UNAVAILABLE', '堆快照暂存文件写入没有进展。')
        offset += written
        bytes += written
      }
    }
    const ownedTemporaryPath = async (): Promise<Nullable<string>> => {
      const verified = await resolveBrowserWorkspacePath(
        context.workspaceRoot,
        temporaryRelativePath,
        '堆快照暂存路径'
      )
      const current = await lstat(verified.literalPath).catch((error: unknown) => {
        if (isMissingFileError(error)) return null
        throw error
      })
      if (!current) return null
      if (
        !identity ||
        !current.isFile() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      ) {
        throw new AppError('CONFLICT', '堆快照暂存文件的所有权已变化，不能提交或删除。')
      }
      return verified.literalPath
    }
    try {
      identity = fstatSync(descriptor)
      abortSignal?.addEventListener('abort', recordCancellation, { once: true })
      recordCancellation()
      if (!failures.length) {
        try {
          await driver.captureHeapSnapshot((chunk) => {
            if (!acceptingChunks || failures.length) return
            try {
              abortSignal?.throwIfAborted()
              let text = carry + chunk
              carry = ''
              const last = text.charCodeAt(text.length - 1)
              // CDP chunk 可在 UTF-16 代理对之间切开；只暂存一个尾部高代理项。
              if (last >= 0xd800 && last <= 0xdbff) {
                carry = text.slice(-1)
                text = text.slice(0, -1)
              }
              write(text)
            } catch (error) {
              // sink 运行在 CDP 事件监听器里，不能直接抛出；后续 chunk 丢弃，物理采集仍须排空。
              failures.push(error)
            }
          })
        } catch (error) {
          failures.push(error)
        }
      }
      if (!failures.length) {
        abortSignal?.throwIfAborted()
        write(carry)
        url = driver.getURL() || context.url
      }
    } catch (error) {
      failures.push(error)
    } finally {
      acceptingChunks = false
      abortSignal?.removeEventListener('abort', recordCancellation)
      try {
        closeSync(descriptor)
      } catch (error) {
        failures.push(error)
      }
    }
    if (!failures.length) {
      try {
        abortSignal?.throwIfAborted()
        const source = await ownedTemporaryPath()
        if (!source) throw new AppError('NOT_FOUND', '堆快照暂存文件已不存在。')
        const target = await resolveBrowserWorkspacePath(
          context.workspaceRoot,
          requestedPath,
          '堆快照路径'
        )
        abortSignal?.throwIfAborted()
        await rename(source, target.path)
        return {
          url,
          path: target.path,
          relativePath: target.relativePath,
          bytes,
          capturedAt: Date.now(),
        }
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      const source = await ownedTemporaryPath()
      if (source) await rm(source)
    } catch (error) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    throw AppError.withFields(
      'EXECUTION_FAILED',
      '堆快照采集或保存失败，附带后续失败详情。',
      {
        failures,
      },
      failures[0]
    )
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
