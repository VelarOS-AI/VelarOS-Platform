import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { BudgetLedger, budgetServer } from './budget-proxy.mjs'
import { attemptCredential } from './request-identity.mjs'

const usage = {
  input_tokens: 100,
  output_tokens: 10,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
}
const sse = (record) => `data: ${JSON.stringify(record)}\n\n`
const delta = sse({ type: 'response.output_text.delta', delta: 'synthetic 中😀' })
const completed = sse({
  type: 'response.completed',
  response: { usage, reasoning: { context: 'all_turns' } },
})
async function until(check) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Offline stream fixture deadline')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
async function fixture(t, handle) {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-stream-'))
  const ledger = new BudgetLedger(directory, 'unlimited', { model: 'fixture-model' })
  const releases = []
  const receivedBodies = []
  const upstream = createServer(async (req, res) => {
    const input = []
    for await (const chunk of req) input.push(chunk)
    receivedBodies.push(JSON.parse(Buffer.concat(input).toString('utf8')))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    await handle(res, releases)
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const gateway = budgetServer({
    ledger,
    apiKey: 'synthetic-provider',
    token: 'synthetic-signing',
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  }).listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  const identity = {
    campaignId: 'stream-fixture',
    candidateId: 'candidate',
    participantId: 'agent',
    taskId: 'task',
    attemptId: 'attempt',
    jobId: 'job',
    phase: 'source',
  }
  const headers = { authorization: `Bearer ${attemptCredential(identity, 'synthetic-signing')}` }
  t.after(async () => {
    for (const release of releases) release()
    gateway.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([new Promise((r) => gateway.close(r)), new Promise((r) => upstream.close(r))])
    await until(() => ledger.state.requests.every((row) => row.finishedAt))
    ledger.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    ledger,
    receivedBodies,
    send: (endpoint = '/v1/responses', signal = AbortSignal.timeout(3000), options = {}) =>
      fetch(`http://127.0.0.1:${gateway.address().port}${endpoint}`, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          model: 'fixture-model',
          stream: true,
          input: 'synthetic',
          ...options,
        }),
      }),
  }
}

test('an upstream reset after HTTP 200 rejects downstream reads and preserves unknown usage', async (t) => {
  const f = await fixture(t, async (res) => {
    res.write(delta)
    await new Promise((r) => setTimeout(r, 30))
    res.destroy()
  })
  const response = await f.send()
  assert.equal(response.status, 200)
  await assert.rejects(response.text())
  await until(() => f.ledger.state.requests[0]?.finishedAt)
  const row = f.ledger.state.requests[0]
  assert.equal(row.status, 'http-200-interrupted')
  assert.equal(row.usage, null)
  assert.equal(row.estimatedUsd, null)
  assert(row.failure.causeCode)
  assert.equal(row.stream.terminalStatus, null)
  assert.equal(row.stream.firstTerminalMs, null)
  assert.equal(row.stream.terminalMs, null)
  assert.deepEqual(row.stream.effectiveReasoningContext, { state: 'unobserved' })
  assert.equal(row.stream.transportEnded, 'interrupted')
  assert(row.stream.transportEndedMs >= row.lastByteMs)
  assert(row.stream.transportEndedMs <= row.durationMs)
  assert(row.stream.receivedBytes > 0)
})

test('clean EOF without a complete Responses terminal fails even with syntactically complete output', async (t) => {
  const f = await fixture(t, async (res) => {
    res.end(delta)
  })
  await assert.rejects(async () => (await f.send()).text())
  const row = f.ledger.state.requests[0]
  assert.equal(row.status, 'http-200-interrupted')
  assert.equal(row.failure.code, 'UPSTREAM_STREAM_TRUNCATED')
  assert.equal(row.stream.transportEnded, 'eof')
  assert.equal(row.estimatedUsd, null)
})

test('failed and incomplete terminals remain failures while later usage is retained', async (t) => {
  for (const terminal of ['response.failed', 'response.incomplete']) {
    await t.test(terminal, async (t) => {
      const f = await fixture(t, async (res) => {
        res.write(delta + sse({ type: terminal, response: { status: terminal.split('.')[1] } }))
        await new Promise((r) => setTimeout(r, 20))
        res.end(sse({ usage }))
      })
      await assert.rejects(async () => (await f.send()).text())
      const row = f.ledger.state.requests[0]
      assert.equal(row.status, 'http-200-interrupted')
      assert.equal(row.stream.terminalEvent, terminal)
      assert.equal(row.stream.terminalStatus, terminal.split('.')[1])
      assert.deepEqual(row.usage, usage)
      assert(row.estimatedUsd > 0)
    })
  }
})

