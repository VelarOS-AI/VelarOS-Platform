import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createRuntime } from '../../../dist/act/runtime/index.js'
import { summarizeModelRequest } from '../../../dist/act/runtime/utils/tracePresentation.js'

import { done } from './support/model-turn.mjs'

const audit = {
  providerRequest: {
    schemaVersion: 2,
    model: 'model',
    system: 'system instructions',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'user input' },
          { type: 'image', image: 'data:image/png;base64,PRIVATE_BINARY', mediaType: 'image/png' },
          { data: { $velarosType: 'bytes', value: 'PRIVATE_BYTES' } },
        ],
      },
    ],
    outputTokens: 4096,
    requestFingerprint: { id: 'fp' },
  },
  estimate: { tokens: 1200, precision: 'estimate', basis: 'driver' },
}
test('INV-46 request presentation uses sealed fields and omits binary media', () => {
  const value = summarizeModelRequest(audit, 100000)
  assert.equal(value.model, 'model')
  assert.equal(value.fingerprint, 'fp')
  assert.equal(value.inputTokens, 1200)
  assert.equal(value.precision, 'estimate')
  assert.equal(value.basis, 'driver')
  assert.equal(value.system, audit.providerRequest.system)
  assert.equal(value.outputTokens, 4096)
  assert.equal(value.mediaOmitted, true)
  assert.match(value.messages, /user input/)
  assert.doesNotMatch(value.messages, /PRIVATE_BINARY|PRIVATE_BYTES/)
  assert.equal(
    audit.providerRequest.messages[0].content[1].image,
    'data:image/png;base64,PRIVATE_BINARY'
  )
})
test('small budgets retain request identity and mark truncation; absent facts stay absent', () => {
  const value = summarizeModelRequest(audit, 9)
  assert.equal(value.system.length + value.messages.length, 9)
  assert(value.systemTruncated)
  assert(value.messagesTruncated)
  assert.equal(value.fingerprint, 'fp')
  const missing = summarizeModelRequest({ providerRequest: audit.providerRequest }, 32000)
  assert.equal(missing.inputTokens, null)
  assert.equal(missing.precision, null)
  assert.equal(missing.basis, null)
  assert.equal(
    summarizeModelRequest({ request: { instructions: 'legacy inferred body' } }, 32000),
    null
  )
  assert.equal(
    summarizeModelRequest(
      { ...audit, providerRequest: { ...audit.providerRequest, outputTokens: -1 } },
      32000
    ),
    null
  )
})
test('real request summaries share the trace body budget and survive a model-free reopen', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'request-view-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const frames = []
  const runtime = await createRuntime({
    dataDir,
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false },
    model: {
      id: 'request-view',
      limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
      async *stream(request) {
        frames.push(request)
        yield* done(request)
      },
    },
  })
  let turnId
  try {
    const session = await runtime.openSession('s')
    for await (const event of session.submit('check this input'))
      if (event.type === 'turn') turnId = event.turnId
    const trace = await session.trace(turnId, 500)
    assert.equal(trace.requestSummary.model, 'request-view')
    assert.equal(trace.requestSummary.inputTokens, 1000)
    assert(frames[0].instructions.startsWith(trace.requestSummary.system))
    const bodyChars =
      [
        trace.request,
        trace.response,
        trace.decision,
        ...trace.records,
        ...trace.invocations,
      ].reduce((n, item) => n + (item?.body?.length ?? 0), 0) +
      trace.requestSummary.system.length +
      trace.requestSummary.messages.length +
      trace.invocations.reduce(
        (n, item) => n + item.summary.input.length + item.summary.output.length,
        0
      )
    assert(bodyChars <= 500)
  } finally {
    await runtime.close()
  }
  const reader = await createRuntime({ dataDir, agents: false, search: false, memory: false })
  try {
    const page = await reader.trace('s', { maxChars: 100000 })
    assert.equal(page.turns[0].turnId, turnId)
    assert.equal(page.turns[0].requestSummary.system, frames[0].instructions.slice(0, 8000))
    assert.match(page.turns[0].requestSummary.messages, /check this input/)
  } finally {
    await reader.close()
  }
})

test('full request text bypasses summary limits and keeps the media placeholder', () => {
  const system = `${'系统指令\n'.repeat(2000)}SYSTEM_END`
  const content = `${'request line\n'.repeat(4000)}MESSAGE_END`
  const request = {
    ...audit,
    providerRequest: {
      ...audit.providerRequest,
      system,
      messages: [...audit.providerRequest.messages, { role: 'user', content }],
    },
  }
  const full = summarizeModelRequest(request, 1, true)
  assert.equal(full.system, system)
  assert.equal(JSON.parse(full.messages).at(-1).content, content)
  assert.equal(full.systemTruncated, false)
  assert.equal(full.messagesTruncated, false)
  assert.equal(full.mediaOmitted, true)
  assert.doesNotMatch(full.messages, /PRIVATE_BINARY|PRIVATE_BYTES/)
})
