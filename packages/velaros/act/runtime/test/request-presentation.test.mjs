import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'

import { summarizeModelRequest } from '../../../dist/act/runtime/utils/tracePresentation.js'

import { done } from './support/model-turn.mjs'
import { createTestRuntime as createRuntime } from './support/runtime-fixture.mjs'

const requestAudit = {
  schemaVersion: 3,
  model: 'model',
  modelTruncated: false,
  inputTokens: 1200,
  precision: 'estimate',
  basis: 'driver',
  basisTruncated: false,
  outputTokens: 4096,
  messageCount: 3,
  toolCount: 0,
  requestFingerprint: { id: '1234567890abcdef' },
}

test('INV-46 request presentation contains bounded metadata without a request replay contract', () => {
  const summary = summarizeModelRequest({ requestAudit })
  assert.deepEqual(summary, {
    model: 'model',
    modelTruncated: false,
    fingerprint: '1234567890abcdef',
    inputTokens: 1200,
    precision: 'estimate',
    basis: 'driver',
    basisTruncated: false,
    outputTokens: 4096,
    messageCount: 3,
    toolCount: 0,
  })
  for (const changed of [
    { outputTokens: -1 },
    { basis: 'x'.repeat(513) },
    { inputTokens: null },
    { schemaVersion: 2 },
  ])
    assert.equal(summarizeModelRequest({ requestAudit: { ...requestAudit, ...changed } }), null)
  assert.equal(summarizeModelRequest({ request: { instructions: 'old request body' } }), null)
})

test('SQLite request audits grow linearly while live history grows; model-free reopen follows the published frame and proof', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'request-audit-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'state.sqlite')
  const storage = localContextStorage({ path })
  const live = []
  const inputs = Array.from(
    { length: 8 },
    (_, index) => `PRIVATE_INPUT_${index}: ${'保留原始材料 '.repeat(600)}`
  )
  const runtime = await createRuntime({
    storage,

    context: { maintenance: false },
    model: {
      id: 'request-audit',
      limits: { contextTokens: 1_000_000, inputTokens: 900_000, outputTokens: 4096 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
      async *stream(request) {
        live.push(request)
        yield* done(
          request,
          live.length === inputs.length
            ? 'ORIGINAL_FINAL_RESPONSE'
            : `ORIGINAL_RESPONSE_${live.length}`
        )
      },
    },
  })
  const summaries = []
  try {
    const session = await runtime.openSession('s')
    for (const [index, input] of inputs.entries()) {
      const events = []
      for await (const event of session.submit(input)) events.push(event)
      assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
      assert.equal(live.length, index + 1)
    }
    assert(JSON.stringify(live.at(-1)).length > JSON.stringify(live[0]).length + inputs[0].length)
    const snapshot = await storage.load('s')
    const records = snapshot.records.filter((record) => record.title === 'model-request')
    assert.equal(records.length, inputs.length)
    let auditChars = 0
    let frameChars = 0
    for (const [index, record] of records.entries()) {
      const body = await storage.get('s', record.objectId)
      assert.equal(record.chars, body.length, 'the persisted contract counts UTF-16 code units')
      assert(body.length < 2048, `turn ${index}: ${body.length} UTF-16 units`)
      assert(!body.includes('PRIVATE_INPUT_'))
      assert(!body.includes('ORIGINAL_RESPONSE_'))
      const audit = JSON.parse(body)
      assert.equal(typeof audit.budgetRequest.requestId, 'string')
      assert.equal(typeof audit.budgetRequest.taskId, 'string')
      assert(!Object.hasOwn(audit, 'request'))
      assert(!Object.hasOwn(audit, 'providerRequest'))
      const frame = snapshot.records.find((item) => item.ref.id === audit.frameRef.id)
      assert(frame.sequence < record.sequence)
      const actual = JSON.parse(
        live[index].materials.find((item) => item.origin === 'runtime-view').text
      )
      assert.equal(frame.title, `context:frame:${actual.frameId}`)
      const frameBody = await storage.get('s', frame.objectId)
      frameChars += frameBody.length
      const frameAudit = JSON.parse(frameBody)
      assert(!Object.hasOwn(frameAudit, 'partitions'))
      assert(!frameBody.includes('PRIVATE_INPUT_'))
      const proof = snapshot.records.find(
        (item) => item.title === `context:request-proof:${actual.frameId}`
      )
      assert(proof.sources.some((source) => source.id === frame.ref.id))
      const trace = await session.trace(record.ref.id)
      assert(trace.records.some((item) => item.ref.id === frame.ref.id))
      assert(trace.records.some((item) => item.ref.id === proof.ref.id))
      assert.equal(trace.requestSummary.inputTokens, 1000)
      summaries.push(trace.requestSummary)
      auditChars += body.length
    }
    assert(auditChars < inputs.length * 2048)
    t.diagnostic(
      JSON.stringify({
        modelRequestUtf16: auditChars,
        contextFrameUtf16: frameChars,
        requests: records.length,
      })
    )
    assert(!snapshot.records.some((record) => record.title === 'model-request:image-data'))
    const originals = []
    for (const record of snapshot.records.filter((record) => record.kind === 'user'))
      originals.push(await storage.get('s', record.objectId))
    for (const input of inputs) assert(originals.includes(input))
  } finally {
    await runtime.close()
    await storage.close()
  }
  const reopened = localContextStorage({ path })
  const reader = await createRuntime({
    storage: reopened,
  })
  try {
    const page = await reader.trace('s', { limit: 32, fullContent: true })
    assert.deepEqual(
      page.turns.map((turn) => turn.requestSummary),
      summaries
    )
    assert(page.turns.at(-1).response.body.includes('ORIGINAL_FINAL_RESPONSE'))
    for (const turn of page.turns) {
      const audit = JSON.parse(turn.request.body)
      assert(turn.records.some((record) => record.ref.id === audit.frameRef.id))
      assert(!Object.hasOwn(turn.requestSummary, 'system'))
      assert(!Object.hasOwn(turn.requestSummary, 'messages'))
    }
  } finally {
    await reader.close()
    await reopened.close()
  }
})
