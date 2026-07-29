import {
  isBoolean,
isEmpty,
  isFiniteNumber,
  isNonBlankString,
  isNotNull,
  isObject,
  isPresent,
  isString,
  isTrue, toNullable, } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { type CdpSend, syncCdpNetworkConditions } from './BrowserCdpEmulation'
import type {
  BrowserPageDriverNetworkControlState,
  BrowserPageDriverNetworkIdleOptions,
  BrowserPageDriverNetworkRequestDetailsResult,
  BrowserPageDriverNetworkResponseBodyResult,
} from './BrowserPageDriver'
import type { BrowserNetworkControlOptions, BrowserNetworkMockResponse, BrowserNetworkRequestDetailsOptions, BrowserNetworkResponseBodyOptions, BrowserNetworkThrottlingPreset, BrowserPageDiagnosticEntry, BrowserPageDiagnosticLevel } from './types.js'

/**
 * CDP 网络子系统的共享控制器。
 *
 * 外部 CDP 浏览器(CdpBrowserPageDriver,WebSocket transport)与嵌入式 webview
 * (webContents.debugger)两条路径共用同一套网络事件记账 / 详情读取 / Fetch 拦截逻辑,只差
 * transport 与事件入口。控制器持有网络请求记录表、offline/headers/拦截规则等有状态数据,
 * 通过注入的 `send`/`appendDiagnostic`/`getCurrentUrl`/`getNetworkThrottling` 与宿主解耦。
 *
 * offline 与网络节流共用 Network.emulateNetworkConditions:offline 归本控制器,节流归 emulation
 * 状态(宿主持有),两者经 getNetworkThrottling 回调合流,避免互相覆盖。
 */

interface CdpNetworkRequestPayload {
  headers?: unknown
  method?: unknown
  postData?: unknown
  url?: unknown
}

interface CdpFetchRequestPausedEvent {
  requestId?: unknown
  resourceType?: unknown
  request?: unknown
}

interface CdpNetworkRequestWillBeSentEvent {
  requestId?: unknown
  type?: unknown
  request?: unknown
  timestamp?: unknown
  wallTime?: unknown
}

interface CdpNetworkResponsePayload {
  encodedDataLength?: unknown
  headers?: unknown
  protocol?: unknown
  remoteIPAddress?: unknown
  remotePort?: unknown
  url?: unknown
  status?: unknown
  statusText?: unknown
  mimeType?: unknown
  fromDiskCache?: unknown
  fromServiceWorker?: unknown
  timing?: unknown
}

interface CdpNetworkResponseReceivedEvent {
  requestId?: unknown
  type?: unknown
  response?: unknown
}

interface CdpNetworkLoadingFinishedEvent {
  requestId?: unknown
  encodedDataLength?: unknown
  timestamp?: unknown
}

interface CdpNetworkLoadingFailedEvent {
  requestId?: unknown
  type?: unknown
  errorText?: unknown
  canceled?: unknown
  timestamp?: unknown
}

interface CdpNetworkGetResponseBodyResponse {
  body?: unknown
  base64Encoded?: unknown
}

interface CdpNetworkRequestRecord {
  requestId: string
  method: string
  url: string
  headers: Record<string, string>
  postData: Nullable<string>
  resourceType: string
  timestamp: Nullable<number>
  wallTime: Nullable<number>
  response: Nullable<{
    status: number
    statusText: string
    headers: Record<string, string>
    mimeType: Nullable<string>
    protocol: Nullable<string>
    fromDiskCache: boolean
    fromServiceWorker: boolean
    encodedDataLength: Nullable<number>
    remoteIPAddress: Nullable<string>
    remotePort: Nullable<number>
    timing: Nullable<Record<string, unknown>>
  }>
  failure: Nullable<{
    errorText: string
    canceled: boolean
  }>
  finishedTimestamp: Nullable<number>
}

