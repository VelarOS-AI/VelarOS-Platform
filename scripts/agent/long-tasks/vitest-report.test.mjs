import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nodeRegressionReport } from './node-task.mjs'
import { regressionVerdict } from './regression.mjs'
import { regressionSummary } from './analyze.mjs'
import { serializeVitest, vitestReport } from './vitest-report.mjs'

const error = { message: 'hook failed', stack: 'hook failed\n at fixture' }
const task = (name, state = 'pass', extra = {}) => ({
  type: 'test',
  name,
  mode: 'run',
  result: { state, errors: [] },
  ...extra,
})
const suite = (name, tasks, extra = {}) => ({
  type: 'suite',
  name,
  mode: 'run',
  result: { state: 'pass', errors: [] },
  tasks,
  ...extra,
})
function document(tasks, { file = {}, errors = [], ...options } = {}) {
  return serializeVitest(
    [suite('test.spec.js', tasks, { filepath: '/project/test.spec.js', ...file })],
    errors,
    { workspace: '/project', finished: 1, cancelled: false, ...options }
  )
}
function result(report, exitCode = 0) {
  return { exitCode, stdout: JSON.stringify(report), stderr: '' }
}

test('Vitest counts completed assertions, duplicate names, inherited skips and todos separately', () => {
  const report = document([
    suite('ordinary', [task('same'), task('same')]),
    suite('disabled', [task('not run', undefined, { result: undefined })], {
      mode: 'skip',
      result: undefined,
    }),
    task('later', undefined, { mode: 'todo', result: undefined }),
  ])
  const raw = result(report)
  const parsed = nodeRegressionReport(raw, '/project', 'vitest-json')
  assert.deepEqual(
    parsed.cases.map((item) => item.id),
    [
      'test.spec.js::ordinary same::1',
      'test.spec.js::ordinary same::2',
      'test.spec.js::disabled not run::1',
      'test.spec.js::later::1',
    ]
  )
  assert.equal(parsed.summary.passed, 2)
  assert.equal(parsed.summary.skipped, 2)
  assert.equal(parsed.summary.failed, 0)
  assert.equal(regressionVerdict({ ...raw, ...parsed }).suitePassed, true)
  assert.equal(regressionSummary(raw, 'vitest-json').passed, 2)
  const before = document([task('ordinary')])
  const after = document([task('ordinary', 'skip')])
  assert.equal(
    regressionVerdict(
      { ...result(after), ...vitestReport(result(after)) },
      [],
      vitestReport(result(before)).cases
    ).baselineCompatible,
    false
  )
})

test('Vitest retains assertion, collection, hook and unhandled errors independently', () => {
  const report = document(
    [
      task('broken', 'fail', { result: { state: 'fail', errors: [error] } }),
      suite('setup', [task('not reached', 'skip')], { result: { state: 'fail', errors: [error] } }),
    ],
    { file: { result: { state: 'fail', errors: [] } }, errors: [error] }
  )
  const raw = result(report, 1)
  const parsed = vitestReport(raw)
  assert.equal(parsed.summary.failed, 1)
  assert.equal(parsed.summary.skipped, 1)
  assert.equal(parsed.summary.errors, 2)
  assert.equal(regressionVerdict({ ...raw, ...parsed }).baselineCompatible, false)
  const collection = result(
    document([], { file: { result: { state: 'fail', errors: [error] } } }),
    1
  )
  assert.equal(vitestReport(collection).summary.errors, 1)
  const before = result(
    document([task('not reached', undefined, { result: undefined })], {
      file: { result: { state: 'fail', errors: [error] } },
    }),
    1
  )
  const beforeResult = vitestReport(before)
  assert.equal(beforeResult.summary.errors, 2)
  assert.equal(beforeResult.summary.skipped, 0)
  assert.equal(beforeResult.cases.length, 2)
  const late = result(document([task('completed')], { errors: [error] }), 1)
  assert.equal(vitestReport(late).summary.passed, 1)
  assert.equal(vitestReport(late).summary.errors, 1)
})

test('Vitest rejects incomplete, cancelled, contradictory and unknown task states', () => {
  for (const report of [
    document([task('running', 'run')]),
    document([task('missing', undefined, { result: undefined })]),
    document([task('unknown', 'unknown')]),
    document([task('unexpected', 'pass', { mode: 'skip' })]),
    document([task('failure', 'fail')]),
    document([task('unexpected', 'pass', { result: { state: 'pass', errors: [error] } })]),
    document([task('completed')], { finished: 0 }),
    document([task('completed')], { finished: 2 }),
    document([task('completed')], { cancelled: true }),
  ])
    assert.throws(() => vitestReport(result(report)))
  const duplicate = document([task('completed')])
  duplicate.files.push(duplicate.files[0])
  assert.throws(() => vitestReport(result(duplicate)), /Duplicate Vitest file/u)
})

test('Vitest empty suites and unsuccessful process exits cannot satisfy regression checks', () => {
  for (const raw of [result(document([])), result(document([task('ok')]), 1)]) {
    assert.equal(regressionVerdict({ ...raw, ...vitestReport(raw) }).baselineCompatible, false)
  }
  const unexplained = result(document([], { file: { result: { state: 'fail', errors: [] } } }), 1)
  assert.equal(vitestReport(unexplained).summary.errors, 1)
})

test('Vitest serialization omits circular runtime objects and keeps literal error evidence', () => {
  const value = task('works')
  value.suite = value
  value.context = { secret: 'unrelated runtime data' }
  const serialized = JSON.stringify(document([value], { errors: [error] }))
  assert(!serialized.includes('unrelated runtime data'))
  assert(serialized.includes('hook failed'))
  assert.equal(vitestReport({ exitCode: 1, stdout: serialized }).summary.errors, 1)
})
