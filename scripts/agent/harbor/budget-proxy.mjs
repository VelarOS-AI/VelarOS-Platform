import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { authenticateAttempt } from './request-identity.mjs'
import { RequestScheduler } from './request-scheduler.mjs'

// 官方 Standard 价格（USD / 1M token，2026-09-28），随请求冻结，历史账不重算。
// https://developers.openai.com/api/docs/pricing
export const campaignModel = 'gpt-6-sol'
export const campaignPricing = Object.freeze({
  input: 2,
  cached: 0.2,
  write: 2.5,
  output: 10,
  longThreshold: 272000,
  longInputMultiplier: 2,
  longOutputMultiplier: 1.5,
})

function isLocalTool(tool) {
  return (
    ['function', 'custom'].includes(tool?.type) ||
    (tool?.type === 'namespace' && Array.isArray(tool.tools) && tool.tools.every(isLocalTool))
  )
}

// 只保存有限的错误标识，不把原始错误消息、URL 或凭据写入费用账。
function safeErrorCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(value) ? value : null
}

// 只保留失败字段的形状、摘要和机器码；正文与凭据仍不进入费用账。
function observedTerminalFailure(record, secrets) {
  const error = record?.response?.error ?? record?.error
  const describe = (object, key) => {
    if (object == null || !Object.hasOwn(object, key)) return { state: 'absent' }
    const value = object[key]
    if (value === null) return { state: 'null' }
    if (typeof value !== 'string') return { state: 'other' }
    const machine = safeErrorCode(value)
    return {
      state: 'string',
      chars: value.length,
      sha256: createHash('sha256').update(value).digest('hex'),
      machineCode:
        machine && !secrets.some((secret) => secret && machine.includes(secret)) ? machine : null,
    }
  }
  return {
    sequenceNumber: !Object.hasOwn(record, 'sequence_number')
      ? 'absent'
      : Number.isSafeInteger(record.sequence_number) && record.sequence_number >= 0
        ? 'valid'
        : 'other',
    responseStatus: observedOption(record.response, 'status', ['failed']),
    code: describe(error, 'code'),
    message: describe(error, 'message'),
  }
}

// 只记录白名单值，区分省略、null 与未知值；不能把任意请求正文混进费用账。
function observedOption(object, key, allowed) {
  if (object == null || !Object.hasOwn(object, key)) return { state: 'absent' }
  const value = object[key]
  if (value === null) return { state: 'null' }
  return allowed.includes(value) ? { state: 'value', value } : { state: 'other' }
}

function observedWireOptions(body) {
  return {
    reasoningContext: observedOption(body.reasoning, 'context', [
      'auto',
      'current_turn',
      'all_turns',
    ]),
    reasoningSummary: observedOption(body.reasoning, 'summary', ['auto', 'concise', 'detailed']),
    textVerbosity: observedOption(body.text, 'verbosity', ['low', 'medium', 'high']),
    parallelToolCalls: observedOption(body, 'parallel_tool_calls', [true, false]),
    store: observedOption(body, 'store', [true, false]),
    include: !Object.hasOwn(body, 'include')
      ? { state: 'absent' }
      : body.include === null
        ? { state: 'null' }
        : Array.isArray(body.include)
          ? {
              state: 'value',
              count: body.include.length,
              encryptedReasoning: body.include.includes('reasoning.encrypted_content'),
            }
          : { state: 'other' },
  }
}

// 配对共用的生成资源必须显式冻结；没有策略的历史网关保持原请求语义。
export function normalizedGenerationPolicy(value) {
  if (value == null) return null
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'maxOutputTokens,reasoningContext,reasoningSummary,textVerbosity' ||
    !Number.isSafeInteger(value.maxOutputTokens) ||
    value.maxOutputTokens < 1 ||
    value.maxOutputTokens > 128000 ||
    !['auto', 'current_turn', 'all_turns'].includes(value.reasoningContext) ||
    !['auto', 'concise', 'detailed'].includes(value.reasoningSummary) ||
    !['low', 'medium', 'high'].includes(value.textVerbosity)
  )
    throw new Error('Invalid frozen generation policy')
  return Object.freeze({
    maxOutputTokens: value.maxOutputTokens,
    reasoningContext: value.reasoningContext,
    reasoningSummary: value.reasoningSummary,
    textVerbosity: value.textVerbosity,
  })
}

