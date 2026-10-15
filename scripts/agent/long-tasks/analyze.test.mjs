import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  completionSummary,
  desktopBranchEvidence,
  findCodexRollout,
  pytestSummary,
  regressionSummary,
  requestOwner,
  readRuntimeRequestSummary,
  summarizeRequests,
} from './analyze.mjs'

test('request archive summaries keep root/branch attribution and the last root prompt without retaining bodies', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-request-summary-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const prompt = 'Quoted "task"\nwith a second line'
  const frame = (sessionId) =>
    JSON.stringify({ partitions: { task: { goals: [{ record: { ref: { sessionId } } }] } } })
  const request = (cacheKey, owner, extra = {}) => ({
    cacheKey,
    history: [{ role: 'user', content: prompt }],
    materials: [{ origin: 'runtime-view', text: frame(owner) }],
    response: { type: 'tools' },
    ...extra,
  })
  const requests = [
    request('root-key', 'root'),
    request('child-key', 'child', {
      materials: [
        { origin: 'runtime-view', text: frame('child') },
        { origin: 'completion-review', text: '' },
      ],
    }),
    request('root-key', 'root', { contextStatus: { segment: { index: 2 } } }),
    request('context-key', 'context', {
      history: [],
      response: { type: 'text' },
      materials: [
        {
          origin: 'context-narration',
          text: JSON.stringify({ kind: 'context-narration', sessionId: 'context' }),
        },
      ],
    }),
  ]
  for (const [index, value] of requests.entries())
    await writeFile(
      join(directory, String(index).padStart(4, '0') + '.json'),
      JSON.stringify({ request: value })
    )
  await writeFile(join(directory, 'wire-ignored.json'), 'not a request record')
  assert.deepEqual(await readRuntimeRequestSummary(directory, { prompt }), {
    mainRequests: 2,
    branchRequests: 2,
    completionReviewRequests: 1,
    requestOwners: { root: 2, child: 1, context: 1 },
    contextSegments: 2,
    nativeRequests: 3,
    textProtocolRequests: 1,
    structuredNarrationRequests: 1,
    originalPromptInFinalRequest: true,
  })
  await writeFile(join(directory, '0002.json'), '{broken')
  await assert.rejects(readRuntimeRequestSummary(directory, { prompt }), SyntaxError)
})

test('passing automatic checks do not turn a failed or waiting Runtime task into completion', () => {
  for (const status of ['failed', 'waiting', 'cancelled']) {
    const result = completionSummary(
      'scriptact',
      { status, failure: 'Independent review incomplete', goal: { status: 'active' } },
      { passed: true, featureCompleteWithoutNewRegressions: true },
      { taskMode: 'goal' }
    )
    assert.equal(result.automaticChecksPassed, true)
    assert.equal(result.terminalComplete, false)
    assert.equal(result.completedWithPassingChecks, false)
    assert.equal(result.fullDeliveryVerified, null)
  }
})

test('Runtime goal completion requires the persisted goal and does not imply passing acceptance', () => {
  for (const [goal, expected] of [
    [{ status: 'complete' }, true],
    [{ status: 'active' }, false],
    [undefined, null],
  ]) {
    const result = completionSummary(
      'scriptact',
      { status: 'completed', goal },
      { passed: true },
      { taskMode: 'goal' }
    )
    assert.equal(result.terminalComplete, expected)
    assert.equal(result.completedWithPassingChecks, expected)
  }
  const result = completionSummary(
    'scriptact',
    { status: 'completed', goal: { status: 'complete' } },
    { passed: false, featureCompleteWithoutNewRegressions: false },
    { taskMode: 'goal' }
  )
  assert.equal(result.terminalComplete, true)
  assert.equal(result.completedWithPassingChecks, false)
  assert.equal(result.fullDeliveryVerified, null)
  assert.equal(
    completionSummary(
      'scriptact',
      { status: 'completed', goal: { status: 'complete' }, goalSnapshotError: 'read failed' },
      { passed: true },
      { taskMode: 'goal' }
    ).terminalComplete,
    null
  )
  assert.equal(
    completionSummary('scriptact', { status: 'completed' }, { passed: true }).terminalComplete,
    true
  )
})

