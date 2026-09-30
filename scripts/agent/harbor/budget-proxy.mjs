import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
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

// 每次请求先持久预占 20 美元：高于官方最大上下文和输出在 standard 长上下文费率下的费用。
// 断流没有 usage 时保留预占；进程重启也不返还。第二个进程不得共用同一本账。
export class BudgetLedger {
  constructor(directory, limitUsd = 1000) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > 1000)
      throw new Error('Budget must be in (0, 1000] USD')
    mkdirSync(directory, { recursive: true })
    this.path = join(directory, 'budget.json')
    this.lock = join(directory, 'budget.lock')
    this.fd = openSync(this.lock, 'wx', 0o600)
    this.state = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, 'utf8'))
      : { schema: 2, limitUsd, requests: [] }
    if (this.state.limitUsd !== limitUsd) {
      this.close()
      throw new Error('Existing campaign budget differs')
    }
    this.save()
  }
  save() {
    writeFileSync(`${this.path}.writing`, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    renameSync(`${this.path}.writing`, this.path)
  }
  summary() {
    return {
      limitUsd: this.state.limitUsd,
      model: campaignModel,
      estimatedKnownUsd: this.state.requests.reduce(
        (sum, item) => sum + (item.estimatedUsd ?? 0),
        0
      ),
      committedUpperUsd: this.state.requests.reduce((sum, item) => sum + item.budgetUsd, 0),
      requests: this.state.requests.length,
      unknownUsage: this.state.requests.filter((item) => item.estimatedUsd === null).length,
    }
  }
  reserve(metadata = {}) {
    if (this.summary().committedUpperUsd + 20 > this.state.limitUsd)
      throw Object.assign(new Error('Campaign budget has insufficient unreserved funds'), {
        code: 'CAMPAIGN_BUDGET_EXHAUSTED',
      })
    const item = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      budgetUsd: 20,
      estimatedUsd: null,
      usage: null,
      status: 'reserved',
      model: campaignModel,
      pricing: campaignPricing,
      metadata,
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
  close() {
    closeSync(this.fd)
    unlinkSync(this.lock)
  }
}

export function budgetServer({ ledger, apiKey, token, upstream = 'https://api.openai.com' }) {
  let dispatchTail = Promise.resolve()
  let activeUpstreamRequests = 0
  return createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401)
      res.end()
      return
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ...ledger.summary(), activeUpstreamRequests }))
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
      releaseDispatch
    try {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 16 * 1024 * 1024) throw new Error('Request exceeds gateway size limit')
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (body.model !== campaignModel)
        throw new Error(`This campaign only authorizes ${campaignModel}`)
      if (body.tools?.some((tool) => !isLocalTool(tool)))
        throw new Error('Hosted paid tools are outside this campaign')
      const limitKey = req.url === '/v1/responses' ? 'max_output_tokens' : 'max_completion_tokens'
      const outputLimit = body[limitKey] ?? body.max_tokens ?? 32768
      if (!Number.isInteger(outputLimit) || outputLimit < 1 || outputLimit > 128000)
        throw new Error('Invalid output limit')
      body[limitKey] = outputLimit
      delete body.max_tokens
      body.service_tier = 'default'
      body.store = false
      if (body.stream && req.url.endsWith('/chat/completions'))
        body.stream_options = { ...body.stream_options, include_usage: true }
      // Even after a trial disconnects, its provider request may still be settling.
      // Serialize actual upstream work across every agent in the campaign.
      const queuedAt = performance.now()
      const preceding = dispatchTail
      dispatchTail = new Promise((resolve) => {
        releaseDispatch = resolve
      })
      await preceding
      if (res.destroyed) return
      reservation = ledger.reserve({
        endpoint: req.url,
        reasoningEffort: body.reasoning?.effort ?? body.reasoning_effort ?? null,
        outputLimit,
        stream: Boolean(body.stream),
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
      })
      reservation.queueWaitMs = performance.now() - queuedAt
      activeUpstreamRequests++
      const started = performance.now()
      upstreamStarted = started
      // 客户端退出后仍读完供应商回执以结算；只记录用量，不把请求正文或凭据写进费用账。
      const response = await fetch(`${upstream}${req.url}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      })
      upstreamStatus = response.status
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-cache',
      })
      let pending = ''
      const decoder = new TextDecoder()
      const inspect = (text) => {
        try {
          const record = JSON.parse(text)
          const delta = record.choices?.[0]?.delta
          if (
            (record.type === 'response.function_call_arguments.delta' ||
              record.type === 'response.custom_tool_call_input.delta' ||
              delta?.tool_calls?.some((call) => call.function?.arguments)) &&
            reservation.firstToolInputMs === undefined
          )
            reservation.firstToolInputMs = performance.now() - started
          if (
            (record.type === 'response.output_text.delta' || delta?.content) &&
            reservation.firstOutputMs === undefined
          )
            reservation.firstOutputMs = performance.now() - started
          if (
            (record.type === 'response.reasoning_summary_text.delta' ||
              delta?.reasoning_content ||
              delta?.reasoning) &&
            reservation.firstReasoningMs === undefined
          )
            reservation.firstReasoningMs = performance.now() - started
          if (record.usage) usage = record.usage
          if (record.response?.usage) usage = record.response.usage
        } catch {
          /* SSE 空行、注释和 [DONE] 不包含 JSON 用量。 */
        }
      }
      for await (const chunk of response.body) {
        reservation.firstByteMs ??= performance.now() - started
        if (!res.destroyed) res.write(chunk)
        pending += decoder.decode(chunk, { stream: true })
        if (body.stream) {
          const lines = pending.split('\n')
          pending = lines.pop()
          for (const line of lines) if (line.startsWith('data:')) inspect(line.slice(5).trim())
        }
      }
      pending += decoder.decode()
      if (body.stream) {
        if (pending.startsWith('data:')) inspect(pending.slice(5).trim())
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
      if (reservation) {
        reservation.failure = failure
        if (upstreamStarted !== undefined)
          reservation.durationMs = performance.now() - upstreamStarted
        ledger.settle(
          reservation,
          usage,
          upstreamStatus ? `http-${upstreamStatus}-interrupted` : 'unknown'
        )
      }
      const status = reservation ? (timedOut ? 504 : 502) : exhausted ? 429 : 400
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' })
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
                : exhausted
                  ? 'campaign_budget'
                  : 'campaign_validation',
              code: reservation
                ? timedOut
                  ? 'UPSTREAM_TIMEOUT'
                  : 'UPSTREAM_TRANSPORT'
                : exhausted
                  ? 'CAMPAIGN_STOP'
                  : 'CAMPAIGN_VALIDATION',
            },
          })
        )
    } finally {
      if (reservation) activeUpstreamRequests--
      releaseDispatch?.()
    }
  })
}

async function main() {
  const { values } = parseArgs({
    options: {
      directory: { type: 'string' },
      'desktop-config': { type: 'string' },
      port: { type: 'string', default: '48761' },
      budget: { type: 'string', default: '1000' },
    },
  })
  if (!values.directory || !values['desktop-config'])
    throw new Error('--directory and --desktop-config are required')
  const config = JSON.parse(readFileSync(values['desktop-config'], 'utf8')).chat
  if (new URL(config.baseURL).origin !== 'https://api.openai.com' || !config.apiKey)
    throw new Error('Expected configured official OpenAI endpoint')
  const directory = resolve(values.directory)
  const ledger = new BudgetLedger(directory, Number(values.budget))
  const token = randomBytes(32).toString('hex')
  writeFileSync(join(directory, 'gateway-token'), token, { mode: 0o600 })
  const server = budgetServer({ ledger, apiKey: config.apiKey, token })
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
