import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import * as proxy from './budget-proxy.mjs'
import { attemptCredential } from './request-identity.mjs'

const identity = (id) => ({
  campaignId: 'authentication-fixture',
  candidateId: 'candidate',
  participantId: 'agent',
  taskId: id,
  attemptId: id,
  jobId: id,
  phase: 'source',
})
const usage = {
  input_tokens: 10,
  output_tokens: 2,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
}
const generationPolicy = {
  maxOutputTokens: 12000,
  reasoningContext: 'all_turns',
  reasoningSummary: 'auto',
  textVerbosity: 'medium',
}

test('frozen generation resources are shared on the wire while original client choices remain auditable', async (t) => {
  const seen = []
  const f = await fixture(
    t,
    async (body, res) => {
      seen.push(body)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ usage }))
    },
    { generationPolicy }
  )
  const bodies = [
    {
      max_output_tokens: 12000,
      reasoning: { effort: 'high', summary: 'auto' },
      text: { format: { type: 'text' } },
    },
    {
      max_output_tokens: 32768,
      reasoning: { effort: 'high', context: 'all_turns' },
      text: { verbosity: 'low' },
    },
  ]
  for (const [index, body] of bodies.entries()) {
    const response = await f.send('paired-' + index, undefined, '/v1/responses', body)
    assert.equal(response.status, 200)
    await response.text()
  }
  await until(
    () => f.ledger.state.requests.length === 2 && f.ledger.state.requests.every((r) => r.finishedAt)
  )
  for (const body of seen) {
    assert.equal(body.max_output_tokens, 12000)
    assert.deepEqual(body.reasoning, { effort: 'high', context: 'all_turns', summary: 'auto' })
    assert.equal(body.text.verbosity, 'medium')
  }
  assert.deepEqual(seen[0].text.format, { type: 'text' })
  assert.deepEqual(
    f.ledger.state.requests.map((r) => r.metadata.requestedOutputLimit),
    [12000, 32768]
  )
  assert.deepEqual(
    f.ledger.state.requests.map((r) => r.metadata.outputLimit),
    [12000, 12000]
  )
  assert.deepEqual(f.ledger.state.requests[0].metadata.clientWireOptions.textVerbosity, {
    state: 'absent',
  })
  assert.deepEqual(f.ledger.state.requests[1].metadata.clientWireOptions.textVerbosity, {
    state: 'value',
    value: 'low',
  })
  assert.deepEqual((await f.health()).generationPolicy, generationPolicy)
  assert.throws(
    () =>
      proxy.budgetServer({
        ledger: f.ledger,
        apiKey: 'mock',
        token: 'mock',
        generationPolicy: null,
      }),
    /generation policy differs/
  )
  assert.deepEqual(f.ledger.state.generationPolicy, generationPolicy)
})

