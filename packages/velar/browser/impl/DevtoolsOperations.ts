/**
 * 开发者工具能力（`velar:devtools`）的操作：`DevtoolsOperations` 与整个进程唯一的 `devtoolsOperations`。接口 `DevtoolsOperationsApi` 在本文件的类上方。
 * 与 `velar:browser` 共用同一个空间端口 `BrowserSpacePort`：排障、调页面时才 import，驱动页面的声明因此保持小。
 */

import { BrowserDiagnosticsLimits, BrowserPageDataLimits } from '../contract/constants.js'
import type { BrowserOperationContext } from '../contract/requires.js'
import type {
  BrowserEmulationResult,
  BrowserHeapSnapshotResult,
  BrowserNetworkControlResult,
  BrowserNetworkRequestDetailsResult,
  BrowserPageDiagnosticKind,
  BrowserPageDiagnosticsReadKind,
  BrowserPageDiagnosticsReadResult,
  BrowserPageStorageResult,
  BrowserPageZoomResult,
  BrowserPerformanceInsightResult,
  BrowserPerformanceTraceStartResult,
  BrowserPerformanceTraceStopResult,
  BrowserScreencastStartResult,
  BrowserScreencastStopResult,
  BrowserUserScriptMutationResult,
  BrowserViewportResult,
  DevtoolsCreateUserScriptInput,
  DevtoolsDiagnosticsInput,
  DevtoolsEmulateInput,
  DevtoolsEnableUserScriptInput,
  DevtoolsEnableUserScriptsInput,
  DevtoolsHeapSnapshotInput,
  DevtoolsInsightInput,
  DevtoolsMoveUserScriptInput,
  DevtoolsNetworkInput,
  DevtoolsRecordingInput,
  DevtoolsRequestInput,
  DevtoolsStopRecordingInput,
  DevtoolsStorageInput,
  DevtoolsTraceInput,
  DevtoolsUpdateUserScriptInput,
  DevtoolsUserScriptIdInput,
  DevtoolsViewportInput,
  DevtoolsZoomInput,
} from '../types/browser.js'
import {
  buildBrowserConsoleEventsResult,
  buildBrowserNetworkEventsResult,
  buildBrowserPageErrorsResult,
} from '../utils/diagnostics.js'
import {
  createUserScriptInput,
  diagnosticsInput,
  emulateInput,
  enableUserScriptInput,
  enableUserScriptsInput,
  heapSnapshotInput,
  insightInput,
  moveUserScriptInput,
  networkInput,
  recordingInput,
  requestInput,
  stopRecordingInput,
  storageInput,
  traceInput,
  updateUserScriptInput,
  userScriptIdInput,
  viewportInput,
  zoomInput,
} from '../utils/input.js'
import { requireOpenSite } from '../utils/site.js'

/**
 * @AgentView
 * 开发者工具：读控制台、网络与未处理异常，读一次请求的详情与响应体，读页面存储；改视口、缩放、网络条件与环境仿真；
 * 录性能 trace 看 LCP、INP、CLS 与瓶颈，采堆快照查内存泄漏；录屏合成 GIF；管理进到匹配网站时自动注入的用户脚本。
 * 都作用在 velar:browser 当前打开的站点上，没进站点时抛 BROWSER_SITE_NOT_OPEN。trace、堆快照、录屏的产物落在站点工作区。
 */