const CdpNetworkResourceTypeByKey: Record<string, string> = {
  cspviolationreport: 'CSPViolationReport',
  document: 'Document',
  eventsource: 'EventSource',
  fetch: 'Fetch',
  font: 'Font',
  image: 'Image',
  manifest: 'Manifest',
  media: 'Media',
  other: 'Other',
  ping: 'Ping',
  preflight: 'Preflight',
  script: 'Script',
  signedexchange: 'SignedExchange',
  stylesheet: 'Stylesheet',
  texttrack: 'TextTrack',
  websocket: 'WebSocket',
  xhr: 'XHR',
}

/** 网络请求记录表上限:超出按写入顺序淘汰最旧,防止长会话无界增长。 */
const MaxNetworkRequestRecords = 300

function clampPositiveInteger(value: unknown, fallback: number): number {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return Math.max(1, Math.round(fallback))

  return Math.max(1, Math.round(numberValue))
}

export interface BrowserCdpNetworkControllerDeps {
  /** 下发 CDP 命令(外部 WebSocket transport 或嵌入式 webContents.debugger)。 */
  send: CdpSend
  /** 把网络事件写入宿主 driver 的诊断缓冲(list_network_events 的数据源)。 */
  appendDiagnostic: (entry: BrowserPageDiagnosticEntry) => void
  /** 当前页面 URL,用于事件缺 url 时兜底。 */
  getCurrentUrl: () => string
  /** 当前网络节流预设(emulation 状态,宿主持有),与 offline 合流下发。 */
  getNetworkThrottling: () => BrowserNetworkThrottlingPreset
}

export class BrowserCdpNetworkController {
  private readonly networkRequests = new Map<string, CdpNetworkRequestRecord>()
  private readonly pendingNetworkRequestIds = new Set<string>()
  private readonly networkIdleStateListeners = new Set<() => void>()
  private networkOffline = false
  private extraHTTPHeaders: Record<string, string> = {}
  private blockedURLPatterns: string[] = []
  private blockedResourceTypes: string[] = []
  private networkMockResponses: BrowserNetworkMockResponse[] = []

  constructor(private readonly deps: BrowserCdpNetworkControllerDeps) {}

  /** 启用网络事件采集(两条 transport 都要先 enable 才有事件)。 */
  public async enableNetworkCapture(): Promise<void> {
    await this.deps.send('Network.enable')
  }

  /** 统一 CDP 事件入口:两条 transport 的网络/Fetch 事件都路由到这里。 */
  public handleCdpEvent(method: string, params: unknown): void {
    switch (method) {
      case 'Network.requestWillBeSent':
        this.recordNetworkRequestWillBeSent(params as CdpNetworkRequestWillBeSentEvent)
        return
      case 'Network.responseReceived':
        this.recordNetworkResponseReceived(params as CdpNetworkResponseReceivedEvent)
        return
      case 'Network.loadingFinished':
        this.recordNetworkLoadingFinished(params as CdpNetworkLoadingFinishedEvent)
        return
      case 'Network.loadingFailed':
        this.recordNetworkLoadingFailed(params as CdpNetworkLoadingFailedEvent)
        return
      case 'Fetch.requestPaused':
        this.handleFetchRequestPaused(params as CdpFetchRequestPausedEvent)
        return
      default:
        return
    }
  }

  /** 当前是否处于离线态(供 emulation 合成网络条件时读取)。 */
  public isOffline(): boolean {
    return this.networkOffline
  }

