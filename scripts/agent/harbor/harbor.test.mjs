import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { BudgetLedger, budgetServer, usageCost } from './budget-proxy.mjs'
import { toTrajectory } from './atif.mjs'
import { readTraceArtifact } from './trace-artifact.mjs'
import { runTask } from './run.mjs'
import { discoverProjectCommands } from './tool-discovery.mjs'
import { createLocalShellHost } from '@velaros-ai/velaros/execution/local'

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'scriptact-harbor-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('campaign reserves before dispatch, preserves uncertain charges across restart and prevents double owners', async (t) => {
  const path = await directory(t)
  const ledger = new BudgetLedger(path, 39)
  const first = ledger.reserve()
  assert.throws(() => ledger.reserve(), /insufficient/)
  assert.throws(() => new BudgetLedger(path, 39), /EEXIST/)
  ledger.settle(
    first,
    {
      input_tokens: 1000,
      output_tokens: 100,
      input_tokens_details: { cached_tokens: 500, cache_write_tokens: 0 },
    },
    'completed'
  )
  assert.equal(ledger.summary().committedUpperUsd, 0.0037)
  ledger.reserve()
  ledger.close()
  const reopened = new BudgetLedger(path, 39)
  assert.equal(reopened.summary().committedUpperUsd, 20.0037)
  assert.throws(() => reopened.reserve(), /insufficient/)
  reopened.close()
})

test('price accounting includes cached input, output reasoning tokens and long context premium', () => {
  assert.equal(
    usageCost({
      input_tokens: 1000000,
      output_tokens: 100000,
      input_tokens_details: { cached_tokens: 500000, cache_write_tokens: 100000 },
    }),
    3.8
  )
  assert.equal(
    usageCost({
      prompt_tokens: 1000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    }),
    0.003
  )
  assert.equal(usageCost({ input_tokens: 1000 }), null)
  assert.equal(usageCost({ input_tokens: 1000, output_tokens: 100 }), null)
  assert.equal(usageCost({ input_tokens: 1000, output_tokens: 100 }, true), 0.0065)
  assert.equal(
    usageCost({
      input_tokens: 10,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 },
    }),
    null
  )
})

test('model migration retains prior campaign charges and freezes pricing on new reservations', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'scriptact-harbor-migration-'))
  const previous = {
    id: 'prior',
    startedAt: '2026-09-28T00:00:00Z',
    estimatedUsd: 0.89,
    budgetUsd: 1.4,
    usage: { input_tokens: 1 },
    status: 'http-200',
  }
  await writeFile(
    join(path, 'budget.json'),
    JSON.stringify({ schema: 1, limitUsd: 1000, requests: [previous] })
  )
  const ledger = new BudgetLedger(path)
  t.after(async () => {
    ledger.close()
    await rm(path, { recursive: true, force: true })
  })
  const next = ledger.reserve({ reasoningEffort: 'high' })
  assert.equal(next.model, 'gpt-6-sol')
  assert.equal(next.pricing.write, 2.5)
  assert.equal(ledger.summary().committedUpperUsd, 21.4)
  const saved = JSON.parse(await readFile(join(path, 'budget.json'), 'utf8'))
  assert.deepEqual(saved.requests[0], previous)
})

