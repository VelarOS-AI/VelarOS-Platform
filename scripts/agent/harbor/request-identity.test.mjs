import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { attemptCredential, authenticateAttempt } from './request-identity.mjs'
import { BudgetLedger, budgetServer, campaignModel } from './budget-proxy.mjs'

const owner = {
  campaignId: 'campaign',
  candidateId: 'candidate',
  participantId: 'scriptact',
  taskId: 'a',
  attemptId: 'attempt-a',
  jobId: 'job-a',
  phase: 'source',
}
test('Python and gateway agree on signed attempt credentials and reject tampering', () => {
  const code =
    'import json, sys; from request_identity import attempt_credential; print(attempt_credential(json.loads(sys.argv[1]), "fixture-secret"))'
  const result = spawnSync('python3', ['-c', code, JSON.stringify(owner)], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const token = result.stdout.trim()
  assert.equal(token, attemptCredential(owner, 'fixture-secret'))
  assert.deepEqual(authenticateAttempt(`Bearer ${token}`, 'fixture-secret').identity, owner)
  assert.equal(authenticateAttempt(`Bearer ${token.slice(0, -1)}x`, 'fixture-secret'), null)
  assert.equal(authenticateAttempt(`Bearer ${token}`, 'other-secret'), null)
})
test('gateway binds cost to signed attempts and blocks install/replay provider dispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'attempt-accounting-'))
  const ledger = new BudgetLedger(directory)
  let calls = 0
  const upstream = createServer(async (req, res) => {
    calls++
    for await (const _ of req) {
      /* drain request */
    }
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        usage: {
          input_tokens: 100,
          output_tokens: 2,
          input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 },
        },
      })
    )
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const server = budgetServer({
    ledger,
    apiKey: 'provider-fixture',
    token: 'controller-fixture',
    requireIdentity: true,
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  const send = async (identity, body = {}) => {
    const token =
      typeof identity === 'string' ? identity : attemptCredential(identity, 'controller-fixture')
    const result = await fetch(url + '/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: campaignModel, input: 'fixture', ...body }),
    })
    await result.text()
    return result.status
  }
  try {
    assert.equal(await send('controller-fixture'), 403)
    assert.equal(await send({ ...owner, phase: 'install' }), 403)
    assert.equal(await send({ ...owner, phase: 'replay' }), 403)
    assert.equal(await send(owner, { metadata: { attemptId: 'spoof' } }), 200)
    const other = { ...owner, taskId: 'b', attemptId: 'attempt-b', jobId: 'job-b' }
    assert.equal(await send(other), 200)
    assert.equal(calls, 2)
    assert.equal(ledger.state.requests.length, 2)
    assert.deepEqual(
      ledger.state.requests.map((row) => row.identity),
      [owner, other]
    )
    assert.equal(ledger.summary(owner).requests, 1)
    assert.equal(ledger.summary(other).requests, 1)
    const stored = readFileSync(join(directory, 'budget.json'), 'utf8')
    assert(!stored.includes('controller-fixture'))
    assert(!stored.includes('provider-fixture'))
    assert(!stored.includes('sa1.'))
  } finally {
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ])
    ledger.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