  public async configureNetwork(
    options: BrowserNetworkControlOptions
  ): Promise<BrowserPageDriverNetworkControlState> {
    let shouldSyncFetchInterception = false

    if (isPresent(options.extraHTTPHeaders)) {
      this.extraHTTPHeaders = this.normalizeExtraHTTPHeaders(options.extraHTTPHeaders)
      await this.deps.send('Network.setExtraHTTPHeaders', {
        headers: this.extraHTTPHeaders,
      })
    }

    if (isBoolean(options.offline)) {
      this.networkOffline = options.offline
      await this.syncNetworkConditions()
    }

    if (isPresent(options.blockedURLPatterns)) {
      this.blockedURLPatterns = this.normalizeBlockedURLPatterns(options.blockedURLPatterns)
      shouldSyncFetchInterception = true
    }

    if (isPresent(options.blockedResourceTypes)) {
      this.blockedResourceTypes = this.normalizeBlockedResourceTypes(options.blockedResourceTypes)
      shouldSyncFetchInterception = true
    }

    if (isPresent(options.mockResponses)) {
      this.networkMockResponses = this.normalizeNetworkMockResponses(options.mockResponses)
      shouldSyncFetchInterception = true
    }

    if (shouldSyncFetchInterception) {
      await this.syncFetchInterception()
    }

    return {
      offline: this.networkOffline,
      extraHTTPHeaders: { ...this.extraHTTPHeaders },
      blockedURLPatterns: [...this.blockedURLPatterns],
      blockedResourceTypes: [...this.blockedResourceTypes],
      mockResponses: this.cloneNetworkMockResponses(this.networkMockResponses),
    }
  }

  public async readNetworkResponseBody(
    options: BrowserNetworkResponseBodyOptions
  ): Promise<BrowserPageDriverNetworkResponseBodyResult> {
    const requestId = options.requestId.trim()
    if (!isNonBlankString(requestId)) {
      throw new AppError('VALIDATION', '网络 requestId 不能为空。')
    }

    const response = (await this.deps.send('Network.getResponseBody', {
      requestId,
    })) as CdpNetworkGetResponseBodyResponse
    const body = isString(response.body) ? response.body : ''
    const maxChars = Math.min(200_000, clampPositiveInteger(options.maxChars, 20_000))
    const truncatedBody = body.length > maxChars ? body.slice(0, maxChars) : body

    return {
      requestId,
      body: truncatedBody,
      base64Encoded: isTrue(response.base64Encoded),
      bodyLength: body.length,
      returnedChars: truncatedBody.length,
      bodyTruncated: body.length > maxChars,
    }
  }

  public async readNetworkRequestDetails(
    options: BrowserNetworkRequestDetailsOptions
  ): Promise<BrowserPageDriverNetworkRequestDetailsResult> {
    const requestId = options.requestId.trim()
    if (!isNonBlankString(requestId)) {
      throw new AppError('VALIDATION', '网络 requestId 不能为空。')
    }

    const record = this.networkRequests.get(requestId)
    if (!record) {
      throw new AppError('NOT_FOUND', `网络请求不存在或已过期：${requestId}`)
    }

    const result: BrowserPageDriverNetworkRequestDetailsResult = {
      requestId,
      request: {
        method: record.method,
        url: record.url,
        headers: { ...record.headers },
        ...(isNotNull(record.postData) ? { postData: record.postData } : {}),
        resourceType: record.resourceType,
        timestamp: record.timestamp,
        wallTime: record.wallTime,
      },
      response: record.response
        ? {
            status: record.response.status,
            statusText: record.response.statusText,
            headers: { ...record.response.headers },
            mimeType: record.response.mimeType,
            protocol: record.response.protocol,
            fromDiskCache: record.response.fromDiskCache,
            fromServiceWorker: record.response.fromServiceWorker,
            encodedDataLength: record.response.encodedDataLength,
            remoteIPAddress: record.response.remoteIPAddress,
            remotePort: record.response.remotePort,
            timing: record.response.timing ? { ...record.response.timing } : null,
          }
        : null,
      failure: record.failure ? { ...record.failure } : null,
      durationMs: this.computeNetworkRequestDurationMs(record),
    }

    if (options.includeResponseBody) {
      const body = await this.readNetworkResponseBody({
        requestId,
        maxChars: options.maxBodyChars,
      })
      result.responseBody = {
        body: body.body,
        base64Encoded: body.base64Encoded,
        bodyLength: body.bodyLength,
        returnedChars: body.returnedChars,
        bodyTruncated: body.bodyTruncated,
      }
    }

    return result
  }