// 端点身份只包含 API 根，不允许凭据或请求参数混入地址和账本。
function upstreamEndpoint(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid upstream URL: an absolute HTTP(S) URL is required')
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    String(value).includes('?') ||
    String(value).includes('#')
  )
    throw new Error('Invalid upstream URL: credentials, query and fragment are forbidden')
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`
  const baseURL = url.href
  return Object.freeze({ baseURL, endpointId: createHash('sha256').update(baseURL).digest('hex') })
}

// CLI 的非默认端点必须显式授权；授权与配置规范化后须指向同一个 API 根。
export function authorizedUpstream(configuredURL, explicitlyAuthorizedURL) {
  const configured = upstreamEndpoint(configuredURL)
  const approved = upstreamEndpoint(explicitlyAuthorizedURL ?? 'https://api.openai.com')
  if (configured.endpointId !== approved.endpointId)
    throw new Error(
      explicitlyAuthorizedURL
        ? 'Explicit upstream URL must match the configured API root'
        : 'A non-default API root requires explicit --upstream-url authorization'
    )
  return configured.baseURL
}
export function usageCost(usage, upperBound = false, pricing = campaignPricing) {
  const input = usage?.input_tokens ?? usage?.prompt_tokens
  const output = usage?.output_tokens ?? usage?.completion_tokens
  const details = usage?.input_tokens_details ?? usage?.prompt_tokens_details
  const cached = details?.cached_tokens ?? (upperBound ? 0 : undefined)
  const written = details?.cache_write_tokens ?? (upperBound ? input - cached : undefined)
  if (
    ![input, output, cached, written].every((n) => Number.isInteger(n) && n >= 0) ||
    cached + written > input
  )
    return null
  const long = upperBound || input > pricing.longThreshold
  return (
    (((input - cached - written) * pricing.input +
      cached * pricing.cached +
      written * pricing.write) *
      (long ? pricing.longInputMultiplier : 1) +
      output * pricing.output * (long ? pricing.longOutputMultiplier : 1)) /
    1000000
  )
}

// 每次请求先持久预占模型输入上界与输出上限的保守费用；未绑定输出上限的旧账本保留原策略。
// 断流没有 usage 时保留预占；进程重启也不返还。第二个进程不得共用同一本账。
export class BudgetLedger {
  constructor(
    directory,
    limitUsd = 1000,
    {
      allowLimitChange = false,
      model = campaignModel,
      pricing = campaignPricing,
      pricingRef = 'openai-standard-2026-09-28',
      reasoningEffort = null,
      pricingBasis,
      maxRequestsPerAttempt = null,
      perAttemptBudgetUsd = null,
      reservationOutputTokens = null,
    } = {}
  ) {
    if (limitUsd === 'unlimited') limitUsd = null
    else if (!Number.isFinite(limitUsd) || limitUsd <= 0)
      throw new Error('Budget must be a positive USD amount or explicit unlimited')
    if (
      typeof model !== 'string' ||
      !model ||
      typeof pricingRef !== 'string' ||
      !pricingRef ||
      Object.keys(campaignPricing).some((key) => !Number.isFinite(pricing[key]) || pricing[key] < 0)
    )
      throw new Error('A model and complete frozen pricing reference are required')
    if (pricingBasis !== undefined) {
      if (
        !pricingBasis ||
        !['reference_only', 'provider_rates'].includes(pricingBasis.kind) ||
        typeof pricingBasis.source !== 'string' ||
        !pricingBasis.source.trim()
      )
        throw new Error('Invalid pricing basis: kind and source are required')
      this.pricingBasis = Object.freeze({
        kind: pricingBasis.kind,
        source: pricingBasis.source,
        ...(pricingBasis.upstreamBaseURL !== undefined
          ? { upstreamBaseURL: upstreamEndpoint(pricingBasis.upstreamBaseURL).baseURL }
          : {}),
      })
    }
    this.reasoningEffort = reasoningEffort
    if (
      maxRequestsPerAttempt !== null &&
      (!Number.isSafeInteger(maxRequestsPerAttempt) || maxRequestsPerAttempt < 1)
    )
      throw new Error('Request limit must be a positive integer')
    this.maxRequestsPerAttempt = maxRequestsPerAttempt
    if (
      perAttemptBudgetUsd !== null &&
      (!Number.isFinite(perAttemptBudgetUsd) || perAttemptBudgetUsd <= 0)
    )
      throw new Error('Per-attempt budget must be positive')
    this.perAttemptBudgetUsd = perAttemptBudgetUsd
    if (
      reservationOutputTokens !== null &&
      (!Number.isSafeInteger(reservationOutputTokens) ||
        reservationOutputTokens < 1 ||
        reservationOutputTokens > 128000)
    )
      throw new Error('Reservation output bound must be an integer in 1..128000')
    if (
      pricing.maxInputTokens !== undefined &&
      (!Number.isSafeInteger(pricing.maxInputTokens) || pricing.maxInputTokens < 1)
    )
      throw new Error('Reservation model input bound must be a positive integer')
    this.reservationOutputTokens = reservationOutputTokens
    this.model = model
    this.pricing = Object.freeze({ ...pricing })
    this.pricingRef = pricingRef
    this.reservationUsd = Math.max(
      reservationOutputTokens === null ? 20 : 0,
      ((pricing.maxInputTokens ?? 1050000) *
        Math.max(pricing.input, pricing.cached, pricing.write) *
        Math.max(1, pricing.longInputMultiplier) +
        (reservationOutputTokens ?? 128000) *
          pricing.output *
          Math.max(1, pricing.longOutputMultiplier)) /
        1000000
    )
    mkdirSync(directory, { recursive: true })
    this.path = join(directory, 'budget.json')
    this.lock = join(directory, 'budget.lock')
    this.fd = openSync(this.lock, 'wx', 0o600)
    this.state = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, 'utf8'))
      : {
          schema: 2,
          limitUsd,
          maxRequestsPerAttempt,
          perAttemptBudgetUsd,
          reservationOutputTokens,
          requests: [],
        }
    if ((this.state.reservationOutputTokens ?? null) !== reservationOutputTokens) {
      this.close()
      throw new Error('Existing reservation output bound differs; use a new ledger directory')
    }
    if (
      (this.state.maxRequestsPerAttempt ?? null) !== maxRequestsPerAttempt ||
      (this.state.perAttemptBudgetUsd ?? null) !== perAttemptBudgetUsd
    ) {
      this.close()
      throw new Error('Existing per-attempt limits differ; use a new ledger directory')
    }
    if (this.state.limitUsd !== limitUsd) {
      if (!allowLimitChange) {
        this.close()
        throw new Error('Existing campaign budget differs; explicitly authorize a limit change')
      }
      this.state.limitHistory ??= []
      this.state.limitHistory.push({
        previous: this.state.limitUsd,
        next: limitUsd,
        at: new Date().toISOString(),
      })
      this.state.limitUsd = limitUsd
    }
    if (
      this.state.model &&
      (this.state.model !== model ||
        JSON.stringify(this.state.pricing) !== JSON.stringify(pricing) ||
        this.state.pricingRef !== pricingRef ||
        JSON.stringify(this.state.pricingBasis ?? null) !==
          JSON.stringify(this.pricingBasis ?? null) ||
        (this.state.reasoningEffort ?? null) !== reasoningEffort)
    ) {
      this.close()
      throw new Error('Existing campaign model/pricing differs; use a new ledger directory')
    }
    Object.assign(this.state, {
      schema: 3,
      model,
      reasoningEffort,
      pricing: this.pricing,
      pricingRef,
      maxRequestsPerAttempt,
      perAttemptBudgetUsd,
      reservationOutputTokens,
      ...(this.pricingBasis ? { pricingBasis: this.pricingBasis } : {}),
      budgetMode: limitUsd === null ? 'unlimited' : 'limited',
    })
    this.save()
  }
  save() {
    writeFileSync(`${this.path}.writing`, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    renameSync(`${this.path}.writing`, this.path)
  }
  summary(identity) {
    const requests = identity
      ? this.state.requests.filter((item) => item.identity?.attemptId === identity.attemptId)
      : this.state.requests
    return {
      limitUsd: this.state.limitUsd,
      model: this.model,
      pricing: this.pricing,
      reasoningEffort: this.reasoningEffort,
      pricingRef: this.pricingRef,
      ...(this.pricingBasis ? { pricingBasis: this.pricingBasis } : {}),
      budgetMode: this.state.budgetMode,
      reservationUsd: this.reservationUsd,
      reservationOutputTokens: this.reservationOutputTokens,
      estimatedKnownUsd: requests.reduce((sum, item) => sum + (item.estimatedUsd ?? 0), 0),
      committedUpperUsd: requests.reduce((sum, item) => sum + item.budgetUsd, 0),
      requests: requests.length,
      unknownUsage: requests.filter((item) => item.estimatedUsd === null).length,
      rejectedRequests: (this.state.rejectedRequests ?? []).filter(
        (item) => !identity || item.identity?.attemptId === identity.attemptId
      ).length,
    }
  }
  reserve(metadata = {}, identity = null) {
    if (
      this.reservationOutputTokens !== null &&
      (!Number.isSafeInteger(metadata.outputLimit) ||
        metadata.outputLimit < 1 ||
        metadata.outputLimit > this.reservationOutputTokens)
    )
      throw new Error('Request output limit exceeds or omits the frozen reservation bound')
    if (
      identity &&
      this.state.requests.some(
        (item) =>
          item.identity?.attemptId === identity.attemptId &&
          JSON.stringify(item.identity) !== JSON.stringify(identity)
      )
    )
      throw Object.assign(new Error('Attempt identity differs from its frozen accounting owner'), {
        code: 'ATTEMPT_IDENTITY_CONFLICT',
      })
    if (
      this.state.limitUsd !== null &&
      this.summary().committedUpperUsd + this.reservationUsd > this.state.limitUsd
    )
      throw Object.assign(new Error('Campaign budget has insufficient unreserved funds'), {
        code: 'CAMPAIGN_BUDGET_EXHAUSTED',
      })
    if (
      this.maxRequestsPerAttempt !== null &&
      this.state.requests.filter((item) => item.identity?.attemptId === identity?.attemptId)
        .length >= this.maxRequestsPerAttempt
    )
      throw Object.assign(new Error('Attempt reached its frozen request limit'), {
        code: 'CAMPAIGN_BUDGET_EXHAUSTED',
      })
    if (
      this.perAttemptBudgetUsd !== null &&
      (!identity ||
        this.summary(identity).committedUpperUsd + this.reservationUsd > this.perAttemptBudgetUsd)
    )
      throw Object.assign(new Error('Attempt reached its frozen cost reservation limit'), {
        code: 'CAMPAIGN_BUDGET_EXHAUSTED',
      })
    const item = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      budgetUsd: this.reservationUsd,
      estimatedUsd: null,
      usage: null,
      status: 'reserved',
      lastByteMs: null,
      lastOutputMs: null,
      lastToolInputMs: null,
      lastReasoningMs: null,
      model: this.model,
      pricing: this.pricing,
      pricingRef: this.pricingRef,
      ...(this.pricingBasis ? { pricingBasis: this.pricingBasis } : {}),
      ...(this.state.upstream ? { upstream: this.state.upstream } : {}),
      metadata,
      ...(identity ? { identity } : {}),
    }
    this.state.requests.push(item)
    this.save()
    return item
  }
  settle(item, usage, status) {
    const upper = usageCost(usage, true, item.pricing)
    item.status = status
    item.finishedAt = new Date().toISOString()
    if (upper !== null) {
      item.usage = usage
      item.estimatedUsd = usageCost(usage, false, item.pricing)
      item.budgetUsd = Math.max(0, upper)
    }
    this.save()
  }
  reject(identity, code) {
    this.state.rejectedRequests ??= []
    this.state.rejectedRequests.push({ identity, code, at: new Date().toISOString() })
    this.save()
  }
  close() {
    closeSync(this.fd)
    unlinkSync(this.lock)
  }
}

export function budgetServer({
  ledger,
  apiKey,
  token,
  upstream = 'https://api.openai.com',
  requireIdentity = true,
  maxConcurrency = 1,
  perAttemptConcurrency = 1,
  maxQueue = 64,
  generationPolicy = null,
  catalogContextTokens = null,
}) {
  if (
    catalogContextTokens !== null &&
    (!Number.isSafeInteger(catalogContextTokens) || catalogContextTokens < 1024)
  )
    throw new Error('Invalid evaluation context allocation')
  if (
    ledger.state.requests.length &&
    (ledger.state.catalogContextTokens ?? null) !== catalogContextTokens
  )
    throw new Error('Existing ledger context allocation differs; use a new ledger directory')
  ledger.state.catalogContextTokens = catalogContextTokens
  generationPolicy = normalizedGenerationPolicy(generationPolicy)
  if (
    ledger.state.requests.length &&
    JSON.stringify(normalizedGenerationPolicy(ledger.state.generationPolicy)) !==
      JSON.stringify(generationPolicy)
  )
    throw new Error('Existing ledger generation policy differs; use a new ledger directory')
  ledger.state.generationPolicy = generationPolicy
  if (ledger.state.limitUsd === null && !requireIdentity)
    throw new Error('Unlimited campaigns require signed attempt identities')
  const endpoint = upstreamEndpoint(upstream)
  if (
    ledger.pricingBasis?.upstreamBaseURL &&
    ledger.pricingBasis.upstreamBaseURL !== endpoint.baseURL
  )
    throw new Error('Pricing basis upstream differs from the configured API root')
  if (ledger.state.upstream && ledger.state.upstream.endpointId !== endpoint.endpointId)
    throw new Error('Existing ledger upstream differs; use a new ledger directory')
  ledger.state.upstream = endpoint
  ledger.save()
  const scheduler = new RequestScheduler({ maxConcurrency, perAttemptConcurrency, maxQueue })
  const authenticationStopped = new AbortController()
  let authenticationBlocker = ledger.state.authenticationBlocker ?? null
  const authenticationError = () =>
    Object.assign(
      new Error(
        'Upstream authentication is blocked; verify new credentials and start a new gateway with a new ledger. Previous tasks are not retried automatically.'
      ),
      { code: 'UPSTREAM_AUTHENTICATION_BLOCKED' }
    )
  if (authenticationBlocker) authenticationStopped.abort(authenticationError())
  const blockAuthentication = (requestId) => {
    if (authenticationBlocker) return
    authenticationBlocker = Object.freeze({
      code: 'UPSTREAM_AUTHENTICATION_BLOCKED',
      upstreamStatus: 401,
      requestId,
      at: new Date().toISOString(),
      scope: 'gateway-upstream-credential',
      recovery: 'verify_new_credentials_then_start_new_gateway_and_ledger',
    })
    // 只唤醒排队等待者，已经派发的 fetch 继续读完并保留真实结算。
    authenticationStopped.abort(authenticationError())
    ledger.state.authenticationBlocker = authenticationBlocker
    ledger.save()
  }
  let activeUpstreamRequests = 0
  const activeAttempts = new Map()
  const activeReservations = new Set()
  const budgetWaiters = new Map()
  // 活跃请求的预占可能在真实结算后释放；已结算且缺用量的预占始终保留。
  const canWaitForBudget = (identity) => {
    if (!activeReservations.size) return false
    const own = ledger.state.requests.filter(
      (item) => item.identity?.attemptId === identity?.attemptId
    )
    if (ledger.maxRequestsPerAttempt !== null && own.length >= ledger.maxRequestsPerAttempt)
      return false
    const afterActive = (rows) =>
      rows
        .filter((item) => !activeReservations.has(item.id))
        .reduce((sum, item) => sum + item.budgetUsd, ledger.reservationUsd)
    return (
      (ledger.state.limitUsd === null ||
        afterActive(ledger.state.requests) <= ledger.state.limitUsd) &&
      (ledger.perAttemptBudgetUsd === null ||
        (identity && afterActive(own) <= ledger.perAttemptBudgetUsd))
    )
  }
  const waitForBudget = (identity, signal) =>
    new Promise((resolve, reject) => {
      const finish = (error) => {
        budgetWaiters.delete(settled)
        signal.removeEventListener('abort', aborted)
        error ? reject(error) : resolve()
      }
      const settled = () => finish()
      const aborted = () => finish(signal.reason)
      budgetWaiters.set(settled, identity?.attemptId)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
    })
  return createServer(async (req, res) => {
    const access = authenticateAttempt(req.headers.authorization, token)
    if (!access) {
      res.writeHead(401)
      res.end()
      return
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          ...ledger.summary(access.identity),
          activeUpstreamRequests: access.identity
            ? (activeAttempts.get(access.identity.attemptId) ?? 0)
            : activeUpstreamRequests,
          budgetWaiters: [...budgetWaiters.values()].filter(
            (id) => !access.identity || id === access.identity.attemptId
          ).length,
          activeModelDiscoveryRequests: (ledger.state.discoveryRequests ?? []).filter(
            (item) =>
              item.status === 'running' &&
              (!access.identity || item.identity?.attemptId === access.identity.attemptId)
          ).length,
          attribution: requireIdentity ? 'signed-attempt-v1' : 'mixed-legacy-v1',
          upstream: endpoint,
          authenticationBlocker,
          scheduler: scheduler.summary(access.identity?.attemptId),
          generationPolicy,
        })
      )
      return
    }
    if (requireIdentity && !access.identity) {
      res.writeHead(403)
      res.end(JSON.stringify({ error: 'ATTEMPT_IDENTITY_REQUIRED' }))
      return
    }
    // 原生客户端在模型请求前读取远端目录。只读发现单列记账，不能冒充模型用量或放宽付费模型。
    if (req.method === 'GET' && req.url === '/v1/models') {
      const record = {
        id: 'discovery-' + randomUUID(),
        identity: access.identity,
        startedAt: new Date().toISOString(),
        status: 'running',
      }
      ledger.state.discoveryRequests ??= []
      ledger.state.discoveryRequests.push(record)
      ledger.save()
      try {
        if (authenticationBlocker) throw authenticationError()
        const response = await fetch(endpoint.baseURL + '/models', {
          headers: { authorization: 'Bearer ' + apiKey },
          signal: AbortSignal.timeout(30_000),
        })
        record.upstreamStatus = response.status
        if (response.status === 401) blockAuthentication(record.id)
        if (!response.ok) {
          record.status = 'failed'
          res.writeHead(response.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'UPSTREAM_MODEL_DISCOVERY_FAILED' }))
        } else {
          const value = await response.json()
          if (!Array.isArray(value.data)) throw new Error('Invalid upstream model catalog')
          const data = value.data
            .filter((model) => model?.id === ledger.model)
            .map((model) =>
              catalogContextTokens === null
                ? model
                : {
                    ...model,
                    context_length: catalogContextTokens,
                    context_window: catalogContextTokens,
                  }
            )
          record.contextAllocation =
            catalogContextTokens === null
              ? null
              : {
                  kind: 'evaluation-resource-cap',
                  tokens: catalogContextTokens,
                  nativeModelCapacity: 'not-inferred',
                }
          record.status = 'completed'
          record.modelCount = data.length
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ object: 'list', data }))
        }
      } catch (error) {
        record.status = 'failed'
        record.errorCode = safeErrorCode(error.code) ?? 'MODEL_DISCOVERY_FAILED'
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: record.errorCode }))
      } finally {
        record.endedAt = new Date().toISOString()
        ledger.save()
      }
      return
    }
    if (access.identity && access.identity.phase !== 'source') {
      ledger.reject(access.identity, 'MODEL_DISPATCH_NOT_ALLOWED_IN_THIS_PHASE')
      res.writeHead(403)
      res.end(JSON.stringify({ error: 'MODEL_DISPATCH_NOT_ALLOWED_IN_THIS_PHASE' }))
      return
    }
    if (req.method !== 'POST' || !['/v1/responses', '/v1/chat/completions'].includes(req.url)) {
      res.writeHead(404)
      res.end()
      return
    }
    let reservation,
      usage = null,
      upstreamStatus = null,
      upstreamStarted,
      releaseDispatch,
      streamState
    let responseInterruptedByGateway = false
    const disconnected = new AbortController()
    const onDisconnect = () => {
      disconnected.abort()
      if (reservation && !res.writableFinished && !responseInterruptedByGateway) {
        reservation.clientDisconnectedAt ??= new Date().toISOString()
        ledger.save()
      }
    }
    res.once('close', onDisconnect)
    try {
      if (authenticationBlocker) throw authenticationError()
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 16 * 1024 * 1024) throw new Error('Request exceeds gateway size limit')
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (body.model !== ledger.model)
        throw new Error(`This campaign only authorizes ${ledger.model}`)
      if (ledger.reasoningEffort) {
        const requestedEffort = body.reasoning?.effort ?? body.reasoning_effort
        if (requestedEffort && requestedEffort !== ledger.reasoningEffort)
          throw new Error('Reasoning effort differs from the frozen campaign')
        if (req.url === '/v1/responses')
          body.reasoning = { ...body.reasoning, effort: ledger.reasoningEffort }
        else body.reasoning_effort = ledger.reasoningEffort
      }
      if (body.tools?.some((tool) => !isLocalTool(tool)))
        throw new Error('Hosted paid tools are outside this campaign')
      const clientWireOptions = generationPolicy ? observedWireOptions(body) : undefined
      const limitKey = req.url === '/v1/responses' ? 'max_output_tokens' : 'max_completion_tokens'
      const requestedOutputLimit = body[limitKey] ?? body.max_tokens ?? 32768
      if (
        !Number.isInteger(requestedOutputLimit) ||
        requestedOutputLimit < 1 ||
        requestedOutputLimit > 128000
      )
        throw new Error('Invalid output limit')
      if (generationPolicy && req.url !== '/v1/responses')
        throw new Error('Frozen generation policy requires the Responses endpoint')
      const outputLimit = generationPolicy
        ? Math.min(requestedOutputLimit, generationPolicy.maxOutputTokens)
        : requestedOutputLimit
      if (ledger.reservationOutputTokens !== null && outputLimit > ledger.reservationOutputTokens)
        throw new Error('Request output limit exceeds the frozen reservation bound')
      if (generationPolicy) {
        body.reasoning = {
          ...body.reasoning,
          context: generationPolicy.reasoningContext,
          summary: generationPolicy.reasoningSummary,
        }
        body.text = { ...body.text, verbosity: generationPolicy.textVerbosity }
      }
      body[limitKey] = outputLimit
      delete body.max_tokens
      if (body.service_tier && body.service_tier !== 'default')
        throw new Error('This pricing snapshot only authorizes the default service tier')
      body.service_tier = 'default'
      body.store = false
      if (body.stream && req.url.endsWith('/chat/completions'))
        body.stream_options = { ...body.stream_options, include_usage: true }
      // 槽位绑定真实上游请求；客户端断开仅移除排队者，已派发请求继续结算。
      const queuedAt = performance.now()
      releaseDispatch = await scheduler.acquire(
        access.identity?.attemptId ?? 'legacy-controller',
        AbortSignal.any([disconnected.signal, authenticationStopped.signal])
      )
      if (res.destroyed) return
      if (authenticationBlocker) throw authenticationError()
      const reserve = () =>
        ledger.reserve(
          {
            endpoint: req.url,
            reasoningEffort: body.reasoning?.effort ?? body.reasoning_effort ?? null,
            outputLimit,
            ...(generationPolicy ? { requestedOutputLimit, clientWireOptions } : {}),
            serviceTier: body.service_tier,
            stream: Boolean(body.stream),
            // 在网关规范化之后观察；仅作比较证据，不改变实际模型请求。
            wireOptions: observedWireOptions(body),
            inputItems: (body.input ?? body.messages)?.length ?? null,
            cacheKeyHash:
              typeof body.prompt_cache_key === 'string'
                ? createHash('sha256').update(body.prompt_cache_key).digest('hex')
                : null,
            explicitCacheBreakpoints: Array.isArray(body.input)
              ? body.input.reduce(
                  (count, item) =>
                    count +
                    (Array.isArray(item.content)
                      ? item.content.filter((part) => part.prompt_cache_breakpoint).length
                      : 0),
                  0
                )
              : null,
          },
          access.identity
        )
      const admissionSignal = AbortSignal.any([disconnected.signal, authenticationStopped.signal])
      for (;;) {
        admissionSignal.throwIfAborted()
        try {
          reservation = reserve()
          break
        } catch (error) {
          if (error.code !== 'CAMPAIGN_BUDGET_EXHAUSTED' || !canWaitForBudget(access.identity))
            throw error
          await waitForBudget(access.identity, admissionSignal)
        }
      }
      reservation.queueWaitMs = performance.now() - queuedAt
      activeReservations.add(reservation.id)
      activeUpstreamRequests++
      if (access.identity)
        activeAttempts.set(
          access.identity.attemptId,
          (activeAttempts.get(access.identity.attemptId) ?? 0) + 1
        )
      const started = performance.now()
      upstreamStarted = started
      // 客户端退出后仍读完供应商回执以结算；只记录用量，不把请求正文或凭据写进费用账。
      const response = await fetch(`${endpoint.baseURL}${req.url.slice('/v1'.length)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      })
      upstreamStatus = response.status
      if (upstreamStatus === 401) blockAuthentication(reservation.id)
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-cache',
      })
      if (body.stream && response.ok) {
        streamState = {
          receivedBytes: 0,
          events: 0,
          terminalEvent: null,
          terminalStatus: null,
          effectiveReasoningContext: { state: 'unobserved' },
          firstTerminalMs: null,
          terminalMs: null,
          transportEnded: null,
          transportEndedMs: null,
        }
        reservation.stream = streamState
      }
      let pending = ''
      let eventData = [],
        eventName = '',
        invalidEvent = false
      const decoder = new TextDecoder()
      const terminal = (event, status, response) => {
        const observed = performance.now() - started
        streamState.firstTerminalMs ??= observed
        streamState.terminalMs = observed
        streamState.terminalEvent = event
        streamState.terminalStatus = status
        streamState.effectiveReasoningContext = observedOption(response?.reasoning, 'context', [
          'current_turn',
          'all_turns',
        ])
      }
      const inspect = (text, event = '') => {
        if (streamState) {
          streamState.events++
          if (text === '[DONE]') {
            if (
              req.url.endsWith('/chat/completions') &&
              !['failed', 'incomplete'].includes(streamState.terminalStatus)
            ) {
              terminal('[DONE]', 'completed')
            }
            return
          }
        }
        try {
          const record = JSON.parse(text)
          if (streamState) {
            const type = record?.type ?? event
            if (type === 'response.failed' || type === 'error' || record?.error) {
              terminal(type === 'response.failed' ? type : 'error', 'failed', record.response)
              streamState.terminalFailure ??= observedTerminalFailure(record, [apiKey, token])
            } else if (type === 'response.incomplete' && streamState.terminalStatus !== 'failed') {
              terminal(type, 'incomplete', record.response)
            } else if (
              type === 'response.completed' &&
              req.url === '/v1/responses' &&
              !['failed', 'incomplete'].includes(streamState.terminalStatus)
            ) {
              terminal(type, 'completed', record.response)
            }
          }
          const delta = record.choices?.[0]?.delta
          if (
            record.type === 'response.function_call_arguments.delta' ||
            record.type === 'response.custom_tool_call_input.delta' ||
            delta?.tool_calls?.some((call) => call.function?.arguments)
          ) {
            const observed = performance.now() - started
            reservation.firstToolInputMs ??= observed
            reservation.lastToolInputMs = observed
          }
          if (record.type === 'response.output_text.delta' || delta?.content) {
            const observed = performance.now() - started
            reservation.firstOutputMs ??= observed
            reservation.lastOutputMs = observed
          }
          if (
            record.type === 'response.reasoning_summary_text.delta' ||
            delta?.reasoning_content ||
            delta?.reasoning
          ) {
            const observed = performance.now() - started
            reservation.firstReasoningMs ??= observed
            reservation.lastReasoningMs = observed
          }
          if (record.usage) usage = record.usage
          if (record.response?.usage) usage = record.response.usage
        } catch {
          if (streamState) invalidEvent = true
        }
      }
      const inspectLine = (line) => {
        if (line === '') {
          if (eventData.length) inspect(eventData.join('\n'), eventName)
          eventData = []
          eventName = ''
        } else if (line.startsWith('data:')) eventData.push(line.slice(5).replace(/^ /u, ''))
        else if (line.startsWith('event:')) eventName = line.slice(6).replace(/^ /u, '')
      }
      const consume = (text, final = false) => {
        pending += text
        if (!streamState) return
        let offset = 0
        for (let index = 0; index < pending.length; index++) {
          const char = pending[index]
          if (char !== '\r' && char !== '\n') continue
          if (char === '\r' && index + 1 === pending.length && !final) break
          inspectLine(pending.slice(offset, index))
          if (char === '\r' && pending[index + 1] === '\n') index++
          offset = index + 1
        }
        pending = pending.slice(offset)
      }
      for await (const chunk of response.body) {
        const observed = performance.now() - started
        reservation.firstByteMs ??= observed
        if (chunk.byteLength > 0) reservation.lastByteMs = observed
        if (streamState) streamState.receivedBytes += chunk.byteLength
        if (!res.destroyed) res.write(chunk)
        consume(decoder.decode(chunk, { stream: true }))
      }
      consume(decoder.decode(), true)
      if (streamState) {
        streamState.transportEnded = 'eof'
        streamState.transportEndedMs = performance.now() - started
        // SSE 事件须由空行提交；EOF 尾部的半个事件不能证明模型完整结束。
        if (invalidEvent || streamState.terminalStatus !== 'completed') {
          const code = invalidEvent
            ? 'UPSTREAM_STREAM_INVALID_EVENT'
            : streamState.terminalStatus === 'failed'
              ? 'UPSTREAM_STREAM_FAILED'
              : streamState.terminalStatus === 'incomplete'
                ? 'UPSTREAM_STREAM_INCOMPLETE'
                : 'UPSTREAM_STREAM_TRUNCATED'
          throw Object.assign(new Error('Upstream stream did not complete successfully'), { code })
        }
      } else inspect(pending)
      reservation.durationMs = performance.now() - started
      ledger.settle(reservation, usage, `http-${upstreamStatus}`)
      res.end()
    } catch (error) {
      const failure = {
        name: safeErrorCode(error?.name),
        code: safeErrorCode(error?.code),
        causeName: safeErrorCode(error?.cause?.name),
        causeCode: safeErrorCode(error?.cause?.code),
        upstreamStatus,
      }
      const timedOut =
        failure.name === 'TimeoutError' ||
        ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(
          failure.causeCode
        )
      const exhausted = failure.code === 'CAMPAIGN_BUDGET_EXHAUSTED'
      const overloaded = failure.code === 'GATEWAY_QUEUE_FULL'
      const authenticationBlocked = failure.code === 'UPSTREAM_AUTHENTICATION_BLOCKED'
      if (reservation) {
        if (streamState) {
          streamState.transportEnded ??= 'interrupted'
          streamState.transportEndedMs ??= performance.now() - upstreamStarted
        }
        reservation.failure = failure
        if (upstreamStarted !== undefined)
          reservation.durationMs = performance.now() - upstreamStarted
        ledger.settle(
          reservation,
          usage,
          upstreamStatus ? `http-${upstreamStatus}-interrupted` : 'unknown'
        )
      }
      if (!reservation && (access.identity || authenticationBlocked))
        ledger.reject(
          access.identity,
          overloaded
            ? 'GATEWAY_QUEUE_FULL'
            : disconnected.signal.aborted
              ? 'QUEUED_CLIENT_CANCELLED'
              : (failure.code ?? 'CAMPAIGN_VALIDATION')
        )
      const status = reservation
        ? timedOut
          ? 504
          : 502
        : authenticationBlocked
          ? 403
          : exhausted
            ? 402
            : overloaded
              ? 429
              : 400
      // 已发送 200/SSE 后，普通 JSON 尾巴会被 SSE 客户端忽略并伪装成正常 EOF。
      if (res.headersSent) {
        responseInterruptedByGateway = true
        if (!res.destroyed) res.destroy()
        return
      }
      res.writeHead(status, { 'content-type': 'application/json' })
      if (!res.destroyed)
        res.end(
          JSON.stringify({
            error: {
              message: reservation
                ? timedOut
                  ? 'Upstream request timed out'
                  : 'Upstream request failed'
                : error.message,
              type: reservation
                ? 'upstream_transport'
                : authenticationBlocked
                  ? 'upstream_authentication'
                  : exhausted
                    ? 'campaign_budget'
                    : overloaded
                      ? 'gateway_capacity'
                      : 'campaign_validation',
              code: reservation
                ? timedOut
                  ? 'UPSTREAM_TIMEOUT'
                  : 'UPSTREAM_TRANSPORT'
                : authenticationBlocked
                  ? 'UPSTREAM_AUTHENTICATION_BLOCKED'
                  : exhausted
                    ? 'CAMPAIGN_STOP'
                    : overloaded
                      ? 'GATEWAY_QUEUE_FULL'
                      : 'CAMPAIGN_VALIDATION',
            },
          })
        )
    } finally {
      if (reservation) {
        activeReservations.delete(reservation.id)
        activeUpstreamRequests--
        if (access.identity) {
          const remaining = (activeAttempts.get(access.identity.attemptId) ?? 1) - 1
          if (remaining) activeAttempts.set(access.identity.attemptId, remaining)
          else activeAttempts.delete(access.identity.attemptId)
        }
      }
      res.removeListener('close', onDisconnect)
      releaseDispatch?.()
      for (const settled of [...budgetWaiters.keys()]) settled()
    }
  })
}