test('invalid generation policies and incompatible endpoints cannot dispatch model requests', async (t) => {
  for (const value of [
    { ...generationPolicy, maxOutputTokens: 0 },
    { ...generationPolicy, maxOutputTokens: 1.5 },
    { ...generationPolicy, maxOutputTokens: 128001 },
    { ...generationPolicy, reasoningContext: 'unrecognized' },
    { ...generationPolicy, textVerbosity: 'unrecognized' },
    { ...generationPolicy, apiKey: 'must-not-be-stored' },
  ])
    assert.throws(() => proxy.normalizedGenerationPolicy(value), /Invalid/)
  let calls = 0
  const f = await fixture(
    t,
    async (_body, res) => {
      calls++
      res.end('{}')
    },
    { generationPolicy }
  )
  const response = await f.send('incompatible', undefined, '/v1/chat/completions')
  assert.equal(response.status, 400)
  await response.text()
  assert.equal(calls, 0)
  assert.equal(f.ledger.state.requests.length, 0)
})
async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Mock condition was not reached')
}
async function fixture(t, handle, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-authentication-'))
  const ledger = new proxy.BudgetLedger(directory, 'unlimited')
  const cleanup = []
  const upstream = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    await handle(JSON.parse(raw || '{}'), res, req)
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const baseURL = `http://127.0.0.1:${upstream.address().port}/v1`
  const gateway = proxy
    .budgetServer({
      ledger,
      apiKey: 'mock-provider-key',
      token: 'mock-signing-key',
      upstream: baseURL,
      ...options,
    })
    .listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  const url = `http://127.0.0.1:${gateway.address().port}`
  const headers = (id) => ({
    authorization: `Bearer ${attemptCredential(identity(id), 'mock-signing-key')}`,
  })
  t.after(async () => {
    for (const close of cleanup) close()
    gateway.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([new Promise((r) => gateway.close(r)), new Promise((r) => upstream.close(r))])
    await until(() => ledger.state.requests.every((r) => r.finishedAt))
    ledger.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    ledger,
    directory,
    gateway,
    baseURL,
    cleanup,
    send: (id, signal, endpoint = '/v1/responses', body = {}) =>
      fetch(url + endpoint, {
        method: 'POST',
        headers: headers(id),
        signal,
        body: JSON.stringify({
          model: proxy.campaignModel,
          input: id,
          stream: id === 'late',
          ...body,
        }),
      }),
    health: () =>
      fetch(url + '/health', { headers: { authorization: 'Bearer mock-signing-key' } }).then((r) =>
        r.json()
      ),
    catalog: (id, phase = 'source') =>
      fetch(url + '/v1/models', {
        headers: {
          authorization:
            'Bearer ' + attemptCredential({ ...identity(id), phase }, 'mock-signing-key'),
        },
      }),
  }
}

test('remote catalog is identity-bound, restricted to the frozen model and separate from paid usage', async (t) => {
  const seen = []
  const f = await fixture(
    t,
    async (_body, res, req) => {
      seen.push(req.url)
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          data: [{ id: proxy.campaignModel, context_length: 128000 }, { id: 'other-model' }],
        })
      )
    },
    { requireIdentity: true }
  )
  const response = await f.catalog('discovery', 'install')
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data, [
    { id: proxy.campaignModel, context_length: 128000 },
  ])
  assert.deepEqual(seen, ['/v1/models'])
  assert.equal(f.ledger.state.requests.length, 0)
  assert.equal(f.ledger.state.discoveryRequests.length, 1)
  assert.equal(f.ledger.state.discoveryRequests[0].identity.phase, 'install')
  assert.equal(f.ledger.state.discoveryRequests[0].status, 'completed')
  assert.equal((await f.health()).activeModelDiscoveryRequests, 0)
  assert.equal(JSON.stringify(f.ledger.state).includes('mock-provider-key'), false)
})

test('catalog authentication failure blocks subsequent paid work without reserving model usage', async (t) => {
  let calls = 0
  const f = await fixture(
    t,
    async (_body, res) => {
      calls++
      res.writeHead(401)
      res.end('provider-private-error')
    },
    { requireIdentity: true }
  )
  assert.equal((await f.catalog('catalog-auth')).status, 401)
  const blocked = await f.send('source-after-discovery')
  assert.equal(blocked.status, 403)
  assert.equal((await blocked.json()).error.code, 'UPSTREAM_AUTHENTICATION_BLOCKED')
  assert.equal(calls, 1)
  assert.equal(f.ledger.state.requests.length, 0)
  assert.equal(f.ledger.state.discoveryRequests[0].status, 'failed')
  assert.equal(
    (await f.health()).authenticationBlocker.requestId,
    f.ledger.state.discoveryRequests[0].id
  )
  assert.equal(JSON.stringify(f.ledger.state).includes('provider-private-error'), false)
})

test('unfinished catalog discovery remains visible until physical settlement', async (t) => {
  let release
  const f = await fixture(
    t,
    async (_body, res) => {
      await new Promise((resolve) => {
        release = resolve
      })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [] }))
    },
    { requireIdentity: true }
  )
  f.cleanup.push(() => release?.())
  const pending = f.catalog('held-catalog')
  await until(() => release)
  assert.equal((await f.health()).activeModelDiscoveryRequests, 1)
  assert.equal(f.ledger.state.requests.length, 0)
  release()
  assert.equal((await pending).status, 200)
  assert.equal((await f.health()).activeModelDiscoveryRequests, 0)
})