  public async waitForNetworkIdle(options: BrowserPageDriverNetworkIdleOptions): Promise<void> {
    const idleMs = Math.min(60_000, clampPositiveInteger(options.idleMs, 500))
    const timeoutMs = Math.min(60_000, clampPositiveInteger(options.timeoutMs, 5000))

    return new Promise<void>((resolve) => {
      let settled = false
      const timers = new TimerScope({ name: 'BrowserCdpNetworkController.networkIdle' })
      let idleTimer: Nullable<TimerLease> = null
      let timeoutTimer: Nullable<TimerLease> = null

      const cancelIdleTimer = (): void => {
        if (!idleTimer) return
        idleTimer.cancel()
        idleTimer = null
      }
      const finish = (): void => {
        if (settled) return
        settled = true
        cancelIdleTimer()
        if (timeoutTimer) {
          timeoutTimer.cancel()
          timeoutTimer = null
        }
        timers.dispose()
        this.networkIdleStateListeners.delete(check)
        resolve()
      }
      const check = (): void => {
        if (this.pendingNetworkRequestIds.size > 0) {
          cancelIdleTimer()
          return
        }
        if (idleTimer) return
        idleTimer = timers.after(idleMs, finish)
      }

      this.networkIdleStateListeners.add(check)
      timeoutTimer = timers.after(timeoutMs, finish)
      check()
    })
  }

  /**
   * offline 与网络节流共用 Network.emulateNetworkConditions,统一按当前状态合成下发。
   * throttling 由宿主 emulation 状态提供(getNetworkThrottling),offline 归本控制器。
   */
  public async syncNetworkConditions(): Promise<void> {
    await syncCdpNetworkConditions(
      this.deps.send,
      this.deps.getNetworkThrottling(),
      this.networkOffline
    )
  }

  /** 会话重置/销毁时清空记录表与待结请求。 */
  public reset(): void {
    this.networkRequests.clear()
    this.pendingNetworkRequestIds.clear()
  }

  private handleFetchRequestPaused(event: CdpFetchRequestPausedEvent): void {
    if (!isNonBlankString(event.requestId)) return

    const request = isObject(event.request) ? (event.request as CdpNetworkRequestPayload) : {}
    const url = isNonBlankString(request.url) ? request.url : this.deps.getCurrentUrl()
    const resourceType = this.normalizeNetworkResourceType(event.resourceType)
    const mockResponse = this.findNetworkMockResponse(url)
    if (isPresent(mockResponse)) {
      this.fulfillMockedRequest(event.requestId, url, mockResponse)
      return
    }

    const shouldBlockRequest =
      this.blockedURLPatterns.some((pattern) => this.matchesURLPattern(pattern, url)) &&
      this.matchesBlockedResourceType(resourceType)
    if (!shouldBlockRequest) {
      this.continuePausedRequest(event.requestId, url)
      return
    }

    this.failBlockedRequest(event.requestId, url)
  }

  private fulfillMockedRequest(
    requestId: string,
    url: string,
    mockResponse: BrowserNetworkMockResponse
  ): void {
    void this.deps
      .send('Fetch.fulfillRequest', {
        requestId,
        responseCode: mockResponse.status ?? 200,
        responseHeaders: this.buildMockResponseHeaders(mockResponse),
        body: Buffer.from(mockResponse.body ?? '', 'utf8').toString('base64'),
      })
      .then(() => {
        this.deps.appendDiagnostic({
          kind: 'network',
          level: 'info',
          message: `Mocked request: ${url}`,
          url: toNullable(url),
          line: null,
          column: null,
          code: null,
          capturedAt: Date.now(),
          details: {
            requestId,
            mocked: true,
            status: mockResponse.status ?? 200,
          },
        })
      })
      .catch((error) => {
        this.deps.appendDiagnostic({
          kind: 'network',
          level: 'warning',
          message: 'CDP 请求 mock 响应失败。',
          url: toNullable(url),
          line: null,
          column: null,
          code: null,
          capturedAt: Date.now(),
          details: {
            requestId,
            error: AppError.from(error).message,
          },
        })
      })
  }

