/** 工具层与它们背后的执行类用到的工作类型：入参过滤、回执形状、会话内的门控状态。 */

/** 一个站点在本次会话里的登录门控状态；`origin` 解析失败时退化为整串 URL。 */
import type { ToolCapabilitySchema,ToolPermission } from '@velaros-ai/agent/protocol'
import type { DefineToolRuntimeSpecInput } from '@velaros-ai/agent/tool-contract'

import type { BrowserToolContext } from '../contract/requires.js'

import type {BrowserElementTargetHint,BrowserEmulationOptions, BrowserNetworkControlOptions, BrowserObservedActionKind, BrowserObservedActionSource, BrowserPageDiagnosticEntry, BrowserPageDiagnosticLevel, BrowserPageDiagnostics, BrowserPageDiagnosticsSummary, BrowserPageNavigationOptions, BrowserPageScrollOptions, BrowserPageWaitOptions, BrowserPageZoomOptions, BrowserPendingEventKind, BrowserPendingEventsResult, BrowserPendingEventSummary, BrowserPressKeyOptions, BrowserTargetActionKind, BrowserTargetActionValue, BrowserWorkspaceArtifactFormat, BrowserWorkspaceArtifactKind } from './browser.js'
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

/** 浏览器工具的能力标注里多带的一格：这个工具是在看页面、动页面，还是读写站点产物。 */
export type BrowserCapabilityAccess = 'observe' | 'control' | 'artifact'

/** 浏览器工具能力标注的 metadata：在通用字段之外多带 browserAccess。 */
export type BrowserCapabilityMetadata = Readonly<{
  browserAccess: BrowserCapabilityAccess
  canMutateProject?: boolean
}> & Readonly<Record<string, unknown>>

/** 浏览器工具的能力标注：通用形状加上上面那格 metadata。 */
export type BrowserToolCapabilitySchema = Omit<ToolCapabilitySchema, 'metadata'> & {
  metadata: BrowserCapabilityMetadata
}

/** browser:act 与 recipe 步骤定位元素用的提示：ref、css、text、name、attributes 至少给一项。 */
export interface BrowserTargetHintInput {
  ref?: LooseOptional<string>
  css?: LooseOptional<string>
  role?: LooseOptional<string>
  text?: LooseOptional<string>
  name?: LooseOptional<string>
  frame?: {
    css?: LooseOptional<string>
    name?: LooseOptional<string>
    title?: LooseOptional<string>
    url?: LooseOptional<string>
  }
  attributes?: Record<string, string>
}

/** browser:act 校验并收敛之后的入参：17 个动作各自只保留自己那几个字段。 */
export type ParsedBrowserActInput =
  | {
      action: 'target'
      targetAction: BrowserTargetActionKind
      target: BrowserTargetHintInput
      value?: BrowserTargetActionValue
      waitForNavigation?: boolean
    }
  | {
      action: 'navigate'
      navigationAction: BrowserPageNavigationOptions['action']
      url?: string
    }
  | {
      action: 'scroll'
      direction?: BrowserPageScrollOptions['direction']
      amount?: number
      x?: number
      y?: number
    }
  | { action: 'type'; text: string }
  | {
      action: 'press_key'
      key: string
      modifiers?: BrowserPressKeyOptions['modifiers']
      repeat?: number
      waitForNavigation?: boolean
    }
  | { action: 'move_mouse'; x: number; y: number }
  | {
      action: 'click_coordinates'
      x: number
      y: number
      button?: 'left' | 'middle' | 'right'
      clickCount?: number
      waitForNavigation?: boolean
    }
  | {
      action: 'drag'
      source: BrowserTargetHintInput
      target: BrowserTargetHintInput
      steps?: number
      waitForNavigation?: boolean
    }
  | {
      action: 'wait_for_selector'
      selector: string
      state?: 'attached' | 'visible' | 'hidden' | 'detached'
      visible?: boolean
      timeoutMs?: number
    }
  | {
      action: 'wait_for_url'
      urlPattern: string
      timeoutMs?: number
    }
  | {
      action: 'wait_for_function'
      expression: string
      timeoutMs?: number
    }
  | {
      action: 'wait_for_text'
      text: string
      timeoutMs?: number
    }
  | {
      action: 'wait'
      durationMs?: number
      loadState?: BrowserPageWaitOptions['loadState']
      timeoutMs?: number
    }
  | { action: 'set_viewport'; width: number; height: number }
  | {
      action: 'set_page_zoom'
      zoomAction: BrowserPageZoomOptions['action']
      zoomFactor?: number
      step?: number
    }
  | {
      action: 'configure_network'
      offline?: BrowserNetworkControlOptions['offline']
      extraHTTPHeaders?: BrowserNetworkControlOptions['extraHTTPHeaders']
      blockedURLPatterns?: BrowserNetworkControlOptions['blockedURLPatterns']
      blockedResourceTypes?: BrowserNetworkControlOptions['blockedResourceTypes']
      mockResponses?: BrowserNetworkControlOptions['mockResponses']
    }
  | {
      action: 'configure_emulation'
      colorScheme?: BrowserEmulationOptions['colorScheme']
      reducedMotion?: BrowserEmulationOptions['reducedMotion']
      timezoneId?: BrowserEmulationOptions['timezoneId']
      locale?: BrowserEmulationOptions['locale']
      geolocation?: BrowserEmulationOptions['geolocation']
      cpuThrottlingRate?: BrowserEmulationOptions['cpuThrottlingRate']
      networkThrottling?: BrowserEmulationOptions['networkThrottling']
    }


