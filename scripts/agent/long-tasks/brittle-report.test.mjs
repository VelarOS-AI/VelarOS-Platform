import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brittleReport } from './brittle-report.mjs'
import { regressionArguments, taskEnvironment } from './task-environment.mjs'
import { nodeRegressionReport } from './node-task.mjs'

const passing = `TAP version 13
# same name
    ok 1 - equal
ok 1 - same name # time = 1.23ms
# skip
ok 2 - later # SKIP
# same name
    ok 1 - equal again
ok 3 - same name # time = 0.22ms
1..3
# tests = 3/3 pass
# asserts = 2/2 pass
# time = 2.00ms
# ok
`

test('Brittle inventory retains skip, duplicates and ignores volatile timing', () => {
  const report = nodeRegressionReport({ exitCode: 0, stdout: passing }, '.', 'brittle-tap')
  assert.deepEqual(report.summary, {
    exitCode: 0,
    passed: 2,
    failed: 0,
    skipped: 1,
    errors: 0,
    summary: '2 passed, 0 failed, 1 skipped, 0 errors',
    failures: [],
  })
  assert.deepEqual(
    report.cases.map((c) => c.id),
    ['brittle::same name::1', 'brittle::later::1', 'brittle::same name::2']
  )
  assert.deepEqual(
    brittleReport({ exitCode: 0, stdout: passing.replace('1.23ms', '999.9ms') }),
    report
  )
})

test('Brittle assertion failure retains diagnostics and original nonzero exit', () => {
  const stdout = passing
    .replace(
      '    ok 1 - equal again',
      '    not ok 1 - equal again\n      actual: 1\n      expected: 2'
    )
    .replace('ok 3 - same name', 'not ok 3 - same name')
    .replace('3/3 pass', '2/3 pass')
    .replace('2/2 pass', '1/2 pass')
    .replace('# ok\n', '# not ok\n')
  const report = brittleReport({ exitCode: 1, stdout })
  assert.equal(report.summary.failed, 1)
  assert.equal(report.summary.passed, 1)
  assert.match(report.cases[2].outcomes[0].text, /expected: 2/u)
  assert.throws(() => brittleReport({ exitCode: 0, stdout }))
})

test('Brittle reports reject truncation, forged success and contradictory inventory', () => {
  for (const stdout of [
    passing.replace('TAP version 13', ''),
    `TAP version 13\n${passing}`,
    passing.replace('1..3', '1..4'),
    passing.replace('1..3', ''),
    passing.replace('3/3 pass', '2/3 pass'),
    passing.replace('2/2 pass', '2/3 pass'),
    passing.replace('ok 3 -', 'ok 4 -'),
    passing.replace('    ok 1 - equal again', '    not ok 1 - equal again'),
    passing.replace('# ok\n', ''),
    `${passing}ok 4 - late\n`,
    `${passing}Bail out!\n`,
  ])
    assert.throws(() => brittleReport({ exitCode: 0, stdout }), stdout)
  assert.equal(brittleReport({ exitCode: 1, stdout: passing }).summary.errors, 1)
})

test('Brittle task binding selects its own CLI without AVA or TAP CLI options', () => {
  const environment = taskEnvironment({
    environment: {
      runtime: 'node',
      project: 'fixture',
      acceptance: 'test_feature.mjs',
      regressionRunner: 'brittle-tap',
      regressionEntry: 'node_modules/brittle/brittle-node.js',
      regression: ['test/original.js'],
      preserve: ['test'],
      baselineFailure: 'missing feature',
    },
  })
  const args = regressionArguments(environment)
  assert(args[0].endsWith('/brittle-runner.mjs'))
  assert.deepEqual(args.slice(1), ['node_modules/brittle/brittle-node.js', 'test/original.js'])
})