  private failBlockedRequest(requestId: string, url: string): void {
    void this.deps
      .send('Fetch.failRequest', {
        requestId,
        errorReason: 'BlockedByClient',
      })
      .then(() => {
        this.deps.appendDiagnostic({
          kind: 'network',
          level: 'warning',
          message: `Blocked request: ${url}`,
          url: toNullable(url),
          line: null,
          column: null,
          code: null,
          capturedAt: Date.now(),
          details: {
            requestId,
            blocked: true,
          },
        })
      })
      .catch((error) => {
        this.deps.appendDiagnostic({
          kind: 'network',
          level: 'warning',
          message: 'CDP 请求阻断失败。',
          url: toNullable(url),
          line: null,
          column: null,
          code: null,
          capturedAt: Date.now(),
          details: {
            requestId,
            error: AppError.from(error).message,
          },
        })
      })
  }

  private continuePausedRequest(requestId: string, url: string): void {
    void this.deps
      .send('Fetch.continueRequest', {
        requestId,
      })
      .catch((error) => {
        this.deps.appendDiagnostic({
          kind: 'network',
          level: 'warning',
          message: 'CDP 请求继续失败。',
          url: toNullable(url),
          line: null,
          column: null,
          code: null,
          capturedAt: Date.now(),
          details: {
            requestId,
            error: AppError.from(error).message,
          },
        })
      })
  }

  private recordNetworkRequestWillBeSent(event: CdpNetworkRequestWillBeSentEvent): void {
    if (!isNonBlankString(event.requestId)) return

    const request = isObject(event.request) ? (event.request as CdpNetworkRequestPayload) : {}
    const method = isNonBlankString(request.method) ? request.method : 'GET'
    const url = isNonBlankString(request.url) ? request.url : this.deps.getCurrentUrl()
    this.networkRequests.set(event.requestId, {
      requestId: event.requestId,
      method,
      url,
      headers: this.normalizeHeadersRecord(request.headers),
      postData: isString(request.postData) ? request.postData : null,
      resourceType: this.normalizeNetworkResourceType(event.type),
      timestamp: this.normalizeNullableNumber(event.timestamp),
      wallTime: this.normalizeNullableNumber(event.wallTime),
      response: null,
      failure: null,
      finishedTimestamp: null,
    })
    this.trackPendingNetworkRequest(event.requestId)

    if (this.networkRequests.size > MaxNetworkRequestRecords) {
      const oldestRequestId = this.networkRequests.keys().next().value
      this.clearNetworkRequest(oldestRequestId)
    }
  }

  private recordNetworkResponseReceived(event: CdpNetworkResponseReceivedEvent): void {
    const response = isObject(event.response)
      ? (event.response as CdpNetworkResponsePayload)
      : null
    const status = this.normalizeNetworkStatus(response?.status)
    if (!status) return

    const requestId = isNonBlankString(event.requestId) ? event.requestId : ''
    const request = requestId ? this.networkRequests.get(requestId) : null
    const method = request?.method ?? 'GET'
    const url = this.resolveNetworkEventUrl(response?.url, request)
    const statusText = isString(response?.statusText) ? response.statusText : ''
    const resourceType = this.normalizeNetworkResourceType(event.type, request)
    if (requestId && response) {
      this.recordNetworkResponseDetails(requestId, response)
    }
    const details: Record<string, unknown> = {
      requestId,
      method,
      status,
      statusText,
      resourceType,
    }
    this.assignNetworkStringDetail(details, 'mimeType', response?.mimeType)
    this.assignNetworkBooleanDetail(details, 'fromDiskCache', response?.fromDiskCache)
    this.assignNetworkBooleanDetail(details, 'fromServiceWorker', response?.fromServiceWorker)
    this.deps.appendDiagnostic({
      kind: 'network',
      level: this.resolveNetworkResponseDiagnosticLevel(status),
      message: `${method} ${status} ${url}`,
      url: toNullable(url),
      line: null,
      column: null,
      code: status,
      capturedAt: Date.now(),
      details,
    })
  }

