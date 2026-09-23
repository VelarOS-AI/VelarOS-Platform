import {
  isBoolean,
  isEmpty,
  isNonBlankString,
  isNotNull,
  isObject,
  isPlainObject,
  isPresent,
  isString,
  isTrue,
  toNullable,
  toOptional,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type {
  BrowserNetworkControlOptions,
  BrowserNetworkMockResponse,
  BrowserNetworkRequestDetailsOptions,
  BrowserNetworkResponseBodyOptions,
  BrowserPageDiagnosticEntry,
} from '../../types/browser.js'
import type {
  CdpFetchRequestPausedEvent,
  CdpNetworkGetResponseBodyResponse,
  CdpNetworkLoadingFailedEvent,
  CdpNetworkLoadingFinishedEvent,
  CdpNetworkRequestPayload,
  CdpNetworkRequestRecord,
  CdpNetworkRequestWillBeSentEvent,
  CdpNetworkResponsePayload,
  CdpNetworkResponseReceivedEvent,
  CdpSend,
} from '../../types/cdp.js'
import type {
  BrowserPageDriverNetworkControlState,
  BrowserPageDriverNetworkIdleOptions,
  BrowserPageDriverNetworkRequestDetailsResult,
  BrowserPageDriverNetworkResponseBodyResult,
} from '../../types/driver'
import {
  assignNetworkBooleanDetail,
  assignNetworkStringDetail,
  buildMockResponseHeaders,
  cloneNetworkMockResponses,
  computeNetworkRequestDurationMs,
  matchesURLPattern,
  normalizeBlockedURLPatterns,
  normalizeExtraHTTPHeaders,
  normalizeHeadersRecord,
  normalizeNetworkStatus,
  normalizeNullableInteger,
  normalizeNullableNumber,
  resolveNetworkResponseDiagnosticLevel,
} from '../../utils/cdp/network'
import {
  normalizeBlockedResourceTypes,
  normalizeNetworkMockResponses,
  normalizeNetworkResourceType,
} from '../../utils/cdp/network'
import { clampPositiveInteger } from '../../utils/numbers.js'
import { BrowserTuning } from '../../utils/tuning'

/** 网络控制器要的协作件：内嵌页面与外部 CDP 各自把自己的传输与诊断缓冲塞进来。 */
export interface BrowserCdpNetworkControllerDeps {
  /** 下发 CDP 命令(外部 WebSocket transport 或嵌入式 webContents.debugger)。 */
  send: CdpSend
  /** 把网络事件写入宿主 driver 的诊断缓冲(list_network_events 的数据源)。 */
  appendDiagnostic: (entry: BrowserPageDiagnosticEntry) => void
  /** 当前页面 URL,用于事件缺 url 时兜底。 */
  getCurrentUrl: () => string
}

/**
 * 网络控制器：离线、改请求头、拦截与 mock，以及按 requestId 读请求详情与响应体。
 *
 * 内嵌页面（webContents.debugger）与外部 CDP 浏览器（WebSocket）共用这一份——两条路下发的是同一套
 * CDP Network / Fetch 命令，只差传输，所以记账、详情读取与拦截规则只写一遍。
 *
 * 状态归调用方：一条页面一个实例，请求明细按写入顺序淘汰最旧的，长会话不会无界增长。
 */
export interface BrowserCdpNetworkControllerApi {
  /** 启用网络事件采集(两条 transport 都要先 enable 才有事件)。 */
  enableNetworkCapture(): Promise<void>
  /** 统一 CDP 事件入口:两条 transport 的网络/Fetch 事件都路由到这里。 */
  handleCdpEvent(method: string, params: unknown): void
  /** 配置页面网络：离线、请求头、拦截与 mock。 */
  configureNetwork(
    options: BrowserNetworkControlOptions
  ): Promise<BrowserPageDriverNetworkControlState>
  /** 按 requestId 读响应体；不在缓存里就如实回报读不到。 */
  readNetworkResponseBody(
    options: BrowserNetworkResponseBodyOptions
  ): Promise<BrowserPageDriverNetworkResponseBodyResult>
  /** 按 requestId 读请求、响应与 timing 详情。 */
  readNetworkRequestDetails(
    options: BrowserNetworkRequestDetailsOptions
  ): Promise<BrowserPageDriverNetworkRequestDetailsResult>
  /** 等页面网络空闲（一段时间内没有新请求）。 */
  waitForNetworkIdle(options: BrowserPageDriverNetworkIdleOptions): Promise<boolean>
  /** 会话重置/销毁时清空记录表与待结请求。 */
  reset(): void
}

export class BrowserCdpNetworkController implements BrowserCdpNetworkControllerApi {
  /** mock 响应没写状态码时按 200 返回。 */
  private static readonly DefaultMockResponseStatus = 200

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

  public async configureNetwork(
    options: BrowserNetworkControlOptions
  ): Promise<BrowserPageDriverNetworkControlState> {
    let shouldSyncFetchInterception = false

    if (isPresent(options.extraHTTPHeaders)) {
      this.extraHTTPHeaders = normalizeExtraHTTPHeaders(options.extraHTTPHeaders)
      await this.deps.send('Network.setExtraHTTPHeaders', {
        headers: this.extraHTTPHeaders,
      })
    }

    if (isBoolean(options.offline)) {
      this.networkOffline = options.offline
      await this.syncNetworkConditions()
    }

    if (isPresent(options.blockedURLPatterns)) {
      this.blockedURLPatterns = normalizeBlockedURLPatterns(options.blockedURLPatterns)
      shouldSyncFetchInterception = true
    }

    if (isPresent(options.blockedResourceTypes)) {
      this.blockedResourceTypes = normalizeBlockedResourceTypes(options.blockedResourceTypes)
      shouldSyncFetchInterception = true
    }

    if (isPresent(options.mockResponses)) {
      this.networkMockResponses = normalizeNetworkMockResponses(options.mockResponses)
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
      mockResponses: cloneNetworkMockResponses(this.networkMockResponses),
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
        postData: toOptional(record.postData),
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
      durationMs: computeNetworkRequestDurationMs(record),
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

  public async waitForNetworkIdle(options: BrowserPageDriverNetworkIdleOptions): Promise<boolean> {
    const idleMs = Math.min(60_000, clampPositiveInteger(options.idleMs, 500))
    const timeoutMs = Math.min(60_000, clampPositiveInteger(options.timeoutMs, 5000))

    // 交回等没等到：空闲了是 true，到点还有请求在飞是 false。
    return new Promise<boolean>((resolve) => {
      let settled = false
      const timers = new TimerScope({ name: 'BrowserCdpNetworkController.networkIdle' })
      let idleTimer: Nullable<TimerLease> = null
      let timeoutTimer: Nullable<TimerLease> = null

      const cancelIdleTimer = (): void => {
        if (!idleTimer) return
        idleTimer.cancel()
        idleTimer = null
      }
      const finish = (idle: boolean): void => {
        if (settled) return
        settled = true
        cancelIdleTimer()
        if (timeoutTimer) {
          timeoutTimer.cancel()
          timeoutTimer = null
        }
        timers.dispose()
        this.networkIdleStateListeners.delete(check)
        resolve(idle)
      }
      const check = (): void => {
        if (this.pendingNetworkRequestIds.size > 0) {
          cancelIdleTimer()
          return
        }
        if (idleTimer) return
        idleTimer = timers.after(idleMs, () => finish(true))
      }

      this.networkIdleStateListeners.add(check)
      timeoutTimer = timers.after(timeoutMs, () => finish(false))
      check()
    })
  }

  /** 按离线开关下发网络条件：离线就断网，不离线就不限速。 */
  private async syncNetworkConditions(): Promise<void> {
    await this.deps.send('Network.emulateNetworkConditions', {
      offline: this.networkOffline,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
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
    const resourceType = normalizeNetworkResourceType(event.resourceType)
    const mockResponse = this.findNetworkMockResponse(url)
    if (isPresent(mockResponse)) {
      this.fulfillMockedRequest(event.requestId, url, mockResponse)
      return
    }

    const shouldBlockRequest =
      this.blockedURLPatterns.some((pattern) => matchesURLPattern(pattern, url)) &&
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
        responseCode: mockResponse.status ?? BrowserCdpNetworkController.DefaultMockResponseStatus,
        responseHeaders: buildMockResponseHeaders(mockResponse),
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
            status: mockResponse.status ?? BrowserCdpNetworkController.DefaultMockResponseStatus,
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
      headers: normalizeHeadersRecord(request.headers),
      postData: isString(request.postData) ? request.postData : null,
      resourceType: normalizeNetworkResourceType(event.type),
      timestamp: normalizeNullableNumber(event.timestamp),
      wallTime: normalizeNullableNumber(event.wallTime),
      response: null,
      failure: null,
      finishedTimestamp: null,
    })
    this.trackPendingNetworkRequest(event.requestId)

    if (this.networkRequests.size > BrowserTuning.cdp.networkRequestRecords) {
      const oldestRequestId = this.networkRequests.keys().next().value
      this.clearNetworkRequest(oldestRequestId)
    }
  }

  private recordNetworkResponseReceived(event: CdpNetworkResponseReceivedEvent): void {
    const response = isObject(event.response) ? (event.response as CdpNetworkResponsePayload) : null
    const status = normalizeNetworkStatus(response?.status)
    if (!status) return

    const requestId = isNonBlankString(event.requestId) ? event.requestId : ''
    const request = requestId ? this.networkRequests.get(requestId) : null
    const method = request?.method ?? 'GET'
    const url = this.resolveNetworkEventUrl(response?.url, request)
    const statusText = isString(response?.statusText) ? response.statusText : ''
    const resourceType = normalizeNetworkResourceType(event.type, request)
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
    assignNetworkStringDetail(details, 'mimeType', response?.mimeType)
    assignNetworkBooleanDetail(details, 'fromDiskCache', response?.fromDiskCache)
    assignNetworkBooleanDetail(details, 'fromServiceWorker', response?.fromServiceWorker)
    this.deps.appendDiagnostic({
      kind: 'network',
      level: resolveNetworkResponseDiagnosticLevel(status),
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
      status: normalizeNetworkStatus(response.status) ?? 0,
      statusText: isString(response.statusText) ? response.statusText : '',
      headers: normalizeHeadersRecord(response.headers),
      mimeType: isString(response.mimeType) ? response.mimeType : null,
      protocol: isString(response.protocol) ? response.protocol : null,
      fromDiskCache: isTrue(response.fromDiskCache),
      fromServiceWorker: isTrue(response.fromServiceWorker),
      encodedDataLength: normalizeNullableNumber(response.encodedDataLength),
      remoteIPAddress: isString(response.remoteIPAddress) ? response.remoteIPAddress : null,
      remotePort: normalizeNullableInteger(response.remotePort),
      timing: isPlainObject(response.timing) ? { ...response.timing } : null,
    }
  }

  private recordNetworkLoadingFinished(event: CdpNetworkLoadingFinishedEvent): void {
    const requestId = isNonBlankString(event.requestId) ? event.requestId : ''
    this.settlePendingNetworkRequest(requestId)
    const request = requestId ? this.networkRequests.get(requestId) : null
    if (!request) return

    request.finishedTimestamp = normalizeNullableNumber(event.timestamp)
    const encodedDataLength = normalizeNullableNumber(event.encodedDataLength)
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
    const resourceType = normalizeNetworkResourceType(event.type, request)
    const errorText = isString(event.errorText) ? event.errorText : '未知的网络错误'
    const details: Record<string, unknown> = {
      requestId,
      resourceType,
      errorText,
    }
    assignNetworkStringDetail(details, 'method', request?.method)
    assignNetworkBooleanDetail(details, 'canceled', event.canceled)
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
      request.finishedTimestamp = normalizeNullableNumber(event.timestamp)
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

  private resolveNetworkEventUrl(
    url: unknown,
    request?: LooseOptional<CdpNetworkRequestRecord>
  ): string {
    if (isNonBlankString(url)) return url
    if (request?.url) return request.url

    return this.deps.getCurrentUrl()
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
      this.networkMockResponses.find((response) => matchesURLPattern(response.urlPattern, url))
    )
  }
}