test('ATIF preserves observation order, real invocation identities and embedded child trajectories', () => {
  const invocation = (id, executionId) => ({
    id,
    executionId,
    body: JSON.stringify({
      prepared: { input: { path: 'file.txt' } },
      receipt: { status: 'succeeded' },
    }),
    summary: { moduleId: 'velaros:project', operation: 'read' },
  })
  const trace = {
    turnId: 'turn',
    response: { body: 'original model text' },
    decision: { body: JSON.stringify({ usage: { inputTokens: 12, outputTokens: 3 } }) },
    request: { body: JSON.stringify({ messages: ['exact input'] }) },
    invocations: [invocation('read', 'observe'), invocation('write', 'execute')],
    observation: { run: { executionId: 'observe', source: 'read(file)' } },
    agents: [{ sessionId: 'child', task: 'Inspect the project' }],
  }
  const output = toTrajectory({
    sessionId: 'root',
    instruction: 'Solve task',
    traces: [trace],
    branches: [{ sessionId: 'child', kind: 'agent', turns: [] }],
    identity: {
      sourceCommit: 'commit',
      bundleFingerprint: 'fingerprint',
      reasoningEffort: 'medium',
    },
    model: 'gpt-6-sol',
  })
  assert.equal(output.steps[1].llm_call_count, 0)
  assert.equal(output.steps[1].tool_calls[0].tool_call_id, 'read')
  assert.equal(output.steps[2].tool_calls[0].tool_call_id, 'write')
  assert.equal(output.steps[2].message, 'original model text')
  assert.equal(output.steps[2].reasoning_effort, 'medium')
  assert.equal('cached_tokens' in output.steps[2].metrics, false)
  assert.equal(
    output.steps[2].observation.results[1].subagent_trajectory_ref[0].trajectory_id,
    'child'
  )
  assert.equal(output.subagent_trajectories[0].steps[0].message, 'Inspect the project')
})

test('gateway validates model before dispatch and settles split SSE usage without storing credentials', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'scriptact-harbor-gateway-'))
  const ledger = new BudgetLedger(path, 100)
  let dispatched = 0
  const upstream = createServer(async (req, res) => {
    dispatched++
    assert.equal(req.headers.authorization, 'Bearer private-provider-key')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    assert.equal(body.service_tier, 'default')
    assert.equal(body.store, false)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"response.function_call_arguments.delta","delta":"{"}\n\n')
    res.write('data: {"type":"response.completed","response":{"usa')
    res.end(
      'ge":{"input_tokens":1000,"output_tokens":100,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":0}}}}\n\n'
    )
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const gateway = budgetServer({
    requireIdentity: false,
    ledger,
    apiKey: 'private-provider-key',
    token: 'campaign-token',
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve) => gateway.close(resolve))
    await new Promise((resolve) => upstream.close(resolve))
    ledger.close()
    await rm(path, { recursive: true, force: true })
  })
  const url = `http://127.0.0.1:${gateway.address().port}/v1/responses`
  const send = (model, tools) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer campaign-token' },
      body: JSON.stringify({
        model,
        stream: true,
        tools,
        prompt_cache_key: 'private-session-cache-key',
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'private-task-body',
                prompt_cache_breakpoint: { mode: 'explicit' },
              },
            ],
          },
        ],
      }),
    })
  assert.equal((await send('different-model')).status, 400)
  assert.equal(
    (
      await send('gpt-6-sol', [
        { type: 'namespace', name: 'tools', tools: [{ type: 'web_search' }] },
      ])
    ).status,
    400
  )
  assert.equal(dispatched, 0)
  assert.match(
    await (
      await send('gpt-6-sol', [
        {
          type: 'namespace',
          name: 'functions',
          tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }],
        },
      ])
    ).text(),
    /response.completed/
  )
  assert.equal(dispatched, 1)
  assert.equal(ledger.summary().committedUpperUsd, 0.0055)
  assert(ledger.state.requests[0].durationMs >= 0)
  assert(ledger.state.requests[0].firstByteMs >= 0)
  assert(ledger.state.requests[0].firstToolInputMs >= 0)
  assert.equal(ledger.state.requests[0].metadata.explicitCacheBreakpoints, 1)
  assert.equal(ledger.state.requests[0].metadata.cacheKeyHash.length, 64)
  const saved = await readFile(join(path, 'budget.json'), 'utf8')
  assert(!saved.includes('private-provider-key'))
  assert(!saved.includes('campaign-token'))
  assert(!saved.includes('private-session-cache-key'))
  assert(!saved.includes('private-task-body'))
})