  private recordNetworkResponseDetails(
    requestId: string,
    response: CdpNetworkResponsePayload
  ): void {
    const request = this.networkRequests.get(requestId)
    if (!request) return

    request.response = {
      status: this.normalizeNetworkStatus(response.status) ?? 0,
      statusText: isString(response.statusText) ? response.statusText : '',
      headers: this.normalizeHeadersRecord(response.headers),
      mimeType: isString(response.mimeType) ? response.mimeType : null,
      protocol: isString(response.protocol) ? response.protocol : null,
      fromDiskCache: isTrue(response.fromDiskCache),
      fromServiceWorker: isTrue(response.fromServiceWorker),
      encodedDataLength: this.normalizeNullableNumber(response.encodedDataLength),
      remoteIPAddress: isString(response.remoteIPAddress) ? response.remoteIPAddress : null,
      remotePort: this.normalizeNullableInteger(response.remotePort),
      timing: isObject(response.timing) ? { ...(response.timing as Record<string, unknown>) } : null,
    }
  }

  private recordNetworkLoadingFinished(event: CdpNetworkLoadingFinishedEvent): void {
    const requestId = isNonBlankString(event.requestId) ? event.requestId : ''
    this.settlePendingNetworkRequest(requestId)
    const request = requestId ? this.networkRequests.get(requestId) : null
    if (!request) return

    request.finishedTimestamp = this.normalizeNullableNumber(event.timestamp)
    const encodedDataLength = this.normalizeNullableNumber(event.encodedDataLength)
    if (!isNotNull(encodedDataLength)) return

    const response = request.response ?? {
      status: 0,
      statusText: '',
      headers: {},
      mimeType: null,
      protocol: null,
      fromDiskCache: false,
      fromServiceWorker: false,
      encodedDataLength: null,
      remoteIPAddress: null,
      remotePort: null,
      timing: null,
    }
    response.encodedDataLength = encodedDataLength
    request.response = response
  }

  private recordNetworkLoadingFailed(event: CdpNetworkLoadingFailedEvent): void {
    const requestId = isNonBlankString(event.requestId) ? event.requestId : ''
    this.settlePendingNetworkRequest(requestId)
    const request = requestId ? this.networkRequests.get(requestId) : null
    const resourceType = this.normalizeNetworkResourceType(event.type, request)
    const errorText = isString(event.errorText) ? event.errorText : 'unknown network error'
    const details: Record<string, unknown> = {
      requestId,
      resourceType,
      errorText,
    }
    this.assignNetworkStringDetail(details, 'method', request?.method)
    this.assignNetworkBooleanDetail(details, 'canceled', event.canceled)
    this.deps.appendDiagnostic({
      kind: 'network',
      level: 'error',
      message: `${resourceType} request failed: ${errorText}`,
      url: toNullable(this.resolveNetworkEventUrl(null, request)),
      line: null,
      column: null,
      code: null,
      capturedAt: Date.now(),
      details,
    })
    if (request) {
      request.failure = {
        errorText,
        canceled: isTrue(event.canceled),
      }
      request.finishedTimestamp = this.normalizeNullableNumber(event.timestamp)
    }
  }

  private clearNetworkRequest(requestId: unknown): void {
    if (!isNonBlankString(requestId)) return

    this.settlePendingNetworkRequest(requestId)
    this.networkRequests.delete(requestId)
  }

  private trackPendingNetworkRequest(requestId: string): void {
    this.pendingNetworkRequestIds.add(requestId)
    this.notifyNetworkIdleStateChanged()
  }

  private settlePendingNetworkRequest(requestId: string): void {
    if (!isNonBlankString(requestId)) return
    if (!this.pendingNetworkRequestIds.delete(requestId)) return

    this.notifyNetworkIdleStateChanged()
  }

