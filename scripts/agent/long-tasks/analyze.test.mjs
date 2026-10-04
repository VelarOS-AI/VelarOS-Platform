import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  findCodexRollout,
  pytestSummary,
  regressionSummary,
  summarizeRequests,
} from './analyze.mjs'

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