test('gateway distinguishes upstream transport failures from budget exhaustion and retains unknown charges', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'scriptact-harbor-transport-'))
  const ledger = new BudgetLedger(path, 20)
  let dispatched = 0
  const upstream = createServer((req) => {
    dispatched++
    req.socket.destroy()
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const gateway = budgetServer({
    requireIdentity: false,
    ledger,
    apiKey: 'private-provider-key',
    token: 'campaign-token',
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve) => gateway.close(resolve))
    await new Promise((resolve) => upstream.close(resolve))
    ledger.close()
    await rm(path, { recursive: true, force: true })
  })
  const send = () =>
    fetch(`http://127.0.0.1:${gateway.address().port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer campaign-token' },
      body: JSON.stringify({ model: 'gpt-6-sol', stream: true, input: [] }),
    })
  const failed = await send()
  const failureBody = await failed.json()
  assert.equal(failed.status, 502)
  assert.equal(failureBody.error.code, 'UPSTREAM_TRANSPORT')
  assert.equal(dispatched, 1)
  assert.equal(ledger.state.requests[0].estimatedUsd, null)
  assert.equal(ledger.state.requests[0].budgetUsd, 20)
  assert.equal(ledger.state.requests[0].status, 'unknown')
  assert.equal(ledger.state.requests[0].failure.causeCode, 'UND_ERR_SOCKET')
  assert.equal(ledger.state.requests[0].failure.upstreamStatus, null)
  assert(ledger.state.requests[0].durationMs >= 0)
  const exhausted = await send()
  assert.equal(exhausted.status, 402)
  assert.equal((await exhausted.json()).error.code, 'CAMPAIGN_STOP')
  assert.equal(dispatched, 1)
  assert.equal(ledger.state.requests.length, 1)
  const saved = await readFile(join(path, 'budget.json'), 'utf8')
  assert(!saved.includes('private-provider-key'))
  assert(!saved.includes('campaign-token'))
  const health = await fetch(`http://127.0.0.1:${gateway.address().port}/health`, {
    headers: { authorization: 'Bearer campaign-token' },
  }).then((response) => response.json())
  assert.equal(health.activeUpstreamRequests, 0)
})

test('gateway classifies timeouts and keeps sensitive diagnostic text out of receipts', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'scriptact-harbor-timeout-'))
  const ledger = new BudgetLedger(path, 100)
  const clientFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async () => {
    throw Object.assign(new Error('fixture-sensitive-diagnostic'), {
      name: 'TimeoutError',
      cause: { name: 'Error', code: 'https://fixture-sensitive-diagnostic/' },
    })
  })
  const gateway = budgetServer({
    requireIdentity: false,
    ledger,
    apiKey: 'provider-key',
    token: 'test-token',
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve) => gateway.close(resolve))
    ledger.close()
    await rm(path, { recursive: true, force: true })
  })
  const response = await clientFetch(`http://127.0.0.1:${gateway.address().port}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    body: JSON.stringify({ model: 'gpt-6-sol', stream: true, input: [] }),
  })
  const body = await response.text()
  assert.equal(response.status, 504)
  assert.equal(JSON.parse(body).error.code, 'UPSTREAM_TIMEOUT')
  assert(!body.includes('fixture-sensitive-diagnostic'))
  assert.equal(ledger.state.requests[0].failure.name, 'TimeoutError')
  assert.equal(ledger.state.requests[0].failure.causeCode, null)
  assert.equal(ledger.state.requests[0].estimatedUsd, null)
  assert.equal(ledger.summary().committedUpperUsd, 20)
  assert(
    !(await readFile(join(path, 'budget.json'), 'utf8')).includes('fixture-sensitive-diagnostic')
  )
})

test('gateway finishes upstream accounting before dispatching the next request, even after client cancellation', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'scriptact-harbor-serial-'))
  const ledger = new BudgetLedger(path, 100)
  let dispatched = 0
  let releaseFirst
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) {
      void chunk
    }
    const position = ++dispatched
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"response.created"}\n\n')
    if (position === 1) await firstGate
    res.end(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":1,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":0}}}}\n\n'
    )
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const gateway = budgetServer({
    requireIdentity: false,
    ledger,
    apiKey: 'test-key',
    token: 'test-token',
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    releaseFirst()
    await new Promise((resolve) => gateway.close(resolve))
    await new Promise((resolve) => upstream.close(resolve))
    ledger.close()
    await rm(path, { recursive: true, force: true })
  })
  const send = (signal) =>
    fetch(`http://127.0.0.1:${gateway.address().port}/v1/responses`, {
      method: 'POST',
      signal,
      headers: { authorization: 'Bearer test-token' },
      body: JSON.stringify({ model: 'gpt-6-sol', stream: true, input: [] }),
    })
  const controller = new AbortController()
  await send(controller.signal)
  controller.abort()
  const second = send().then((response) => response.text())
  const health = () =>
    fetch(`http://127.0.0.1:${gateway.address().port}/health`, {
      headers: { authorization: 'Bearer test-token' },
    }).then((response) => response.json())
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(dispatched, 1)
    assert.equal((await health()).activeUpstreamRequests, 1)
  } finally {
    releaseFirst()
    await second
  }
  assert.equal(dispatched, 2)
  assert.equal(ledger.state.requests.length, 2)
  assert(ledger.state.requests.every((request) => request.estimatedUsd !== null))
  assert(ledger.state.requests[1].queueWaitMs > 0)
  assert(ledger.state.requests[1].startedAt >= ledger.state.requests[0].finishedAt)
  assert.equal((await health()).activeUpstreamRequests, 0)
})

