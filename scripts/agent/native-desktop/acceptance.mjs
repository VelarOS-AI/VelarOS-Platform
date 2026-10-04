// 用途：在真实 Desktop 中零模型验收并发、背景派发、完整追踪、完全访问与取消结算。
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs, promisify } from 'node:util'

import { BudgetLedger, budgetServer } from '../harbor/budget-proxy.mjs'
import { attemptCredential } from '../harbor/request-identity.mjs'
import { runCodex } from './codex.mjs'
import {
  cdpClient,
  configureModel,
  desktopClient,
  dispatch,
  privateJson,
  waitForSettlement,
} from './client.mjs'

const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', done))
const close = (server) => new Promise((done) => server.close(done))
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
const execute = promisify(execFile)

async function main() {
  const { values } = parseArgs({
    options: {
      directory: { type: 'string' },
      endpoint: { type: 'string' },
      settings: { type: 'string' },
      cdp: { type: 'string' },
      pricing: { type: 'string' },
      codex: { type: 'string' },
    },
  })
  for (const key of ['directory', 'endpoint', 'settings', 'cdp', 'pricing', 'codex'])
    if (!values[key]) throw new Error('Missing --' + key)
  const directory = resolve(values.directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const model = 'gpt-5.6-sol'
  const pricing = JSON.parse(await readFile(values.pricing, 'utf8'))
  const state = new Map()
  let inFlight = 0
  let peak = 0
  let unblockCancellation
  const cancellation = new Promise((done) => {
    unblockCancellation = done
  })
  const serve = async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: model, object: 'model', context_length: 128000 }],
        })
      )
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const text = JSON.stringify(body)
    const id = /native_fixture_(A|B|cancel|codex)/.exec(text)?.[1]
    assert.ok(id, 'fixture task identity absent')
    const marker = [...text.matchAll(/当前帧标记：(@@[A-Za-z0-9_]+)/g)].at(-1)?.[1]
    if (id !== 'codex') assert.match(marker ?? '', /^@@s[a-f0-9]{8,}$/)
    const index = (state.get(id)?.length ?? 0) + 1
    const events = state.get(id) ?? []
    events.push({
      index,
      marker,
      model: body.model,
      reasoning: body.reasoning,
      receivedAt: Date.now(),
    })
    state.set(id, events)
    inFlight++
    peak = Math.max(peak, inFlight)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (value) => res.write('data: ' + JSON.stringify(value) + '\n\n')
    emit({
      type: 'response.created',
      response: {
        id: 'resp_' + id + '_' + index,
        object: 'response',
        created_at: 1,
        model,
        status: 'in_progress',
        output: [],
      },
    })
    if (id === 'cancel') await cancellation
    else await sleep(650)
    const command =
      'sleep 0.6; pwd; printf ' +
      quote(id) +
      ' > ' +
      quote(join(directory, 'outside-' + id + '.txt'))
    const content =
      id === 'codex'
        ? '本机 Codex 零模型验收完成。'
        : index === 1 && id !== 'cancel'
          ? marker +
            ' execute\nimport {run} from "velaros:shell"; import {output} from "velaros"; output(await run({command:' +
            JSON.stringify(command) +
            ',timeoutMs:10000}));\n' +
            marker
          : marker + ' done\n原生离线验收完成。'
    emit({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [],
        status: 'in_progress',
        phase: 'final_answer',
      },
    })
    emit({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: content,
    })
    emit({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: content, annotations: [] }],
        phase: 'final_answer',
      },
    })
    emit({
      type: 'response.completed',
      response: {
        id: 'resp_' + id + '_' + index,
        model,
        status: 'completed',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    })
    res.end()
    inFlight--
  }
  const upstream = createServer(
    (req, res) =>
      void serve(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
  )
  await listen(upstream)
  const ledger = new BudgetLedger(join(directory, 'gateway'), 'unlimited', {
    model,
    reasoningEffort: 'high',
    pricing: {
      input: pricing.input,
      cached: pricing.cachedInput,
      write: pricing.cacheWriteInput,
      output: pricing.output,
      longThreshold: pricing.longThreshold,
      longInputMultiplier: pricing.longInputMultiplier,
      longOutputMultiplier: pricing.longOutputMultiplier,
    },
    pricingBasis: { kind: 'reference_only', source: 'synthetic-zero-model-fixture' },
  })
  const secret = randomBytes(32).toString('hex')
  const gateway = budgetServer({
    ledger,
    apiKey: 'offline-fixture',
    token: secret,
    upstream: 'http://127.0.0.1:' + upstream.address().port + '/v1',
    requireIdentity: true,
    maxConcurrency: 2,
    perAttemptConcurrency: 1,
  })
  await listen(gateway)
  const baseURL = 'http://127.0.0.1:' + gateway.address().port + '/v1'
  const hook = await desktopClient(values.endpoint)
  const cdp = await cdpClient(values.cdp)
  const original = JSON.parse(await readFile(values.settings, 'utf8'))
  const runId = String(Date.now())
  const identities = []
  const sessions = []
  let outcome
  try {
    assert.equal((await hook({ kind: 'bridge_ping', timeoutMs: 1000 })).alive, true)
    const before = await cdp.selection()
    for (const name of ['A', 'B']) {
      const identity = {
        campaignId: 'native-zero-' + runId,
        candidateId: 'offline-fixture',
        participantId: 'scriptact',
        taskId: 'fixture-' + name,
        attemptId: runId + '-' + name,
        jobId: 'desktop-native',
        phase: 'source',
      }
      identities.push(identity)
      await configureModel(hook, values.settings, {
        baseURL,
        apiKey: attemptCredential(identity, secret),
        model,
      })
      const workspace = join(directory, 'workspaces', name)
      await mkdir(workspace, { recursive: true })
      await writeFile(join(workspace, 'README.md'), 'Native zero-model fixture.\n', { mode: 0o600 })
      await execute('git', ['init', '-q'], { cwd: workspace })
      await execute('git', ['add', 'README.md'], { cwd: workspace })
      await execute(
        'git',
        [
          '-c',
          'user.name=Native Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'Initialize native fixture',
        ],
        { cwd: workspace }
      )
      const sessionId = 'native_fixture_' + name + '_' + runId
      sessions.push(sessionId)
      const receipt = await dispatch(hook, {
        sessionId,
        workspace,
        model,
        activate: false,
        problem:
          'native_fixture_' + name + ': 运行原生验收脚本，验证工作目录与授权的外部文件写入。',
      })
      assert.equal(receipt.accepted, true)
      assert.equal(receipt.windowFocused, false)
    }
    await Promise.all(sessions.map((id) => waitForSettlement(hook, id, 30_000)))
    const after = await cdp.selection()
    assert.equal(after.activeFolderId, before.activeFolderId)
    for (const folder of before.folders)
      assert.equal(
        after.folders.find((item) => item.id === folder.id)?.activeMemberSessionId,
        folder.activeMemberSessionId
      )
    for (const [index, id] of sessions.entries()) {
      const name = ['A', 'B'][index]
      assert.equal(await readFile(join(directory, 'outside-' + name + '.txt'), 'utf8'), name)
      const trace = await cdp.trace(id)
      await privateJson(join(directory, 'trace-' + name + '.json'), trace)
      assert.equal(trace.omitted, 0)
      assert.equal(trace.turns.length, 2)
      assert.equal(trace.turns.at(-1).done, true)
      assert.equal(trace.turns[0].executions[0].calls[0].module, 'velaros:shell')
      assert.ok(trace.turns[0].executions[0].calls[0].input.includes('sleep 0.6'))
      assert.ok(
        trace.turns[0].executions[0].calls[0].output.includes(join(directory, 'workspaces', name))
      )
    }
    assert.equal(peak, 2, 'actual upstream requests never overlapped')
    assert.equal(ledger.state.requests.length, 4)
    assert.ok(
      ledger.state.requests.every((row) => row.metadata.explicitCacheBreakpoints === 0),
      'disabled wire capability was not preserved'
    )
    for (const identity of identities)
      assert.equal(
        ledger.state.requests.filter((row) => row.identity?.attemptId === identity.attemptId)
          .length,
        2
      )
    const cancelIdentity = {
      ...identities[0],
      taskId: 'fixture-cancel',
      attemptId: runId + '-cancel',
    }
    await configureModel(hook, values.settings, {
      baseURL,
      apiKey: attemptCredential(cancelIdentity, secret),
      model,
    })
    const sessionId = 'native_fixture_cancel_' + runId
    sessions.push(sessionId)
    await dispatch(hook, {
      sessionId,
      workspace: join(directory, 'workspaces/A'),
      problem: 'native_fixture_cancel: 等待后验证取消。',
      model,
    })
    const started = Date.now()
    while (!state.has('cancel')) {
      if (Date.now() - started > 10_000) throw new Error('Cancellation fixture never dispatched')
      await sleep(20)
    }
    const abort = await hook({
      kind: 'abort_session',
      sessionId,
      reason: 'zero-model cancellation acceptance',
    })
    await privateJson(join(directory, 'cancel-receipt.json'), abort)
    await waitForSettlement(hook, sessionId, 15_000)
    // 客户端取消不等于供应商物理结束；此时账本必须保持在途。
    assert.equal(inFlight, 1)
    assert.equal(ledger.state.requests.at(-1).status, 'reserved')
    unblockCancellation()
    const deadline = Date.now() + 10_000
    while (!ledger.state.requests.at(-1).finishedAt) {
      if (Date.now() > deadline) throw new Error('Late settlement did not finish')
      await sleep(20)
    }
    await privateJson(join(directory, 'trace-cancel.json'), await cdp.trace(sessionId))
    const codexIdentity = {
      ...identities[0],
      participantId: 'codex',
      taskId: 'fixture-codex',
      attemptId: runId + '-codex',
    }
    const codexDirectory = join(directory, 'codex')
    await mkdir(codexDirectory)
    const codexResult = await runCodex({
      executable: values.codex,
      workspace: directory,
      directory: codexDirectory,
      baseURL,
      apiKey: attemptCredential(codexIdentity, secret),
      model,
      prompt: 'native_fixture_codex: 只回复一句完成说明，不调用工具。',
      timeoutMs: 30_000,
    })
    await privateJson(join(codexDirectory, 'result.json'), codexResult)
    assert.equal(codexResult.terminalComplete, true)
    assert.ok(codexResult.threadId)
    await cdp.capture(join(directory, 'desktop.png'))
    outcome = {
      status: 'passed',
      modelCalls: 0,
      syntheticRequests: ledger.state.requests.length,
      peakUpstreamConcurrency: peak,
      backgroundSelectionPreserved: true,
      fullAccessOutsideWriteVerified: true,
      completeTraceVerified: true,
      cancellationLateSettlementVerified: true,
      contemporaryCodexVerified: true,
      sessions,
      identities,
    }
  } catch (error) {
    outcome = { status: 'failed', modelCalls: 0, error: error.stack, sessions }
    for (const sessionId of sessions)
      await hook({
        kind: 'abort_session',
        sessionId,
        reason: 'failed zero-model acceptance cleanup',
      }).catch(() => {})
    throw error
  } finally {
    unblockCancellation()
    try {
      await privateJson(join(directory, 'result.json'), outcome)
      await privateJson(join(directory, 'upstream-events.json'), Object.fromEntries(state))
      await hook({
        kind: 'config_op',
        key: 'system',
        op: 'patch',
        patch: { providerRuntimeConfigs: original.system.providerRuntimeConfigs },
      })
      outcome.fixtureCleanup = await cdp.deleteFixtures(
        sessions.map((id) => ({
          id,
          root: join(directory, 'workspaces', id.startsWith('native_fixture_B_') ? 'B' : 'A'),
        }))
      )
      await privateJson(join(directory, 'result.json'), outcome)
    } catch (error) {
      outcome.status = 'failed'
      outcome.finalizationError = error.stack
      await privateJson(join(directory, 'result.json'), outcome)
      throw error
    } finally {
      cdp.close()
      await close(gateway)
      await close(upstream)
      ledger.close()
    }
  }
  console.log(JSON.stringify(outcome))
}

void main().catch((error) => {
  console.error(error.stack)
  process.exitCode = 1
})