/** 一次读诊断只看哪一类；`all` 是不过滤。 */
export type BrowserPageDiagnosticsReadKind = 'all' | 'console' | 'network' | 'page_error'

/**
 * browser:get_page_diagnostics 的入参：按种类读最近的诊断事件，可选择读完清这一类的缓存。
 *
 * 过滤在取窗口之前做，`limit` 数的是过滤之后的条数——反过来的话，一个 console 刷屏的页面
 * 读网络事件会一条都读不到，而失败的请求就在更早的诊断里。
 */
export type BrowserGetPageDiagnosticsInput = {
  kind?: BrowserPageDiagnosticsReadKind
  limit: number
  clear?: boolean
  level?: BrowserPageDiagnosticLevel
  errorsOnly?: boolean
  status?: number
  resourceType?: string
  failedOnly?: boolean
}

/** 一次读诊断的回执：按 kind 给整份诊断、console、网络或页面异常四种形状之一。 */
export type BrowserPageDiagnosticsReadResult =
  | BrowserPageDiagnostics
  | BrowserConsoleEventsResult
  | BrowserNetworkEventsResult
  | BrowserPageErrorsResult

/** browser:query_elements 的入参。 */
export type BrowserQueryElementsInput = {
  selector: string
  attributes?: string[]
  includeHtml?: boolean
  limit: number
  maxTextChars?: number
  maxHtmlChars?: number
}

/** browser:get_network_request 的入参。 */
export type BrowserGetNetworkRequestInput = {
  requestId: string
  includeResponseBody?: boolean
  maxBodyChars?: number
}

/** browser:get_network_response_body 的入参。 */
export type BrowserGetNetworkResponseBodyInput = {
  requestId: string
  maxChars?: number
}

/** browser:read_page_storage 的入参。 */
export type BrowserReadPageStorageInput = {
  includeLocalStorage?: boolean
  includeSessionStorage?: boolean
  includeCookies?: boolean
  storageScope?: 'current-origin' | 'all-origins'
  cookieScope?: 'current-url' | 'all'
  limit: number
  maxValueChars?: number
}

/** browser:read_page_data 的入参：十四个只读预设各取所需。 */
export type BrowserReadPageDataInput = {
  preset:
    | 'title'
    | 'url'
    | 'body_text'
    | 'selector_text'
    | 'selector_attribute'
    | 'selector_count'
    | 'selector_visible'
    | 'selector_value'
    | 'selector_enabled'
    | 'selector_checked'
    | 'selector_box'
    | 'selector_styles'
    | 'json_ld'
    | 'media_sources'
  selector?: string
  attribute?: string
  limit?: number
  maxChars?: number
}

/** browser:evaluate_script 的入参。 */
export type BrowserEvaluateScriptInput = {
  script: string
  mode?: 'expression' | 'function-body'
  timeoutMs?: number
  maxResultChars?: number
}