test('Codex requires its explicit successful terminal and clean process outcome', () => {
  const solve = { code: 0, signal: null, terminalComplete: true, timedOut: false, cancelled: false }
  assert.equal(completionSummary('codex', solve, { passed: true }).terminalComplete, true)
  for (const changed of [
    { code: 1 },
    { signal: 'SIGTERM' },
    { terminalComplete: false },
    { timedOut: true },
    { cancelled: true },
    { inputError: 'stdin failed' },
  ])
    assert.equal(
      completionSummary('codex', { ...solve, ...changed }, { passed: true }).terminalComplete,
      false
    )
  assert.equal(completionSummary('codex', { code: 0 }, { passed: true }).terminalComplete, null)
  assert.equal(
    completionSummary('codex', { terminalComplete: true }, { passed: true }).terminalComplete,
    null
  )
})

test('Desktop idle receipts, complete traces and missing measurements are not completion proof', () => {
  const result = completionSummary(
    'scriptact',
    {
      host: 'desktop',
      status: 'settled',
      evidenceComplete: true,
      terminal: { running: false, settleReason: 'completed', observedRunning: true },
    },
    { passed: true }
  )
  assert.equal(result.terminalComplete, null)
  assert.equal(result.completedWithPassingChecks, null)
  assert.equal(result.fullDeliveryVerified, null)
  const missing = completionSummary('scriptact', {}, {})
  assert.equal(missing.terminalComplete, null)
  assert.equal(missing.automaticChecksPassed, null)
  assert.equal(missing.completedWithPassingChecks, null)
  assert.equal(
    completionSummary('scriptact', { status: 'failed' }, {}).completedWithPassingChecks,
    false
  )
  assert.equal(
    completionSummary('scriptact', {}, { passed: false }).completedWithPassingChecks,
    false
  )
})

test('admission refusals do not become paid requests or erase unknown usage reservations', () => {
  const value = summarizeRequests(
    [
      {
        status: 'http-200',
        estimatedUsd: 0.25,
        budgetUsd: 0.5,
        durationMs: 200,
        usage: { input_tokens: 100, output_tokens: 20 },
      },
      { status: 'unknown', estimatedUsd: null, budgetUsd: 20, durationMs: 600, usage: null },
    ],
    [{ code: 'CAMPAIGN_BUDGET_EXHAUSTED' }, { code: 'CAMPAIGN_BUDGET_EXHAUSTED' }]
  )
  assert.equal(value.requests, 2)
  assert.equal(value.rejectedBeforeDispatch, 2)
  assert.deepEqual(value.rejectionCodes, { CAMPAIGN_BUDGET_EXHAUSTED: 2 })
  assert.equal(value.totalReferenceUsd, null)
  assert.equal(value.unknownUsageReservationUsd, 20)
  assert.equal(value.providerDurations.summedMs, 800)
  assert.equal(value.providerDurations.p95Ms, 600)
  assert.equal(summarizeRequests([]).tokenCoverage, 'unknown')
  assert.equal(summarizeRequests([]).totalReferenceUsd, null)
})

test('context and verification requests are separated without inventing a successful apply', () => {
  const branches = [
    { sessionId: 'summary', kind: 'context' },
    { sessionId: 'review', kind: 'verification' },
  ]
  const result = desktopBranchEvidence(
    [
      { sessionId: 'root', branches, turns: [{ response: 'accepted' }] },
      {
        sessionId: 'summary',
        branches,
        turns: [{ response: 'rejected' }, { response: 'accepted' }],
      },
      { sessionId: 'review', branches, turns: [{ response: 'accepted' }] },
    ],
    'root'
  )
  assert.deepEqual(result.modelTurnsByKind, { main: 1, context: 2, verification: 1 })
  assert.equal(result.maintenanceBranches, 1)
  assert.equal(result.acceptedMaintenanceResponses, 1)
  assert.equal(result.rejectedMaintenanceResponses, 1)
  assert.equal(result.appliedMaintenanceOutcomes, null)
})

test('request attribution counts direct narration alongside normal runtime sessions', () => {
  const normal = {
    materials: [
      {
        origin: 'runtime-view',
        text: JSON.stringify({
          partitions: { task: { goals: [{ record: { ref: { sessionId: 'root' } } }] } },
        }),
      },
    ],
  }
  const narration = {
    materials: [
      {
        origin: 'context-narration',
        text: JSON.stringify({ kind: 'context-narration', sessionId: 'context:child' }),
      },
    ],
  }
  assert.equal(requestOwner(normal), 'root')
  assert.equal(requestOwner(narration), 'context:child')
  assert.equal(requestOwner({ materials: [{ origin: 'runtime-view', text: '{}' }] }), 'unknown')
})