test('tool discovery covers alternate and nested configurations within a fixed filesystem budget', async (t) => {
  const workspace = await directory(t)
  const outside = await directory(t)
  for (const path of ['services/api', 'clients/web', 'jvm', 'vendor'])
    await mkdir(join(workspace, path), { recursive: true })
  for (const path of [
    'services/api/requirements-dev.txt',
    'services/api/setup.cfg',
    'clients/web/pnpm-lock.yaml',
    'clients/web/yarn.lock',
    'jvm/pom.xml',
    'jvm/build.gradle.kts',
    'vendor/Cargo.toml',
  ])
    await writeFile(join(workspace, path), '')
  await writeFile(join(outside, 'go.mod'), '')
  await symlink(outside, join(workspace, 'external'))
  const found = await discoverProjectCommands(workspace)
  for (const name of ['python3', 'node', 'pnpm', 'yarn', 'java', 'mvn', 'gradle'])
    assert(found.commands.includes(name))
  assert(!found.commands.includes('cargo'))
  assert(!found.commands.includes('go'))
  assert.equal(found.coverage.exhaustive, false)
  const bounded = await discoverProjectCommands(workspace, {
    maxDepth: 1,
    maxDirectories: 2,
    maxEntries: 3,
  })
  assert(bounded.coverage.directories <= 2)
  assert(bounded.coverage.entries <= 3)
  assert(bounded.coverage.limited)
  const empty = await discoverProjectCommands(outside, { maxDepth: 0 })
  assert(empty.commands.includes('go'))
  assert(!empty.commands.includes('python3'))
})

