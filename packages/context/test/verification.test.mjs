import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createContextRuntime, createContextView } from '../dist/index.js'
import { localContextStorage } from '../dist/node.js'

async function fixture(t) {
  const storage = localContextStorage({ path: ':memory:' })
  t.after(() => storage.close())
  const context = createContextRuntime({ sessionId: 'checks', storage })
  const view = createContextView({ sessionId: 'checks', storage, context, sources: [] })
  const input = await context.append({ kind: 'user', body: 'Check the requested document.' })
  await view.begin(input.ref)
  await view.build({ maxChars: 12000 })
  return { context, view, input }
}

test('INV-16 without a domain verifier delivery completes with an explicit unverified result', async (t) => {
  const { view } = await fixture(t)
  const result = await view.complete()
  assert.equal(result.completed, true)
  assert.equal(result.verified, false)
})

test('complete domain checks cover declared artifacts and persist their original results', async (t) => {
  const { view, input } = await fixture(t)
  const result = await view.complete({
    requirements: () => [
      { id: 'document', label: 'document', artifacts: ['report.md'], sourceRefs: [input.ref] },
    ],
    verify: async () => ({
      verified: true,
      reason: 'document checked',
      report: {
        scope: 'document',
        checkedAt: new Date().toISOString(),
        checks: [
          {
            id: 'document',
            label: 'document',
            status: 'passed',
            complete: true,
            artifacts: [{ identity: 'report.md', contentHash: 'checked-content' }],
          },
        ],
      },
    }),
  })
  assert.equal(result.completed, true)
  assert.equal(result.verified, true)
  assert.deepEqual((await view.readCompletion()).result, result)
  assert.deepEqual(result.report.checks[0].requirement.sourceRefs, [input.ref])
})

test('INV-17 missing or incomplete declared artifacts cannot be overridden by a verified claim', async (t) => {
  for (const artifacts of [[], [{ identity: 'different.md', contentHash: 'other' }]]) {
    const { view, input } = await fixture(t)
    const result = await view.complete({
      requirements: () => [
        { id: 'document', label: 'document', artifacts: ['report.md'], sourceRefs: [input.ref] },
      ],
      verify: async () => ({
        verified: true,
        reason: 'claimed',
        report: {
          scope: 'document',
          checkedAt: new Date().toISOString(),
          checks: [
            {
              id: 'document',
              label: 'document',
              status: 'passed',
              complete: true,
              ...(artifacts.length ? { artifacts } : {}),
            },
          ],
        },
      }),
    })
    assert.equal(result.completed, false)
    assert.equal(result.verified, false)
    assert.equal(result.report.checks[0].status, 'unknown')
  }
})

test('failed, unknown and incomplete checks preserve a failed delivery', async (t) => {
  for (const check of [
    { status: 'failed', complete: true },
    { status: 'unknown', complete: true },
    { status: 'passed', complete: false },
  ]) {
    const { view } = await fixture(t)
    const result = await view.complete({
      verify: async () => ({
        verified: true,
        reason: 'claimed',
        report: {
          scope: 'document',
          checkedAt: new Date().toISOString(),
          checks: [{ label: 'document', ...check }],
        },
      }),
    })
    assert.equal(result.completed, false)
    assert.equal(result.verified, false)
  }
})

test('a domain verifier preserves its specific repair reason', async (t) => {
  const { view } = await fixture(t)
  const result = await view.complete({
    verify: async () => ({
      verified: false,
      reason: 'parse failed',
      recovery: 'repair',
      report: {
        scope: 'document',
        checkedAt: new Date().toISOString(),
        checks: [{ label: 'document parser', status: 'failed', complete: true }],
      },
    }),
  })
  assert.equal(result.completed, false)
  assert.equal(result.reason, 'parse failed')
  assert.equal((await view.readCompletion()).result.reason, 'parse failed')
})

test('domain requirements must cite the current original user input', async (t) => {
  const { context, view } = await fixture(t)
  const generated = await context.append({ kind: 'assistant', body: 'An invented requirement' })
  await assert.rejects(
    view.complete({
      requirements: () => [
        { id: 'invented', label: 'invented', artifacts: [], sourceRefs: [generated.ref] },
      ],
      verify: async () => ({ verified: true, reason: 'claimed' }),
    }),
    { code: 'VALIDATION' }
  )
})