export interface DevtoolsOperationsApi {
  /** @AgentView 读诊断：先按种类过滤再取最近的几条，网络条目带 requestId。 */
  diagnostics(input: DevtoolsDiagnosticsInput, ctx: BrowserOperationContext): Promise<BrowserPageDiagnosticsReadResult>
  /** @AgentView 读一次网络请求的请求头、postData、响应头、耗时与体积，可带响应体；较早的请求可能已经读不到。 */
  request(input: DevtoolsRequestInput, ctx: BrowserOperationContext): Promise<BrowserNetworkRequestDetailsResult>
  /** @AgentView 读页面的 localStorage、sessionStorage 与 cookie。 */
  storage(input: DevtoolsStorageInput, ctx: BrowserOperationContext): Promise<BrowserPageStorageResult>
  /** @AgentView 把视口设成指定尺寸。 */
  setViewport(input: DevtoolsViewportInput, ctx: BrowserOperationContext): Promise<BrowserViewportResult>
  /** @AgentView 调页面缩放。 */
  zoom(input: DevtoolsZoomInput, ctx: BrowserOperationContext): Promise<BrowserPageZoomResult>
  /** @AgentView 设网络条件：断网、加请求头、拦请求、给请求回假响应。 */
  network(input: DevtoolsNetworkInput, ctx: BrowserOperationContext): Promise<BrowserNetworkControlResult>
  /** @AgentView 仿真环境：深浅色、减少动效、时区、语言、地理位置、CPU 与网络节流。 */
  emulate(input: DevtoolsEmulateInput, ctx: BrowserOperationContext): Promise<BrowserEmulationResult>
  /** @AgentView 开始录性能 trace；到点自动停时直接交回分析摘要。 */
  startTrace(input: DevtoolsTraceInput, ctx: BrowserOperationContext): Promise<BrowserPerformanceTraceStartResult>
  /** @AgentView 停止录 trace，交回 Core Web Vitals 与可深入分析的 insight 清单；原始 trace 落在站点工作区。 */
  stopTrace(ctx: BrowserOperationContext): Promise<BrowserPerformanceTraceStopResult>
  /** @AgentView 对最近一次 trace 的一条 insight 出详细分析。 */
  insight(input: DevtoolsInsightInput, ctx: BrowserOperationContext): Promise<BrowserPerformanceInsightResult>
  /** @AgentView 采一份 V8 堆快照落盘（按「基线、操作、回退」各采一份对比着查泄漏）。 */
  heapSnapshot(input: DevtoolsHeapSnapshotInput, ctx: BrowserOperationContext): Promise<BrowserHeapSnapshotResult>
  /** @AgentView 开始录屏：之后的页面操作都录下来，stopRecording 合成 GIF。 */
  startRecording(input: DevtoolsRecordingInput, ctx: BrowserOperationContext): Promise<BrowserScreencastStartResult>
  /** @AgentView 停止录屏并合成 GIF 落进站点工作区（帧数到上限会自动截断，frameLimitReached 为真）。 */
  stopRecording(input: DevtoolsStopRecordingInput, ctx: BrowserOperationContext): Promise<BrowserScreencastStopResult>
  /** @AgentView 列出全部用户脚本、总开关，以及哪些脚本匹配当前页面。 */
  userScripts(ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult>
  /** @AgentView 读一个用户脚本，带源码。 */
  readUserScript(input: DevtoolsUserScriptIdInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult>
  /** @AgentView 新建一个用户脚本（一律先停用）。 */
  createUserScript(input: DevtoolsCreateUserScriptInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult>
  /** @AgentView 改一个用户脚本。 */
  updateUserScript(input: DevtoolsUpdateUserScriptInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult>
  /** @AgentView 启用或停用一个用户脚本。 */
  enableUserScript(input: DevtoolsEnableUserScriptInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult>
  /** @AgentView 打开或关闭用户脚本的总开关。 */
  enableUserScripts(input: DevtoolsEnableUserScriptsInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult>
  /** @AgentView 调整一个用户脚本的注入顺序。 */
  moveUserScript(input: DevtoolsMoveUserScriptInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult>
  /** @AgentView 删掉一个用户脚本（不撤销当前页面已经执行的副作用）。 */
  deleteUserScript(input: DevtoolsUserScriptIdInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult>
  /** @AgentView 在当前页面立刻跑一次某个用户脚本。 */
  runUserScript(input: DevtoolsUserScriptIdInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult>
}

/**
 * 顺序是固定的：先查取消、再核对入参、再确认进了站点、最后经端口做事。trace 的录制与解析、GIF 的合成、用户脚本的存储都在宿主那一侧，
 * 这里只核对与分派。整个进程共用一份，无状态。
 */
export class DevtoolsOperations implements DevtoolsOperationsApi {
  /** 读诊断的种类 → 诊断缓冲里的种类名；all 不过滤。 */
  private static readonly DiagnosticKinds: Record<BrowserPageDiagnosticsReadKind, Optional<readonly BrowserPageDiagnosticKind[]>> = {
    all: undefined,
    console: ['console'],
    network: ['network'],
    page_error: ['page-error'],
  }

  public async diagnostics(input: DevtoolsDiagnosticsInput, ctx: BrowserOperationContext): Promise<BrowserPageDiagnosticsReadResult> {
    ctx.abortSignal.throwIfAborted()
    const options = diagnosticsInput(input)
    requireOpenSite(ctx)
    const diagnostics = await ctx.browser.getPageDiagnostics({
      limit: options.limit ?? BrowserDiagnosticsLimits.entries,
      kinds: DevtoolsOperations.DiagnosticKinds[options.kind ?? 'all'],
      clear: options.clear,
    })
    switch (options.kind) {
      case 'console':
        return buildBrowserConsoleEventsResult(diagnostics, options)
      case 'network':
        return buildBrowserNetworkEventsResult(diagnostics, options)
      case 'page_error':
        return buildBrowserPageErrorsResult(diagnostics)
      default:
        return diagnostics
    }
  }

  public async request(input: DevtoolsRequestInput, ctx: BrowserOperationContext): Promise<BrowserNetworkRequestDetailsResult> {
    ctx.abortSignal.throwIfAborted()
    const options = requestInput(input)
    requireOpenSite(ctx)
    return ctx.browser.readNetworkRequestDetails({
      requestId: options.requestId,
      includeResponseBody: options.includeResponseBody,
      maxBodyChars: options.maxBodyChars ?? BrowserDiagnosticsLimits.responseBodyChars,
    })
  }

  public async storage(input: DevtoolsStorageInput, ctx: BrowserOperationContext): Promise<BrowserPageStorageResult> {
    ctx.abortSignal.throwIfAborted()
    const options = storageInput(input)
    requireOpenSite(ctx)
    return ctx.browser.readPageStorage({
      ...options,
      limit: options.limit ?? BrowserPageDataLimits.storageItems,
      maxValueChars: options.maxValueChars ?? BrowserPageDataLimits.storageValueChars,
    })
  }

  public async setViewport(input: DevtoolsViewportInput, ctx: BrowserOperationContext): Promise<BrowserViewportResult> {
    ctx.abortSignal.throwIfAborted()
    const options = viewportInput(input)
    requireOpenSite(ctx)
    return ctx.browser.setViewport(options)
  }

  public async zoom(input: DevtoolsZoomInput, ctx: BrowserOperationContext): Promise<BrowserPageZoomResult> {
    ctx.abortSignal.throwIfAborted()
    const options = zoomInput(input)
    requireOpenSite(ctx)
    return ctx.browser.setPageZoom(options)
  }

  public async network(input: DevtoolsNetworkInput, ctx: BrowserOperationContext): Promise<BrowserNetworkControlResult> {
    ctx.abortSignal.throwIfAborted()
    const options = networkInput(input)
    requireOpenSite(ctx)
    return ctx.browser.configureNetwork(options)
  }

  public async emulate(input: DevtoolsEmulateInput, ctx: BrowserOperationContext): Promise<BrowserEmulationResult> {
    ctx.abortSignal.throwIfAborted()
    const options = emulateInput(input)
    requireOpenSite(ctx)
    return ctx.browser.configureEmulation(options)
  }

  public async startTrace(input: DevtoolsTraceInput, ctx: BrowserOperationContext): Promise<BrowserPerformanceTraceStartResult> {
    ctx.abortSignal.throwIfAborted()
    const options = traceInput(input)
    requireOpenSite(ctx)
    return ctx.browser.startPerformanceTrace(options)
  }

  public async stopTrace(ctx: BrowserOperationContext): Promise<BrowserPerformanceTraceStopResult> {
    ctx.abortSignal.throwIfAborted()
    requireOpenSite(ctx)
    return ctx.browser.stopPerformanceTrace()
  }

  public async insight(input: DevtoolsInsightInput, ctx: BrowserOperationContext): Promise<BrowserPerformanceInsightResult> {
    ctx.abortSignal.throwIfAborted()
    const options = insightInput(input)
    requireOpenSite(ctx)
    return ctx.browser.analyzePerformanceInsight(options)
  }

  public async heapSnapshot(input: DevtoolsHeapSnapshotInput, ctx: BrowserOperationContext): Promise<BrowserHeapSnapshotResult> {
    ctx.abortSignal.throwIfAborted()
    const options = heapSnapshotInput(input)
    requireOpenSite(ctx)
    return ctx.browser.captureHeapSnapshot(options)
  }

  public async startRecording(input: DevtoolsRecordingInput, ctx: BrowserOperationContext): Promise<BrowserScreencastStartResult> {
    ctx.abortSignal.throwIfAborted()
    const options = recordingInput(input)
    requireOpenSite(ctx)
    return ctx.browser.startScreencast(options)
  }

  public async stopRecording(input: DevtoolsStopRecordingInput, ctx: BrowserOperationContext): Promise<BrowserScreencastStopResult> {
    ctx.abortSignal.throwIfAborted()
    const options = stopRecordingInput(input)
    requireOpenSite(ctx)
    return ctx.browser.stopScreencast(options)
  }

  public async userScripts(ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult> {
    ctx.abortSignal.throwIfAborted()
    requireOpenSite(ctx)
    return ctx.browser.manageUserScripts({ action: 'list' })
  }

  public async readUserScript(input: DevtoolsUserScriptIdInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult> {
    ctx.abortSignal.throwIfAborted()
    const { id } = userScriptIdInput(input, 'readUserScript')
    requireOpenSite(ctx)
    return ctx.browser.manageUserScripts({ action: 'read', id })
  }

  public async createUserScript(input: DevtoolsCreateUserScriptInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult> {
    ctx.abortSignal.throwIfAborted()
    const script = createUserScriptInput(input)
    requireOpenSite(ctx)
    // 新建的脚本一律停用：启用要用户明确同意，由 enableUserScript 单独做。
    return ctx.browser.manageUserScripts({ action: 'create', script: { ...script, enabled: false, source: 'agent' } })
  }

  public async updateUserScript(input: DevtoolsUpdateUserScriptInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult> {
    ctx.abortSignal.throwIfAborted()
    const { id, ...patch } = updateUserScriptInput(input)
    requireOpenSite(ctx)
    return ctx.browser.manageUserScripts({ action: 'update', id, patch })
  }

  public async enableUserScript(input: DevtoolsEnableUserScriptInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult> {
    ctx.abortSignal.throwIfAborted()
    const { id, enabled } = enableUserScriptInput(input)
    requireOpenSite(ctx)
    return ctx.browser.manageUserScripts({ action: 'set_enabled', id, enabled })
  }

  public async enableUserScripts(input: DevtoolsEnableUserScriptsInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult> {
    ctx.abortSignal.throwIfAborted()
    const { enabled } = enableUserScriptsInput(input)
    requireOpenSite(ctx)
    return ctx.browser.manageUserScripts({ action: 'set_global_enabled', enabled })
  }

  public async moveUserScript(input: DevtoolsMoveUserScriptInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult> {
    ctx.abortSignal.throwIfAborted()
    const { id, direction } = moveUserScriptInput(input)
    requireOpenSite(ctx)
    return ctx.browser.manageUserScripts({ action: 'move', id, direction })
  }

  public async deleteUserScript(input: DevtoolsUserScriptIdInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult> {
    ctx.abortSignal.throwIfAborted()
    const { id } = userScriptIdInput(input, 'deleteUserScript')
    requireOpenSite(ctx)
    return ctx.browser.manageUserScripts({ action: 'delete', id })
  }

  public async runUserScript(input: DevtoolsUserScriptIdInput, ctx: BrowserOperationContext): Promise<BrowserUserScriptMutationResult> {
    ctx.abortSignal.throwIfAborted()
    const { id } = userScriptIdInput(input, 'runUserScript')
    requireOpenSite(ctx)
    return ctx.browser.manageUserScripts({ action: 'run_now', id })
  }
}

/** 整个进程只有一份的开发者工具操作；空间把它挂在代码面的 `devtools` 命名空间上。 */
export const devtoolsOperations: DevtoolsOperationsApi = new DevtoolsOperations()