  private notifyNetworkIdleStateChanged(): void {
    for (const listener of this.networkIdleStateListeners) {
      listener()
    }
  }

  private computeNetworkRequestDurationMs(record: CdpNetworkRequestRecord): Nullable<number> {
    if (!isNotNull(record.timestamp) || !isNotNull(record.finishedTimestamp)) return null

    return Math.max(0, Math.round((record.finishedTimestamp - record.timestamp) * 1000))
  }

  private normalizeHeadersRecord(value: unknown): Record<string, string> {
    if (!isObject(value)) return {}

    const result: Record<string, string> = {}
    for (const [name, rawValue] of Object.entries(value)) {
      if (!isNonBlankString(name)) continue

      if (isString(rawValue)) {
        result[name] = rawValue
        continue
      }
      if (isFiniteNumber(rawValue) || isBoolean(rawValue)) {
        result[name] = String(rawValue)
      }
    }

    return result
  }

  private normalizeNullableNumber(value: unknown): Nullable<number> {
    return isFiniteNumber(value) ? value : null
  }

  private normalizeNullableInteger(value: unknown): Nullable<number> {
    return isFiniteNumber(value) ? Math.round(value) : null
  }

  private normalizeNetworkStatus(status: unknown): Nullable<number> {
    if (!isFiniteNumber(status)) return null

    return Math.round(status)
  }

  private resolveNetworkResponseDiagnosticLevel(status: number): BrowserPageDiagnosticLevel {
    if (status >= 500) return 'error'
    if (status >= 400) return 'warning'

    return 'info'
  }

  private normalizeNetworkResourceType(
    resourceType: unknown,
    request?: LooseOptional<CdpNetworkRequestRecord>
  ): string {
    if (isNonBlankString(resourceType)) return this.normalizeNetworkResourceTypeValue(resourceType)

    return request?.resourceType ?? 'Other'
  }

  private normalizeNetworkResourceTypeValue(resourceType: string): string {
    const normalizedKey = resourceType.trim().replace(/[-_\s]/g, '').toLowerCase()
    return CdpNetworkResourceTypeByKey[normalizedKey] ?? resourceType
  }

  private resolveNetworkEventUrl(
    url: unknown,
    request?: LooseOptional<CdpNetworkRequestRecord>
  ): string {
    if (isNonBlankString(url)) return url
    if (request?.url) return request.url

    return this.deps.getCurrentUrl()
  }

  private assignNetworkStringDetail(
    details: Record<string, unknown>,
    key: string,
    value: unknown
  ): void {
    if (isNonBlankString(value)) {
      details[key] = value
    }
  }

  private assignNetworkBooleanDetail(
    details: Record<string, unknown>,
    key: string,
    value: unknown
  ): void {
    if (isBoolean(value)) {
      details[key] = value
    }
  }