test('401 blocks queued and subsequent attempts at headers while dispatched work settles independently', async (t) => {
  const seen = []
  let authHeaders, authBody, lateBody
  const f = await fixture(
    t,
    async (body, res, req) => {
      seen.push(body.input)
      if (body.input === 'auth') {
        await new Promise((r) => {
          authHeaders = r
        })
        res.writeHead(401, { 'content-type': 'application/json' })
        res.flushHeaders()
        await new Promise((r) => {
          authBody = r
        })
        res.end(
          JSON.stringify({ error: { code: 'invalid_api_key', message: 'mock-provider-key' } })
        )
      } else if (body.input === 'late') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"type":"response.created"}\n\n')
        await new Promise((r) => {
          lateBody = r
        })
        res.end(`data: ${JSON.stringify({ response: { usage } })}\n\n`)
      } else res.end(JSON.stringify({ usage }))
    },
    { maxConcurrency: 2, perAttemptConcurrency: 1 }
  )
  f.cleanup.push(() => {
    authHeaders?.()
    authBody?.()
    lateBody?.()
  })
  const cancelled = new AbortController()
  await f.send('late', cancelled.signal)
  cancelled.abort()
  const auth = f.send('auth')
  await until(() => authHeaders)
  const queued = ['queued-a', 'queued-b'].map((id) => f.send(id))
  await until(async () => (await f.health()).scheduler.queued === 2)
  authHeaders()
  await until(async () => Boolean((await f.health()).authenticationBlocker))
  const blocked = await Promise.all(queued)
  blocked.push(await f.send('retry', undefined, '/v1/chat/completions'))
  for (const response of blocked) {
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'UPSTREAM_AUTHENTICATION_BLOCKED')
  }
  assert.deepEqual(seen, ['late', 'auth'])
  const active = await f.health()
  assert.equal(active.activeUpstreamRequests, 2)
  assert.equal(active.scheduler.queued, 0)
  assert.equal(active.rejectedRequests, 3)
  assert.equal(active.authenticationBlocker.upstreamStatus, 401)
  assert.equal(active.upstream.baseURL, f.baseURL)
  assert.match(active.upstream.endpointId, /^[a-f0-9]{64}$/)
  lateBody()
  authBody()
  assert.equal((await auth).status, 401)
  await (await auth).text()
  await until(async () => (await f.health()).activeUpstreamRequests === 0)
  assert.equal(f.ledger.state.requests.length, 2)
  const billed = f.ledger.state.requests.find((r) => r.identity.attemptId === 'late')
  assert.equal(billed.estimatedUsd, proxy.usageCost(usage))
  const failed = f.ledger.state.requests.find((r) => r.identity.attemptId === 'auth')
  assert.equal(failed.status, 'http-401')
  assert.equal(failed.estimatedUsd, null)
  assert.equal(failed.budgetUsd, f.ledger.reservationUsd)
  assert.deepEqual(failed.upstream, active.upstream)
  assert.deepEqual(billed.upstream, active.upstream)
  assert.throws(
    () =>
      proxy.budgetServer({
        ledger: f.ledger,
        apiKey: 'replacement-key',
        token: 'mock-signing-key',
        upstream: 'https://another.invalid/v1',
      }),
    /upstream differs/
  )
  assert(f.ledger.state.rejectedRequests.every((r) => r.code === 'UPSTREAM_AUTHENTICATION_BLOCKED'))
  const saved = readFileSync(join(f.directory, 'budget.json'), 'utf8')
  for (const key of ['mock-provider-key', 'mock-signing-key']) {
    assert(!saved.includes(key))
    assert(!JSON.stringify(active).includes(key))
  }
  // 重启或换 key 本身不清除已封锁账本；恢复必须先验证凭据并建立新的网关账本。
  const reopened = proxy
    .budgetServer({
      ledger: f.ledger,
      apiKey: 'replacement-key',
      token: 'mock-signing-key',
      upstream: f.baseURL,
    })
    .listen(0, '127.0.0.1')
  await once(reopened, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${reopened.address().port}/health`, {
      headers: { authorization: 'Bearer mock-signing-key' },
    })
    assert.equal(
      (await response.json()).authenticationBlocker.code,
      'UPSTREAM_AUTHENTICATION_BLOCKED'
    )
    assert.equal(seen.length, 2)
  } finally {
    reopened.closeAllConnections()
    await new Promise((r) => reopened.close(r))
  }
})

test('429 and 5xx retain request evidence without permanently blocking another dispatch', async (t) => {
  const statuses = [429, 503, 200]
  const paths = []
  const f = await fixture(t, (_body, res, req) => {
    paths.push(req.url)
    const status = statuses.shift()
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(status === 200 ? { usage } : { error: { code: 'temporary' } }))
  })
  for (const status of [429, 503, 200]) {
    const response = await f.send(`request-${status}`)
    assert.equal(response.status, status)
    await response.text()
  }
  assert.equal((await f.health()).authenticationBlocker, null)
  assert.deepEqual(paths, ['/v1/responses', '/v1/responses', '/v1/responses'])
  assert.equal(f.ledger.state.requests.length, 3)
  assert.equal(f.ledger.summary().rejectedRequests, 0)
})

test('upstream approval normalizes v1 once and requires explicit authorization for another API root', () => {
  assert.equal(proxy.authorizedUpstream('https://api.openai.com/v1/'), 'https://api.openai.com/v1')
  assert.throws(() => proxy.authorizedUpstream('https://provider.invalid/v1'), /explicit/)
  assert.equal(
    proxy.authorizedUpstream('https://provider.invalid/v1/', 'https://provider.invalid'),
    'https://provider.invalid/v1'
  )
  assert.throws(
    () => proxy.authorizedUpstream('https://provider.invalid/v1', 'https://other.invalid'),
    /match/
  )
  for (const value of [
    'file:///tmp/x',
    '/v1',
    'https://user:secret@provider.invalid/v1',
    'https://provider.invalid/v1?key=secret',
    'https://provider.invalid/v1#secret',
    'https://provider.invalid/v1?',
  ])
    assert.throws(() => proxy.authorizedUpstream(value, value), /upstream URL/)
})

test('pricing basis remains frozen in health and each request; another basis or endpoint needs a new ledger', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-pricing-basis-'))
  const basis = {
    kind: 'reference_only',
    source: 'official-reference-fixture',
    upstreamBaseURL: 'https://provider.invalid/v1',
  }
  const ledger = new proxy.BudgetLedger(directory, 'unlimited', { pricingBasis: basis })
  const gateway = proxy
    .budgetServer({
      ledger,
      apiKey: 'mock-provider-key',
      token: 'mock-signing-key',
      upstream: basis.upstreamBaseURL,
    })
    .listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  try {
    ledger.reserve({}, identity('priced'))
    assert.deepEqual(ledger.state.pricingBasis, basis)
    assert.deepEqual(ledger.state.requests[0].pricingBasis, basis)
    const response = await fetch(`http://127.0.0.1:${gateway.address().port}/health`, {
      headers: { authorization: 'Bearer mock-signing-key' },
    })
    assert.deepEqual((await response.json()).pricingBasis, basis)
    assert.throws(
      () =>
        proxy.budgetServer({
          ledger,
          apiKey: 'mock',
          token: 'mock',
          upstream: 'https://another.invalid/v1',
        }),
      /Pricing basis upstream differs/
    )
  } finally {
    gateway.closeAllConnections()
    await new Promise((r) => gateway.close(r))
    ledger.close()
  }
  try {
    const reopened = new proxy.BudgetLedger(directory, 'unlimited', { pricingBasis: basis })
    assert.deepEqual(reopened.state.requests[0].pricingBasis, basis)
    reopened.close()
    assert.throws(() => new proxy.BudgetLedger(directory, 'unlimited'), /model\/pricing differs/)
    assert.throws(
      () =>
        new proxy.BudgetLedger(directory, 'unlimited', {
          pricingBasis: { ...basis, kind: 'provider_rates' },
        }),
      /model\/pricing differs/
    )
    assert.throws(
      () =>
        new proxy.BudgetLedger(directory, 'unlimited', {
          pricingBasis: { kind: 'unknown', source: 'fixture' },
        }),
      /Invalid pricing basis/
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