test('fragmented UTF-8 and multiline SSE retain terminal identity and usage', async (t) => {
  const body =
    ': keepalive\r\n\r\n' +
    delta.replaceAll('\n', '\r\n') +
    'event: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":' +
    JSON.stringify({ usage }) +
    '}\r\n\r\n'
  const f = await fixture(t, async (res) => {
    const bytes = Buffer.from(body)
    for (let start = 0; start < bytes.length; start += 7) {
      res.write(bytes.subarray(start, start + 7))
      await new Promise((r) => setTimeout(r, 1))
    }
    res.end()
  })
  assert.equal(await (await f.send()).text(), body)
  const row = f.ledger.state.requests[0]
  assert.equal(row.status, 'http-200')
  assert.equal(row.stream.terminalStatus, 'completed')
  assert.equal(row.stream.events, 2)
  assert.equal(row.stream.receivedBytes, Buffer.byteLength(body))
  assert.deepEqual(row.usage, usage)
})

test('a terminal-looking event without an SSE dispatch delimiter is truncated', async (t) => {
  const f = await fixture(t, async (res) => {
    res.end(delta + completed.trimEnd())
  })
  await assert.rejects(async () => (await f.send()).text())
  assert.equal(f.ledger.state.requests[0].failure.code, 'UPSTREAM_STREAM_TRUNCATED')
})

test('an explicit SSE error or corrupt event cannot be converted to success by a later completion', async (t) => {
  for (const failedEvent of ['event: error\ndata: {"code":"synthetic"}\n\n', 'data: {broken\n\n']) {
    await t.test(failedEvent.startsWith('event:') ? 'error event' : 'invalid JSON', async (t) => {
      const f = await fixture(t, async (res) => {
        res.end(delta + failedEvent + completed)
      })
      await assert.rejects(async () => (await f.send()).text())
      const row = f.ledger.state.requests[0]
      assert.equal(row.status, 'http-200-interrupted')
      assert.deepEqual(row.usage, usage)
      assert(['UPSTREAM_STREAM_FAILED', 'UPSTREAM_STREAM_INVALID_EVENT'].includes(row.failure.code))
    })
  }
})

test('Chat Completions keeps reading after finish_reason until late usage and DONE arrive', async (t) => {
  let release
  const f = await fixture(t, async (res, releases) => {
    res.write(sse({ choices: [{ delta: { content: 'synthetic' }, finish_reason: 'stop' }] }))
    await new Promise((r) => {
      release = r
      releases.push(r)
    })
    res.end(sse({ choices: [], usage }) + 'data: [DONE]\n\n')
  })
  const response = await f.send('/v1/chat/completions')
  assert.equal(f.ledger.state.requests[0].finishedAt, undefined)
  release()
  await response.text()
  const row = f.ledger.state.requests[0]
  assert.equal(row.status, 'http-200')
  assert.equal(row.stream.terminalEvent, '[DONE]')
  assert.deepEqual(row.usage, usage)
})

test('client cancellation preserves the upstream work and its late settlement', async (t) => {
  let release
  const f = await fixture(t, async (res, releases) => {
    res.write(delta)
    await new Promise((r) => {
      release = r
      releases.push(r)
    })
    res.end(completed)
  })
  const abort = new AbortController()
  const response = await f.send('/v1/responses', abort.signal)
  abort.abort()
  await assert.rejects(response.text())
  await until(() => f.ledger.state.requests[0].clientDisconnectedAt)
  assert.equal(f.ledger.state.requests[0].finishedAt, undefined)
  release()
  await until(() => f.ledger.state.requests[0].finishedAt)
  const row = f.ledger.state.requests[0]
  assert.equal(row.status, 'http-200')
  assert.equal(row.stream.terminalStatus, 'completed')
  assert.deepEqual(row.usage, usage)
})

test('a transport error after a complete terminal preserves received usage without hiding the error', async (t) => {
  const f = await fixture(t, async (res) => {
    res.write(delta + completed)
    await new Promise((r) => setTimeout(r, 20))
    res.destroy()
  })
  await assert.rejects(async () => (await f.send()).text())
  const row = f.ledger.state.requests[0]
  assert.equal(row.status, 'http-200-interrupted')
  assert.equal(row.stream.terminalStatus, 'completed')
  assert.equal(row.stream.transportEnded, 'interrupted')
  assert.deepEqual(row.usage, usage)
})