  private normalizeExtraHTTPHeaders(headers: Record<string, string>): Record<string, string> {
    const normalized: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers)) {
      const normalizedName = name.trim()
      if (!isNonBlankString(normalizedName)) continue

      normalized[normalizedName] = String(value)
    }
    return normalized
  }

  private normalizeBlockedURLPatterns(patterns: string[]): string[] {
    return [...new Set(patterns.map((pattern) => pattern.trim()).filter(isNonBlankString))]
  }

  private normalizeBlockedResourceTypes(resourceTypes: string[]): string[] {
    return [
      ...new Set(
        resourceTypes
          .map((resourceType) => this.normalizeNetworkResourceTypeFilter(resourceType))
          .filter(isNonBlankString)
      ),
    ]
  }

  private normalizeNetworkResourceTypeFilter(resourceType: string): string {
    const normalizedKey = resourceType.trim().replace(/[-_\s]/g, '').toLowerCase()
    if (!isNonBlankString(normalizedKey)) return ''

    const normalizedResourceType = CdpNetworkResourceTypeByKey[normalizedKey]
    if (isNonBlankString(normalizedResourceType)) return normalizedResourceType

    throw new AppError('VALIDATION', `不支持的网络资源类型：${resourceType}`)
  }

  private normalizeNetworkMockResponses(
    responses: BrowserNetworkMockResponse[]
  ): BrowserNetworkMockResponse[] {
    const normalizedResponses: BrowserNetworkMockResponse[] = []
    const seenURLPatterns = new Set<string>()

    for (const response of responses) {
      const urlPattern = response.urlPattern.trim()
      if (!isNonBlankString(urlPattern) || seenURLPatterns.has(urlPattern)) continue

      seenURLPatterns.add(urlPattern)
      normalizedResponses.push({
        urlPattern,
        status: this.normalizeMockResponseStatus(response.status),
        contentType: isNonBlankString(response.contentType?.trim())
          ? response.contentType.trim()
          : 'application/json',
        body: isString(response.body) ? response.body : '',
        headers: this.normalizeExtraHTTPHeaders(response.headers ?? {}),
      })
    }

    return normalizedResponses
  }

  private normalizeMockResponseStatus(status: unknown): number {
    if (!isFiniteNumber(status)) return 200

    return Math.min(Math.max(Math.round(status), 100), 599)
  }

  private cloneNetworkMockResponses(
    responses: BrowserNetworkMockResponse[]
  ): BrowserNetworkMockResponse[] {
    return responses.map((response) => ({
      ...response,
      headers: { ...(response.headers ?? {}) },
    }))
  }

  private async syncFetchInterception(): Promise<void> {
    const patterns = this.buildFetchInterceptionPatterns()
    if (isEmpty(patterns)) {
      await this.deps.send('Fetch.disable')
      return
    }

    await this.deps.send('Fetch.enable', {
      patterns,
    })
  }

  private buildFetchInterceptionPatterns(): Array<{
    urlPattern: string
    resourceType?: string
    requestStage: 'Request'
  }> {
    const patterns: Array<{
      urlPattern: string
      resourceType?: string
      requestStage: 'Request'
    }> = []
    const seen = new Set<string>()

    const appendPattern = (urlPattern: string, resourceType?: string): void => {
      const key = `${urlPattern}\u0000${resourceType ?? ''}`
      if (seen.has(key)) return

      seen.add(key)
      patterns.push(
        isNonBlankString(resourceType)
          ? { urlPattern, resourceType, requestStage: 'Request' }
          : { urlPattern, requestStage: 'Request' }
      )
    }

    for (const urlPattern of this.blockedURLPatterns) {
      if (isEmpty(this.blockedResourceTypes)) {
        appendPattern(urlPattern)
        continue
      }

      for (const resourceType of this.blockedResourceTypes) {
        appendPattern(urlPattern, resourceType)
      }
    }

    for (const response of this.networkMockResponses) {
      appendPattern(response.urlPattern)
    }

    return patterns
  }

  private matchesBlockedResourceType(resourceType: string): boolean {
    return isEmpty(this.blockedResourceTypes) || this.blockedResourceTypes.includes(resourceType)
  }

  private findNetworkMockResponse(url: string): Nullable<BrowserNetworkMockResponse> {
    return toNullable(
      this.networkMockResponses.find((response) =>
        this.matchesURLPattern(response.urlPattern, url)
      )
    )
  }

  private buildMockResponseHeaders(
    mockResponse: BrowserNetworkMockResponse
  ): Array<{ name: string; value: string }> {
    const headers: Array<{ name: string; value: string }> = [
      {
        name: 'content-type',
        value: mockResponse.contentType ?? 'application/json',
      },
    ]

    for (const [name, value] of Object.entries(mockResponse.headers ?? {})) {
      if (name.toLowerCase() === 'content-type') continue

      headers.push({ name, value })
    }

    return headers
  }

  private matchesURLPattern(pattern: string, url: string): boolean {
    if (!isNonBlankString(pattern) || !isNonBlankString(url)) return false

    const source = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${source}$`).test(url)
  }
}
