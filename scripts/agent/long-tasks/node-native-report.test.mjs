import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runCapturedCommand } from './command-output.mjs'
import { nativeNodeReport } from './node-native-report.mjs'
import { nodeRegressionReport } from './node-task.mjs'
import { regressionArguments, taskEnvironment } from './task-environment.mjs'

async function run(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'velaros-native-tests-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'tests.mjs'), source)
  const environment = taskEnvironment({
    environment: {
      runtime: 'node',
      project: 'fixture',
      acceptance: 'test_feature.mjs',
      regressionRunner: 'node-json',
      regression: ['tests.mjs'],
      preserve: ['tests.mjs'],
      baselineFailure: 'missing feature',
    },
  })
  const result = await runCapturedCommand(process.execPath, regressionArguments(environment), {
    cwd: root,
    timeout: 10000,
  })
  return { root, result }
}

test('native reporter preserves nested passes, skip/todo and sends printed JSON to diagnostics', async (t) => {
  const { root, result } = await run(
    t,
    `
import {test,describe,it} from 'node:test';
console.log('{"schema":"fake","cases":[]}');
test('root',()=>{});
describe('suite',()=>{it('nested',()=>{});it.skip('skip',()=>{});it.todo('future',()=>{})});
`
  )
  assert.equal(result.exitCode, 0)
  assert.match(result.stderr, /"schema":"fake"/u)
  const report = nodeRegressionReport(result, root, 'node-json')
  assert.equal(report.summary.passed, 2)
  assert.equal(report.summary.skipped, 2)
  assert.equal(report.summary.failed, 0)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.cases.length, 4)
  for (const change of [
    (value) => {
      value.summaries = []
    },
    (value) => {
      value.cases.pop()
    },
    (value) => {
      value.summaries[0].counts.passed++
    },
    (value) => {
      value.cases[0].outcome = 'unrecognized'
    },
  ]) {
    const invalid = JSON.parse(result.stdout)
    change(invalid)
    assert.throws(() => nativeNodeReport({ ...result, stdout: JSON.stringify(invalid) }, root))
  }
})

test('native reporter retains assertion failures, cancelled children and failing suite hooks', async (t) => {
  const { root, result } = await run(
    t,
    `
import {test,describe,it,before} from 'node:test';
import assert from 'node:assert/strict';
describe('hook',()=>{before(()=>{throw new Error('setup broke')});it('cancelled',()=>{})});
test('bad',()=>assert.equal(1,2));
`
  )
  assert.equal(result.exitCode, 1)
  const report = nativeNodeReport(result, root)
  assert.equal(report.summary.failed, 2)
  assert.equal(report.summary.errors, 1)
  assert.equal(report.cases.length, 3)
  assert(
    report.cases.some((item) => item.outcomes.some((value) => /setup broke/u.test(value.text)))
  )
  assert.throws(() => nativeNodeReport({ ...result, exitCode: 0 }, root))
})

test('native reporter retains collection crashes and rejects a zero-test report', async (t) => {
  const crashed = await run(t, 'throw new Error("collection failed");')
  assert.equal(crashed.result.exitCode, 1)
  const report = nativeNodeReport(crashed.result, crashed.root)
  assert(report.summary.failed > 0)
  const empty = await run(t, '')
  // Node counts an explicitly selected empty file as a file test. Preserve that contract.
  assert.equal(nativeNodeReport(empty.result, empty.root).summary.passed, 1)
  const zero = JSON.parse(empty.result.stdout)
  zero.cases = []
  zero.summaries[0].counts.tests = 0
  zero.summaries[0].counts.passed = 0
  assert.throws(
    () => nativeNodeReport({ ...empty.result, stdout: JSON.stringify(zero) }, empty.root),
    /discover tests/u
  )
})

test('native task optional import does not bypass Python and dependency isolation', () => {
  const environment = {
    runtime: 'node',
    project: 'fixture',
    acceptance: 'test_feature.mjs',
    regressionRunner: 'node-json',
    regression: ['tests.mjs'],
    preserve: ['tests.mjs'],
    baselineFailure: 'missing feature',
  }
  assert.doesNotThrow(() => taskEnvironment({ environment }))
  for (const extra of [
    { python: 'shared' },
    { preserve: ['node_modules'] },
    { regressionEntry: '../shared.mjs' },
    { regressionEntry: '/outside.mjs' },
  ])
    assert.throws(() => taskEnvironment({ environment: { ...environment, ...extra } }))
})
