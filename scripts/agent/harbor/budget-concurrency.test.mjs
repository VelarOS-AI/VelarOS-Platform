import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BudgetLedger, budgetServer, campaignPricing } from './budget-proxy.mjs'
import { attemptCredential } from './request-identity.mjs'
import { RequestScheduler } from './request-scheduler.mjs'

const identity = (name) => ({
  campaignId: 'fixture',
  candidateId: 'candidate',
  participantId: 'agent',
  taskId: name,
  attemptId: name,
  jobId: name,
  phase: 'source',
})
const usage = {
  input_tokens: 100,
  output_tokens: 10,
  input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 },
}

test('frozen request caps apply independently to each participant and count missing usage across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-request-cap-'))
  try {
    const ledger = new BudgetLedger(directory, 'unlimited', { maxRequestsPerAttempt: 1 })
    ledger.reserve({}, identity('scriptact'))
    ledger.reserve({}, identity('codex'))
    assert.throws(() => ledger.reserve({}, identity('scriptact')), {
      code: 'CAMPAIGN_BUDGET_EXHAUSTED',
    })
    ledger.close()
    assert.throws(() => new BudgetLedger(directory, 'unlimited'), /per-attempt limits differ/)
    assert.throws(
      () => new BudgetLedger(directory, 'unlimited', { maxRequestsPerAttempt: 2 }),
      /per-attempt limits differ/
    )
    const reopened = new BudgetLedger(directory, 'unlimited', { maxRequestsPerAttempt: 1 })
    assert.throws(() => reopened.reserve({}, identity('codex')), {
      code: 'CAMPAIGN_BUDGET_EXHAUSTED',
    })
    assert.equal(reopened.state.requests.length, 2)
    reopened.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
test('one participant exhausting its reservation allowance leaves the other allowance available', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-participant-budget-'))
  try {
    const ledger = new BudgetLedger(directory, 80, { perAttemptBudgetUsd: 40 })
    ledger.reserve({}, identity('scriptact'))
    ledger.reserve({}, identity('scriptact'))
    assert.throws(() => ledger.reserve({}, identity('scriptact')), {
      code: 'CAMPAIGN_BUDGET_EXHAUSTED',
    })
    ledger.reserve({}, identity('codex'))
    ledger.reserve({}, identity('codex'))
    assert.equal(ledger.summary(identity('codex')).requests, 2)
    ledger.close()
    assert.throws(
      () => new BudgetLedger(directory, 80, { perAttemptBudgetUsd: 80 }),
      /per-attempt limits differ/
    )
    const reopened = new BudgetLedger(directory, 80, { perAttemptBudgetUsd: 40 })
    assert.throws(() => reopened.reserve({}, identity('codex')), {
      code: 'CAMPAIGN_BUDGET_EXHAUSTED',
    })
    reopened.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
async function until(check) {
  const deadline = Date.now() + 3000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('fixture deadline')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('unlimited is explicit, preserves charges across restart and freezes the model/pricing owner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-unlimited-'))
  try {
    const ledger = new BudgetLedger(directory, 39)
    ledger.reserve({}, identity('old'))
    ledger.close()
    assert.throws(() => new BudgetLedger(directory, 'unlimited'), /differs/)
    const changed = new BudgetLedger(directory, 'unlimited', { allowLimitChange: true })
    assert.equal(changed.summary().budgetMode, 'unlimited')
    for (let i = 0; i < 55; i++) changed.reserve({}, identity(`task-${i}`))
    assert.equal(changed.summary().committedUpperUsd, 1120)
    assert.equal(changed.state.limitHistory.length, 1)
    assert.throws(
      () => budgetServer({ ledger: changed, token: 'fixture', requireIdentity: false }),
      /signed/
    )
    assert.throws(
      () => changed.reserve({}, { ...identity('old'), participantId: 'another' }),
      /frozen/
    )
    changed.close()
    const reopened = new BudgetLedger(directory, 'unlimited')
    assert.equal(reopened.summary().committedUpperUsd, 1120)
    reopened.close()
    assert.throws(
      () => new BudgetLedger(directory, 'unlimited', { model: 'other' }),
      /model\/pricing/
    )
    assert.throws(() => new BudgetLedger(directory, null), /explicit unlimited/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('scheduler skips saturated attempts, bounds its queue and removes cancelled waiters', async () => {
  const queue = new RequestScheduler({ maxConcurrency: 2, perAttemptConcurrency: 1, maxQueue: 1 })
  const a = await queue.acquire('a')
  const abort = new AbortController()
  const waiting = queue.acquire('a', abort.signal)
  const rejected = assert.rejects(waiting)
  assert.throws(() => queue.acquire('a'), { code: 'GATEWAY_QUEUE_FULL' })
  abort.abort()
  await rejected
  const b = await queue.acquire('b')
  assert.equal(queue.summary().active, 2)
  a()
  a()
  b()
  assert.equal(queue.summary().active, 0)
})

test('parallel signed attempts settle independently; cancelled upstream work retains its slot until usage arrives', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-parallel-'))
  const pricing = { ...campaignPricing, input: 4, cached: 0.4, write: 5, output: 20 }
  const ledger = new BudgetLedger(directory, 'unlimited', {
    model: 'fixture-model',
    pricing,
    pricingRef: 'fixture-v1',
    reasoningEffort: 'high',
  })
  const releases = new Map()
  const seen = []
  const upstream = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    assert.equal(body.model, 'fixture-model')
    assert.equal(body.reasoning.effort, 'high')
    seen.push(body.input)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"response.created"}\n\n')
    await new Promise((resolve) => releases.set(body.input, resolve))
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { usage } })}\n\n`)
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const gateway = budgetServer({
    ledger,
    apiKey: 'provider-fixture',
    token: 'fixture-secret',
    maxConcurrency: 2,
    perAttemptConcurrency: 1,
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  }).listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  const url = `http://127.0.0.1:${gateway.address().port}`
  const headers = (id) => ({
    authorization: `Bearer ${attemptCredential(identity(id), 'fixture-secret')}`,
  })
  const send = (id, label, signal) =>
    fetch(url + '/v1/responses', {
      method: 'POST',
      headers: headers(id),
      signal,
      body: JSON.stringify({ model: 'fixture-model', stream: true, input: label }),
    })
  const ownHealth = (id) => fetch(url + '/health', { headers: headers(id) }).then((r) => r.json())
  t.after(async () => {
    for (const release of releases.values()) release()
    await Promise.all([new Promise((r) => gateway.close(r)), new Promise((r) => upstream.close(r))])
    ledger.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const wrongTier = await fetch(url + '/v1/responses', {
    method: 'POST',
    headers: headers('invalid'),
    body: JSON.stringify({
      model: 'fixture-model',
      service_tier: 'priority',
      input: 'forbidden-tier',
    }),
  })
  assert.equal(wrongTier.status, 400)
  await wrongTier.text()
  assert.equal(seen.length, 0)
  const wrongReasoning = await fetch(url + '/v1/responses', {
    method: 'POST',
    headers: headers('invalid'),
    body: JSON.stringify({
      model: 'fixture-model',
      reasoning: { effort: 'low' },
      input: 'forbidden-effort',
    }),
  })
  assert.equal(wrongReasoning.status, 400)
  await wrongReasoning.text()
  const activeAbort = new AbortController()
  await send('a', 'a-first', activeAbort.signal)
  activeAbort.abort()
  const nextA = send('a', 'a-second').then((r) => r.text())
  const b = await send('b', 'b-first')
  await until(() => seen.length === 2)
  assert.deepEqual(seen, ['a-first', 'b-first'])
  const queuedAbort = new AbortController()
  const cancelled = send('c', 'c-cancelled', queuedAbort.signal)
  const cancelResult = assert.rejects(cancelled)
  await until(async () => (await ownHealth('c')).scheduler.queued === 1)
  queuedAbort.abort()
  await cancelResult
  // 客户端 Promise 拒绝早于 TCP close 到达服务端；先确认服务端已撤销排队，再释放上游槽。
  await until(async () => (await ownHealth('c')).scheduler.queued === 0)
  releases.get('b-first')()
  await b.text()
  await until(() => ledger.state.requests.find((r) => r.identity.attemptId === 'b')?.finishedAt)
  assert.equal((await ownHealth('b')).activeUpstreamRequests, 0)
  assert.equal((await ownHealth('a')).activeUpstreamRequests, 1)
  assert(!seen.includes('a-second'))
  releases.get('a-first')()
  await until(() => releases.has('a-second'))
  releases.get('a-second')()
  await nextA
  assert.equal(ledger.summary(identity('a')).requests, 2)
  assert.equal(ledger.summary(identity('b')).requests, 1)
  assert.equal(ledger.summary(identity('c')).requests, 0)
  assert(
    ledger.state.requests.every(
      (r) => r.estimatedUsd !== null && r.model === 'fixture-model' && r.pricingRef === 'fixture-v1'
    )
  )
  assert.equal(new Set(ledger.state.requests.map((r) => r.id)).size, 3)
  const persisted = readFileSync(join(directory, 'budget.json'), 'utf8')
  assert(!persisted.includes('fixture-secret') && !persisted.includes('provider-fixture'))
})