async function main() {
  const { values } = parseArgs({
    options: {
      directory: { type: 'string' },
      'desktop-config': { type: 'string' },
      'upstream-url': { type: 'string' },
      port: { type: 'string', default: '48761' },
      budget: { type: 'string', default: '1000' },
      'allow-budget-change': { type: 'boolean', default: false },
      model: { type: 'string', default: campaignModel },
      'reasoning-effort': { type: 'string', default: 'high' },
      'pricing-file': { type: 'string' },
      'generation-policy-file': { type: 'string' },
      'max-concurrency': { type: 'string', default: '1' },
      'per-attempt-concurrency': { type: 'string', default: '1' },
      'max-queue': { type: 'string', default: '64' },
    },
  })
  if (!values.directory || !values['desktop-config'])
    throw new Error('--directory and --desktop-config are required')
  const config = JSON.parse(readFileSync(values['desktop-config'], 'utf8')).chat
  const upstream = authorizedUpstream(config.baseURL, values['upstream-url'])
  if (typeof config.apiKey !== 'string' || !config.apiKey.trim())
    throw new Error('Configured upstream credentials are required')
  const directory = resolve(values.directory)
  const pricingBytes = values['pricing-file'] ? readFileSync(values['pricing-file'], 'utf8') : null
  const frozenPricing = pricingBytes
    ? JSON.parse(pricingBytes)
    : { model: campaignModel, pricing: campaignPricing, reference: 'openai-standard-2026-09-28' }
  if (frozenPricing.model !== values.model)
    throw new Error('--model must match the frozen --pricing-file model')
  if (
    frozenPricing.reasoning_effort &&
    frozenPricing.reasoning_effort !== values['reasoning-effort']
  )
    throw new Error('Reasoning effort differs from the pricing/model snapshot')
  const pricing = frozenPricing.pricing ?? {
    input: frozenPricing.input,
    cached: frozenPricing.cachedInput,
    write: frozenPricing.cacheWriteInput,
    output: frozenPricing.output,
    longThreshold: frozenPricing.longThreshold,
    longInputMultiplier: frozenPricing.longInputMultiplier,
    longOutputMultiplier: frozenPricing.longOutputMultiplier,
  }
  const reference = pricingBytes
    ? `${frozenPricing.source ?? frozenPricing.reference}#sha256=${createHash('sha256').update(pricingBytes).digest('hex')}`
    : frozenPricing.reference
  const ledger = new BudgetLedger(
    directory,
    values.budget === 'unlimited' ? 'unlimited' : Number(values.budget),
    {
      allowLimitChange: values['allow-budget-change'],
      model: values.model,
      pricing,
      pricingRef: reference,
      reasoningEffort: values['reasoning-effort'],
      pricingBasis: frozenPricing.pricingBasis,
    }
  )
  const token = randomBytes(32).toString('hex')
  writeFileSync(join(directory, 'gateway-token'), token, { mode: 0o600 })
  const server = budgetServer({
    ledger,
    apiKey: config.apiKey,
    token,
    upstream,
    requireIdentity: true,
    maxConcurrency: Number(values['max-concurrency']),
    perAttemptConcurrency: Number(values['per-attempt-concurrency']),
    maxQueue: Number(values['max-queue']),
    generationPolicy: values['generation-policy-file']
      ? JSON.parse(readFileSync(values['generation-policy-file'], 'utf8'))
      : null,
  })
  server.listen(Number(values.port), '0.0.0.0', () =>
    console.log(JSON.stringify({ port: Number(values.port), ...ledger.summary() }))
  )
  const close = () =>
    server.close(() => {
      ledger.close()
      process.exit(0)
    })
  process.once('SIGTERM', close)
  process.once('SIGINT', close)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