test('terminal observation is separate from EOF and remains reserved until the tail settles', async (t) => {
  let release
  const f = await fixture(t, async (res, releases) => {
    res.write(delta + completed)
    await new Promise((r) => {
      release = r
      releases.push(r)
    })
    res.end(': tail heartbeat\n\n')
  })
  const response = await f.send()
  await until(() => typeof f.ledger.state.requests[0]?.stream?.terminalMs === 'number')
  const row = f.ledger.state.requests[0]
  const first = row.stream.terminalMs
  assert.equal(row.stream.firstTerminalMs, first)
  assert.equal(row.stream.transportEndedMs, null)
  assert.equal(row.status, 'reserved')
  assert.equal(row.finishedAt, undefined)
  await new Promise((r) => setTimeout(r, 30))
  release()
  assert.equal(await response.text(), delta + completed + ': tail heartbeat\n\n')
  assert.equal(row.stream.terminalMs, first)
  assert(row.stream.transportEndedMs - first >= 20)
  assert(row.lastByteMs > first)
  assert(row.stream.transportEndedMs <= row.durationMs)
  assert.equal(row.status, 'http-200')
  assert.deepEqual(row.usage, usage)
  assert.deepEqual(row.stream.effectiveReasoningContext, { state: 'value', value: 'all_turns' })
})

test('a partial terminal is unobserved until its delimiter and a later failure keeps its own time', async (t) => {
  let release
  const f = await fixture(t, async (res, releases) => {
    res.write(delta + completed.trimEnd() + '\n')
    await new Promise((r) => {
      release = r
      releases.push(r)
    })
    res.write('\n')
    await new Promise((r) => setTimeout(r, 30))
    res.end(sse({ type: 'response.failed', response: { status: 'failed', usage } }))
  })
  const response = await f.send()
  const row = f.ledger.state.requests[0]
  assert.equal(row.stream.firstTerminalMs, null)
  assert.equal(row.stream.terminalMs, null)
  release()
  await assert.rejects(response.text())
  assert.equal(row.stream.terminalEvent, 'response.failed')
  assert(row.stream.terminalMs > row.stream.firstTerminalMs)
  assert(row.stream.transportEndedMs >= row.stream.terminalMs)
  assert.equal(row.failure.code, 'UPSTREAM_STREAM_FAILED')
  assert.deepEqual(row.usage, usage)
})

test('wire observations distinguish absent, null and explicit options without recording arbitrary values', async (t) => {
  const f = await fixture(t, async (res) => res.end(completed))
  const options = [
    {},
    {
      reasoning: { summary: null },
      text: { verbosity: null },
      parallel_tool_calls: null,
      include: null,
    },
    {
      reasoning: { summary: 'auto' },
      text: { verbosity: 'low' },
      parallel_tool_calls: false,
      include: ['reasoning.encrypted_content'],
      store: true,
    },
    {
      reasoning: { summary: 'synthetic-private-summary' },
      text: { verbosity: { private: 'synthetic-private-value' } },
      parallel_tool_calls: 'synthetic-private-parallel',
      include: ['synthetic-private-include'],
    },
  ]
  for (const value of options) await (await f.send('/v1/responses', undefined, value)).text()
  const observed = f.ledger.state.requests.map((row) => row.metadata.wireOptions)
  for (const key of ['reasoningSummary', 'textVerbosity', 'parallelToolCalls', 'include']) {
    assert.equal(observed[0][key].state, 'absent')
    assert.equal(observed[1][key].state, 'null')
  }
  assert.deepEqual(observed[2], {
    reasoningContext: { state: 'absent' },
    reasoningSummary: { state: 'value', value: 'auto' },
    textVerbosity: { state: 'value', value: 'low' },
    parallelToolCalls: { state: 'value', value: false },
    store: { state: 'value', value: false },
    include: { state: 'value', count: 1, encryptedReasoning: true },
  })
  for (const key of ['reasoningSummary', 'textVerbosity', 'parallelToolCalls'])
    assert.equal(observed[3][key].state, 'other')
  assert.deepEqual(observed[3].include, { state: 'value', count: 1, encryptedReasoning: false })
  assert(!JSON.stringify(f.ledger.state).includes('synthetic-private'))
  for (const [index, input] of options.entries())
    for (const [key, value] of Object.entries(input))
      assert.deepEqual(f.receivedBodies[index][key], key === 'store' ? false : value)
})

