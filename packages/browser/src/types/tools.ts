/** 工具层与它们背后的执行类用到的工作类型：入参过滤、回执形状、会话内的门控状态。 */

/** 一个站点在本次会话里的登录门控状态；`origin` 解析失败时退化为整串 URL。 */
import type { ToolPermission } from '@velaros-ai/agent/protocol'
import type { DefineToolRuntimeSpecInput } from '@velaros-ai/agent/tool-contract'

import type { BrowserToolContext } from '../contract/requires.js'

import type {BrowserElementTargetHint, BrowserObservedActionKind, BrowserObservedActionSource, BrowserPageDiagnosticEntry, BrowserPageDiagnosticLevel, BrowserPageDiagnosticsSummary, BrowserPendingEventKind, BrowserPendingEventsResult, BrowserPendingEventSummary, BrowserWorkspaceArtifactFormat, BrowserWorkspaceArtifactKind } from './browser.js'
import type { BrowserTargetActionClickMode } from './runtime.js'

export interface BrowserTargetActionScriptBuildOptions {
  clickMode?: BrowserTargetActionClickMode
}

export interface CoordinateClickPoint {
  x: number
  y: number
}

export interface TargetActionEffectRecovery {
  source: 'target-action-effect'
  reason: 'no-observable-change'
  recommendedNextActions: Array<'inspect_page' | 'observe_actions'>
}

export interface BrowserPendingEventWaitOptions {
  kind?: BrowserPendingEventKind
  timeoutMs?: number
  abortSignal: AbortSignal
  listPendingEvents: () => Promise<BrowserPendingEventsResult>
}

export interface BrowserPendingEventWaitResult {
  matched: boolean
  timedOut: boolean
  kind: BrowserPendingEventKind
  event: Nullable<BrowserPendingEventSummary>
  pending: BrowserPendingEventSummary[]
  timeoutMs: number
  elapsedMs: number
  capturedAt: number
}

export interface BrowserPageContentBoundary {
  source: 'browser-page-content'
  origin: string
  nonce: string
  fields: ['content']
}

export interface ObserveActionDraft {
  method: BrowserObservedActionKind
  description: string
  source: BrowserObservedActionSource
  target: BrowserElementTargetHint
  twoStep: boolean
  priority: number
  requiresValue: boolean
  arguments: string[]
  searchableText: string
  index: number
}

export interface BrowserPageErrorsResult {
  url: string
  title: Nullable<string>
  entries: BrowserPageDiagnosticEntry[]
  summary: BrowserPageDiagnosticsSummary
  diagnosticTotal: number
  pageErrorTotal: number
  capturedAt: number
}

export interface BrowserNetworkEventFilters {
  status: Nullable<number>
  resourceType: Nullable<string>
  failedOnly: boolean
}

export interface BrowserNetworkEventsResult {
  url: string
  title: Nullable<string>
  entries: BrowserPageDiagnosticEntry[]
  summary: BrowserPageDiagnosticsSummary
  filters: BrowserNetworkEventFilters
  diagnosticTotal: number
  networkTotal: number
  /** 网络采集刚在这次调用建立时的说明（内嵌页面）；没有要说的就是 null。 */
  networkCaptureNotice: Nullable<string>
  capturedAt: number
}

export interface BrowserConsoleEventFilters {
  level: Nullable<BrowserPageDiagnosticLevel>
  errorsOnly: boolean
}

export interface BrowserConsoleEventsResult {
  url: string
  title: Nullable<string>
  entries: BrowserPageDiagnosticEntry[]
  summary: BrowserPageDiagnosticsSummary
  filters: BrowserConsoleEventFilters
  diagnosticTotal: number
  consoleTotal: number
  capturedAt: number
}

/** 页面提取脚本返回的载荷：页面侧构造的纯 JSON 对象。 */
export type BrowserExtractionPayload = Record<string, unknown>

export type BrowserPageContentFormat = 'plain' | 'markdown' | 'html'

/** 提取结果的落盘选项。 */
export interface BrowserExtractionSaveOptions {
  /** 是否把提取结果写入当前站点 extracts/。 */
  save: boolean
  /** 产物名称；省略时由 artifact manager 生成。 */
  name?: string
}

export interface BrowserTableExtractionInput extends BrowserExtractionSaveOptions {
  selector?: string
  tableIndex: number
  maxRows: number
}

export interface BrowserListExtractionInput extends BrowserExtractionSaveOptions {
  selector?: string
  maxItems: number
}

export interface BrowserPageContentExtractionInput extends BrowserExtractionSaveOptions {
  format: BrowserPageContentFormat
  selector?: string
  ignoreSelectors?: string[]
  maxChars: number
}

export type BrowserListFilesInput = {
  path?: string
  recursive?: boolean
  maxDepth?: number
  limit: number
}

export type BrowserReadFileInput = {
  path: string
  startLine?: number
  endLine?: number
  maxChars?: number
}

export type BrowserWriteFileInput = {
  path: string
  content: string
  overwrite?: boolean
}

export type BrowserListArtifactsInput = {
  kind?: BrowserWorkspaceArtifactKind
  limit: number
}

export type BrowserWriteArtifactInput = {
  kind: BrowserWorkspaceArtifactKind
  format: BrowserWorkspaceArtifactFormat
  content: string
  name?: string
  overwrite?: boolean
}

export type BrowserSavePageSnapshotInput = {
  name?: string
  includeHtml?: boolean
  maxTextChars?: number
  maxHtmlChars?: number
  overwrite?: boolean
}

export type DefineBrowserToolInput<TInput extends Record<string, unknown>> = Omit<
  DefineToolRuntimeSpecInput<TInput, BrowserToolContext, unknown, ToolPermission>,
  'category'
>

export type BrowserLoginGateOriginState = 'prompted' | 'approved' | 'declined'