test('rollout discovery covers host dates across midnight and ignores other threads', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rollout-dates-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const day = join(directory, '2026/10/05')
  await mkdir(day, { recursive: true })
  const source = join(day, 'rollout-2026-10-05T00-01-00-target-thread.jsonl')
  await writeFile(source, '')
  await writeFile(join(day, 'rollout-2026-10-05T00-01-00-other-thread.jsonl'), '')
  const startedAt = Date.parse('2026-10-04T16:00:00Z')
  const finishedAt = Date.parse('2026-10-04T16:10:00Z')
  assert.equal(await findCodexRollout(directory, 'target-thread', startedAt, finishedAt), source)
  assert.equal(await findCodexRollout(directory, 'missing-thread', startedAt, finishedAt), null)
})

test('failed and unmeasured attempts remain in the denominator and total cost stays unknown', () => {
  const result = summarizeRequests([
    {
      status: 'http-200',
      usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40 } },
      estimatedUsd: 0.01,
    },
    { status: 'http-200-interrupted', usage: null, estimatedUsd: null },
  ])
  assert.equal(result.requests, 2)
  assert.equal(result.measuredRequests, 1)
  assert.equal(result.tokenCoverage, 'partial')
  assert.equal(result.totalReferenceUsd, null)
  assert.equal(result.knownReferenceUsd, 0.01)
  assert.equal(result.knownCacheRatio, 0.4)
})

test('missing cache details are unknown even when input and output usage are measured', () => {
  const result = summarizeRequests([
    { status: 'http-200', usage: { input_tokens: 100, output_tokens: 10 }, estimatedUsd: null },
  ])
  assert.equal(result.tokenCoverage, 'complete')
  assert.equal(result.knownCacheRatio, null)
  assert.equal(result.totalReferenceUsd, null)
})

test('pytest failure and collection error counts remain distinct from a passing process', () => {
  assert.deepEqual(
    pytestSummary({
      exitCode: 1,
      stdout: 'FAILED tests/test_a.py::test_b\n1 failed, 854 passed, 25 skipped in 3.70s\n',
    }),
    {
      exitCode: 1,
      passed: 854,
      failed: 1,
      skipped: 25,
      errors: 0,
      summary: '1 failed, 854 passed, 25 skipped in 3.70s',
      failures: ['FAILED tests/test_a.py::test_b'],
    }
  )
  assert.equal(pytestSummary({ exitCode: 2, stdout: '1 error in 0.01s\n' }).errors, 1)
})

test('unittest records its stderr summary, skips and individual failures', () => {
  assert.deepEqual(
    regressionSummary(
      {
        exitCode: 1,
        stdout: '',
        stderr:
          'FAIL: test_scope (Scope)\nRan 12 tests in 0.1s\n\nFAILED (failures=1, errors=2, skipped=3)\n',
      },
      'unittest'
    ),
    {
      exitCode: 1,
      passed: 6,
      failed: 1,
      errors: 2,
      skipped: 3,
      summary: 'FAILED (failures=1, errors=2, skipped=3)',
      failures: ['FAIL: test_scope (Scope)'],
    }
  )
  assert.equal(
    regressionSummary(
      { exitCode: 0, stderr: 'Ran 12 tests in 0.1s\n\nOK (skipped=2)\n' },
      'unittest'
    ).passed,
    10
  )
})

test('native Node regression retains verified counts and compatibility verdicts', () => {
  const summary = {
    exitCode: 0,
    passed: 209,
    failed: 0,
    skipped: 0,
    errors: 0,
    summary: '209 native Node tests, 0 suite errors',
    failures: [],
  }
  const verdict = { baselineCompatible: true, suitePassed: true, unexpected: [] }
  assert.deepEqual(
    regressionSummary({ exitCode: 0, stdout: '{}', summary, verdict }, 'node-json'),
    { ...summary, verdict }
  )
})

test('native Node raw reports count failures, cancellations and skips without pytest parsing', () => {
  const result = regressionSummary(
    {
      exitCode: 1,
      stdout: JSON.stringify({
        schema: 'node-test-regression-1',
        summaries: [
          {
            success: false,
            counts: {
              tests: 5,
              suites: 0,
              passed: 1,
              failed: 1,
              cancelled: 1,
              skipped: 1,
              todo: 1,
            },
          },
        ],
        cases: ['passed', 'failed', 'failed', 'skipped', 'todo'].map((outcome, index) => ({
          kind: 'test',
          name: `case-${index}`,
          outcome,
        })),
      }),
    },
    'node-json'
  )
  assert.equal(result.passed, 1)
  assert.equal(result.failed, 2)
  assert.equal(result.skipped, 2)
  assert.equal(result.errors, 0)
  assert.equal(result.failures.length, 2)
  const malformed = regressionSummary({ exitCode: 0, stdout: '{}' }, 'node-json')
  assert.equal(malformed.errors, 1)
})