test('last activity timestamps distinguish delayed semantic deltas from later bytes', async (t) => {
  const reasoning = sse({ type: 'response.reasoning_summary_text.delta', delta: 'synthetic' })
  const tool = sse({ type: 'response.function_call_arguments.delta', delta: '{}' })
  const custom = sse({ type: 'response.custom_tool_call_input.delta', delta: 'synthetic' })
  const heartbeat = ': keepalive\n\n'
  const f = await fixture(t, async (res) => {
    res.write(reasoning)
    await new Promise((r) => setTimeout(r, 20))
    res.write(delta + tool)
    await new Promise((r) => setTimeout(r, 20))
    res.write(delta + custom)
    await new Promise((r) => setTimeout(r, 20))
    res.write(heartbeat)
    await new Promise((r) => setTimeout(r, 20))
    res.end(completed)
  })
  assert.equal(
    await (await f.send()).text(),
    reasoning + delta + tool + delta + custom + heartbeat + completed
  )
  const row = f.ledger.state.requests[0]
  assert.equal(row.status, 'http-200')
  assert.deepEqual(row.usage, usage)
  for (const kind of ['Byte', 'Output', 'ToolInput', 'Reasoning']) {
    const first = row[`first${kind}Ms`]
    const last = row[`last${kind}Ms`]
    assert(Number.isFinite(last), `last${kind}Ms must be measured`)
    assert(last >= first)
    assert(last <= row.durationMs)
    assert.equal(JSON.parse(readFileSync(f.ledger.path, 'utf8')).requests[0][`last${kind}Ms`], last)
  }
  assert(row.lastOutputMs > row.firstOutputMs)
  assert(row.lastToolInputMs > row.firstToolInputMs)
  assert.equal(row.lastReasoningMs, row.firstReasoningMs)
  assert(row.lastByteMs > row.lastOutputMs)
})

test('reset after a heartbeat preserves the observed silent tail and unknown usage', async (t) => {
  const f = await fixture(t, async (res) => {
    res.write(delta)
    await new Promise((r) => setTimeout(r, 20))
    res.write(': keepalive\n\n')
    await new Promise((r) => setTimeout(r, 40))
    res.destroy()
  })
  await assert.rejects(async () => (await f.send()).text())
  const row = f.ledger.state.requests[0]
  assert.equal(row.status, 'http-200-interrupted')
  assert(Number.isFinite(row.lastByteMs))
  assert.equal(row.lastOutputMs, row.firstOutputMs)
  assert(row.lastByteMs - row.lastOutputMs >= 10)
  assert(row.durationMs - row.lastByteMs >= 25)
  assert.equal(row.lastToolInputMs, null)
  assert.equal(row.lastReasoningMs, null)
  assert.equal(row.usage, null)
  assert.equal(row.estimatedUsd, null)
  assert.equal(row.stream.terminalStatus, null)
})

test('a terminal without deltas records bytes while unobserved semantic activity stays null', async (t) => {
  const f = await fixture(t, async (res) => res.end(completed))
  assert.equal(await (await f.send()).text(), completed)
  const row = f.ledger.state.requests[0]
  assert.equal(row.status, 'http-200')
  assert(Number.isFinite(row.lastByteMs))
  assert.equal(row.lastOutputMs, null)
  assert.equal(row.lastToolInputMs, null)
  assert.equal(row.lastReasoningMs, null)
  assert.deepEqual(row.usage, usage)
})

test('client disconnect still records later upstream output and terminal settlement', async (t) => {
  let release
  const f = await fixture(t, async (res, releases) => {
    res.write(delta)
    await new Promise((r) => {
      release = r
      releases.push(r)
    })
    await new Promise((r) => setTimeout(r, 20))
    res.end(delta + completed)
  })
  const abort = new AbortController()
  const response = await f.send('/v1/responses', abort.signal)
  abort.abort()
  await assert.rejects(response.text())
  await until(() => f.ledger.state.requests[0].clientDisconnectedAt)
  const row = f.ledger.state.requests[0]
  const before = row.lastOutputMs
  assert(Number.isFinite(before))
  assert.equal(row.finishedAt, undefined)
  release()
  await until(() => row.finishedAt)
  assert(row.lastOutputMs > before)
  assert(row.lastByteMs > row.firstByteMs)
  assert.equal(row.status, 'http-200')
  assert.equal(row.stream.terminalStatus, 'completed')
  assert.deepEqual(row.usage, usage)
})

test('Chat Completions activity timestamps follow the same text, tool and reasoning categories', async (t) => {
  const item = sse({
    choices: [
      {
        delta: {
          content: 'synthetic',
          reasoning_content: 'synthetic',
          tool_calls: [{ function: { arguments: '{}' } }],
        },
      },
    ],
  })
  const f = await fixture(t, async (res) => {
    res.write(item)
    await new Promise((r) => setTimeout(r, 20))
    res.write(item)
    await new Promise((r) => setTimeout(r, 20))
    res.end(sse({ choices: [], usage }) + 'data: [DONE]\n\n')
  })
  await (await f.send('/v1/chat/completions')).text()
  const row = f.ledger.state.requests[0]
  assert.equal(row.status, 'http-200')
  assert.deepEqual(row.usage, usage)
  for (const kind of ['Output', 'ToolInput', 'Reasoning']) {
    assert(Number.isFinite(row[`last${kind}Ms`]))
    assert(row[`last${kind}Ms`] > row[`first${kind}Ms`])
    assert(row.lastByteMs > row[`last${kind}Ms`])
  }
})