test('the first model request reports the shell that the local host will actually execute', async (t) => {
  const workspace = await directory(t)
  const output = await directory(t)
  const host = createLocalShellHost({ cwd: workspace })
  const inspection = await host.inspectEnvironment(['git', 'rg', 'go', 'gofmt'])
  await writeFile(join(workspace, 'go.mod'), 'module fixture\n')
  await host.dispose()
  let observed = false
  const result = await runTask({
    isolatedContainer: true,
    instruction: 'Report readiness.',
    workspace,
    output,
    identity: { sourceCommit: 'test-commit', bundleFingerprint: 'test-fingerprint' },
    model: {
      id: 'controlled-model',
      limits: { contextTokens: 128000, inputTokens: 110000, outputTokens: 12000 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
      async *stream(request) {
        observed = request.compiledPrompt.includes(inspection.shell.path)
        for (const command of inspection.commands) {
          assert(request.compiledPrompt.includes(command.name))
          if (command.path) assert(request.compiledPrompt.includes(command.path))
        }
        assert(request.compiledPrompt.includes('pathEntries'))
        assert(request.compiledPrompt.includes('available'))
        assert(request.compiledPrompt.includes('commandDiscovery'))
        assert.match(request.instructions, /Node.js/u)
        assert.match(request.instructions, /index.json/u)
        const marker = request.compiledPrompt.match(/当前帧标记：(@@s[0-9a-z]+)。/)[1]
        yield { type: 'text', text: `Ready.\n${marker} done` }
        yield { type: 'usage', inputTokens: 1000, outputTokens: 100 }
        yield { type: 'finish', reason: 'stop' }
      },
    },
  })
  assert.equal(result.status, 'completed')
  assert(observed, 'The first request must disclose the actual executable shell path')
})

test('a candidate working window reaches real context planning and remains bounded by the model', async (t) => {
  const workspace = await directory(t)
  for (const [configured, expected] of [
    [32000, 32000],
    [900000, 110000],
  ]) {
    const output = await directory(t)
    const result = await runTask({
      isolatedContainer: true,
      instruction: 'Report readiness.',
      workspace,
      output,
      identity: {
        sourceCommit: 'controlled',
        runtimeOptions: { context: { policy: { windowTokens: configured } } },
      },
      model: {
        id: 'controlled-model',
        limits: { contextTokens: 128000, inputTokens: 110000, outputTokens: 12000 },
        estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
        async *stream(request) {
          const marker = request.compiledPrompt.match(/当前帧标记：(@@s[0-9a-z]+)。/)[1]
          yield { type: 'text', text: `Ready.\n${marker} done` }
          yield { type: 'usage', inputTokens: 1000, outputTokens: 100 }
          yield { type: 'finish', reason: 'stop' }
        },
      },
    })
    assert.equal(result.status, 'completed', result.failure)
    const traces = await readTraceArtifact(join(output, 'traces.json'))
    const request = JSON.parse(traces.traces[0].request.body).request
    assert.equal(request.contextStatus.inputLimit, expected)
  }
})

test(
  'Harbor host runs real project edits and shell through ScriptAct and archives full traces',
  { timeout: 30000 },
  async (t) => {
    const workspace = await directory(t)
    const output = await directory(t)
    await writeFile(join(workspace, 'value.txt'), 'before\n')
    let calls = 0
    const cacheKeys = new Set()
    const model = {
      id: 'controlled-model',
      limits: { contextTokens: 128000, inputTokens: 110000, outputTokens: 12000 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
      async *stream(request) {
        cacheKeys.add(request.cacheKey)
        const marker = request.compiledPrompt.match(/当前帧标记：(@@s[0-9a-z]+)。/)[1]
        calls++
        yield {
          type: 'text',
          text:
            calls === 1
              ? `${marker} execute\nimport {read,edit} from 'velaros:project';import {execaCommand} from 'execa';import {output} from 'velaros';await read({files:[{path:'value.txt'}]});await edit({steps:[{action:'replace',path:'value.txt',oldText:'before',newText:'after'}]});console.log((await execaCommand('printf passed > command.txt',{shell:true})).exitCode);\n${marker}\n`
              : calls === 2
                ? `${marker} execute\nimport { output } from 'velaros'; output('missing closing marker');`
                : `Done.\n${marker} done`,
        }
        yield { type: 'usage', inputTokens: 1000, outputTokens: 100 }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const result = await runTask({
      isolatedContainer: true,
      workspace,
      output,
      model,
      identity: { sourceCommit: 'controlled' },
      instruction: 'Update the file and verify it',
      turns: 6,
    })
    assert.equal(result.status, 'completed', result.failure)
    assert.equal(result.failure, null)
    assert.equal(calls, 3)
    const status = JSON.parse(await readFile(join(output, 'status.json'), 'utf8'))
    assert(status.traceExport.count > 0)
    assert(status.traceExport.totalMs >= status.traceExport.maxMs)
    assert(
      status.traceExport.bytesWritten >=
        Buffer.byteLength(await readFile(join(output, 'traces.json')))
    )
    const events = (await readFile(join(output, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert(events.some((event) => event.type === 'error'))
    assert.equal(await readFile(join(workspace, 'value.txt'), 'utf8'), 'after\n')
    assert.equal(await readFile(join(workspace, 'command.txt'), 'utf8'), 'passed')
    const trajectory = JSON.parse(await readFile(join(output, 'trajectory.json'), 'utf8'))
    assert.equal(trajectory.agent.name, 'velaros-scriptact')
    assert(
      trajectory.steps.some((step) =>
        step.tool_calls?.some((call) => call.function_name === 'velaros:project.edit')
      )
    )
    assert(trajectory.steps.some((step) => step.extra?.request))
    assert.equal(cacheKeys.size, 1)
    let nextCacheKey
    const next = await runTask({
      isolatedContainer: true,
      workspace,
      output: await directory(t),
      model: {
        ...model,
        async *stream(request) {
          nextCacheKey = request.cacheKey
          const marker = request.compiledPrompt.match(/当前帧标记：(@@s[0-9a-z]+)。/)[1]
          yield { type: 'text', text: `Done.\n${marker} done` }
          yield { type: 'usage', inputTokens: 1000, outputTokens: 10 }
          yield { type: 'finish', reason: 'stop' }
        },
      },
      identity: { sourceCommit: 'controlled' },
      instruction: 'Finish this new task',
    })
    assert.equal(next.status, 'completed')
    assert(nextCacheKey)
    assert(!cacheKeys.has(nextCacheKey))
  }
)

test('a frozen task-retention candidate keeps accepted receipt history stable across later turns', async (t) => {
  const histories = []
  for (const defaultRetain of [2, 'task']) {
    let calls = 0
    const receipts = []
    const currentResults = []
    const result = await runTask({
      isolatedContainer: true,
      workspace: await directory(t),
      output: await directory(t),
      identity: { sourceCommit: 'controlled', runtimeOptions: { protocol: { defaultRetain } } },
      instruction: 'Produce three independent observations and finish.',
      turns: 6,
      model: {
        id: 'controlled-model',
        limits: { contextTokens: 128000, inputTokens: 110000, outputTokens: 12000 },
        estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
        async *stream(request) {
          const frame = JSON.parse(
            request.materials.find((material) => material.origin === 'runtime-view').text
          )
          currentResults.push(frame.partitions.recent.results)
          const marker = request.compiledPrompt.match(/当前帧标记：(@@s[0-9a-z]+)。/)[1]
          const receipt = request.history.find(
            (message) =>
              message.role === 'user' && message.content.startsWith('{"origin":"runtime-execution"')
          )
          if (receipt) receipts.push(receipt.content)
          calls++
          yield {
            type: 'text',
            text:
              calls <= 3
                ? `${marker} execute\nimport {output} from 'velaros'; output(${calls});\n${marker}\n`
                : `${marker} done\nFinished.`,
          }
          yield { type: 'usage', inputTokens: 1000, outputTokens: 100 }
          yield { type: 'finish', reason: 'stop' }
        },
      },
    })
    assert.equal(result.status, 'completed', result.failure)
    assert.equal(calls, 4)
    histories.push({ receipts, currentResults })
  }
  for (const { receipts, currentResults } of histories) {
    assert.equal(receipts.length, 3)
    const header = JSON.parse(receipts[0].split('\n')[0])
    assert.equal(header.bodyIncluded, true)
    const body = JSON.parse(receipts[0].split('\n当次输出：\n')[1])
    assert.equal(body.result.value.default, 1)
    // Expiry changes the current lease; it never rewrites an already accepted history body.
    assert(receipts.every((receipt) => receipt === receipts[0]))
    assert(currentResults[1].some((result) => result.ref === header.ref.id))
  }
  const firstRef = (history) => JSON.parse(history.receipts[0].split('\n')[0]).ref.id
  assert.deepEqual(
    histories[0].currentResults
      .slice(1, 3)
      .map(
        (results) => results.find((result) => result.ref === firstRef(histories[0])).remainingTurns
      ),
    [2, 1]
  )
  assert.equal(
    histories[0].currentResults.at(-1).some((result) => result.ref === firstRef(histories[0])),
    false
  )
  for (const results of histories[1].currentResults.slice(1))
    assert.equal(
      results.find((result) => result.ref === firstRef(histories[1])).remainingTurns,
      'task'
    )
})

test('an image-enabled candidate delivers project images as multimodal model input', async (t) => {
  const workspace = await directory(t)
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+9sAAAAASUVORK5CYII='
  await writeFile(join(workspace, 'pixel.png'), Buffer.from(png, 'base64'))
  let calls = 0
  const result = await runTask({
    isolatedContainer: true,
    workspace,
    output: await directory(t),
    identity: { sourceCommit: 'controlled', runtimeOptions: { project: { images: true } } },
    instruction: 'Inspect the project image and finish.',
    turns: 3,
    model: {
      id: 'controlled-model',
      limits: { contextTokens: 128000, inputTokens: 110000, outputTokens: 12000 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
      async *stream(request) {
        const marker = request.compiledPrompt.match(/当前帧标记：(@@s[0-9a-z]+)。/)[1]
        calls++
        if (calls === 2) assert(request.images.some((image) => image.data === png))
        yield {
          type: 'text',
          text:
            calls === 1
              ? `${marker} execute\nimport {view} from 'velaros:images'; await view({files:[{path:'pixel.png'}]});\n${marker}\n`
              : `${marker} done\nImage received.`,
        }
        yield { type: 'usage', inputTokens: 1000, outputTokens: 100 }
        yield { type: 'finish', reason: 'stop' }
      },
    },
  })
  assert.equal(result.status, 'completed', result.failure)
  assert.equal(calls, 2)
})

test('a discovery-only candidate keeps project, npm and images available without resident declarations', async (t) => {
  const workspace = await directory(t)
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+9sAAAAASUVORK5CYII='
  await writeFile(join(workspace, 'pixel.png'), Buffer.from(png, 'base64'))
  let calls = 0
  const result = await runTask({
    isolatedContainer: true,
    workspace,
    output: await directory(t),
    identity: {
      sourceCommit: 'controlled',
      runtimeOptions: { project: { images: true }, residentModules: [] },
    },
    instruction: 'Discover the available project and image APIs, then inspect the image.',
    turns: 4,
    model: {
      id: 'controlled-model',
      limits: { contextTokens: 128000, inputTokens: 110000, outputTokens: 12000 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
      async *stream(request) {
        const marker = request.compiledPrompt.match(/当前帧标记：(@@s[0-9a-z]+)。/)[1]
        calls++
        if (calls === 1) {
          assert(!request.instructions.includes('常驻模块 velaros:'))
        }
        if (calls === 2) {
          const history = request.history.map((message) => message.content).join('\n')
          assert(history.includes('"marker":"DISCOVERY_OK"'), history.slice(-1800))
          assert(history.includes("declare module 'velaros:images'"))
        }
        if (calls === 3) assert(request.images.some((image) => image.data === png))
        const scripts = [
          `import {modules} from 'velaros:system'; import {output} from 'velaros';
const project = await modules.describe({module:'velaros:project',exports:['read']});
const {execa} = await import('execa');
const images = await modules.describe({module:'velaros:images',exports:['view']});
if (!project.declarations || typeof execa !== 'function' || !images.declarations) throw 'Discovery failed';
output({marker:'DISCOVERY_OK',images:images.declarations});`,
          "import {view} from 'velaros:images'; await view({files:[{path:'pixel.png'}]});",
        ]
        yield {
          type: 'text',
          text:
            calls <= 2
              ? `${marker} execute\n${scripts[calls - 1]}\n${marker}\n`
              : `${marker} done\nImage received.`,
        }
        yield { type: 'usage', inputTokens: 1000, outputTokens: 100 }
        yield { type: 'finish', reason: 'stop' }
      },
    },
  })
  assert.equal(result.status, 'completed', result.failure)
  assert.equal(calls, 3)
})
