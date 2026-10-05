import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  copyNodeDependencies,
  jestReport,
  mochaReport,
  nodeDependencyState,
  nodeTestSummary,
  nodeRegressionReport,
} from './node-task.mjs'
import { regressionVerdict } from './regression.mjs'
import {
  acceptanceArguments,
  applyTaskEnvironment,
  regressionArguments,
  taskEnvironment,
  taskPrompt,
} from './task-environment.mjs'

const config = {
  runtime: 'node',
  project: 'example',
  acceptance: 'test_example.mjs',
  regressionRunner: 'mocha-json',
  regressionEntry: 'bin/mocha.js',
  regression: ['test/**/*.spec.js'],
  preserve: ['test', 'package.json', 'package-lock.json'],
  baselineFailure: 'output must use stream',
}

test('report inventories identify the same tests through physical and aliased workspace paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'regression-paths-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const physical = join(root, 'physical')
  const alias = join(root, 'alias')
  await mkdir(join(physical, 'tests'), { recursive: true })
  await writeFile(join(physical, 'tests/a.js'), '// original test')
  const canonical = await realpath(physical)
  await symlink(canonical, alias)
  const item = { file: join(canonical, 'tests/a.js'), fullTitle: 'a test', err: {} }
  const mocha = {
    stats: { tests: 1, passes: 1, failures: 0, pending: 0 },
    tests: [item],
    passes: [item],
    failures: [],
    pending: [],
  }
  const jest = {
    success: true,
    wasInterrupted: false,
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numRuntimeErrorTestSuites: 0,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: item.file,
        status: 'passed',
        message: '',
        assertionResults: [{ fullName: item.fullTitle, status: 'passed', failureMessages: [] }],
      },
    ],
  }
  for (const [runner, report] of [
    ['mocha-json', mocha],
    ['jest-json', jest],
  ]) {
    const result = { exitCode: 0, stdout: JSON.stringify(report) }
    const original = nodeRegressionReport(result, canonical, runner)
    const aliased = nodeRegressionReport(result, alias, runner)
    assert.deepEqual(aliased.cases, original.cases)
    assert(regressionVerdict({ ...result, ...aliased }, [], original.cases).suitePassed)
  }
})

test('Node task selects native Node commands and leaves Python declarations unchanged', () => {
  const environment = taskEnvironment({ environment: config })
  assert.deepEqual(environment, config)
  assert.deepEqual(regressionArguments(environment), [
    'bin/mocha.js',
    '--reporter',
    'json',
    'test/**/*.spec.js',
  ])
  assert.deepEqual(acceptanceArguments(environment, '/frozen/test.mjs'), [
    '--test',
    '--test-reporter=tap',
    '/frozen/test.mjs',
  ])
  const prompt = taskPrompt({ prompt: 'Implement the feature.', environment }, '/usr/bin/node')
  assert(prompt.startsWith('Implement the feature.\n\n'))
  assert(prompt.includes('/usr/bin/node') && prompt.includes('node_modules'))
  assert(!prompt.includes('pytest') && !prompt.includes('Python'))
  for (const invalid of [
    { regressionEntry: '../evil.js' },
    { regressionEntry: '--eval.js' },
    { regression: ['../outside/*.js'] },
    { preserve: ['test/*'] },
    { preserve: ['node_modules'] },
    { acceptance: '../test_example.mjs' },
    { python: 'env' },
    { regressionRunner: 'shell' },
  ])
    assert.throws(() => taskEnvironment({ environment: { ...config, ...invalid } }))
})

test('Jest task freezes its API entry and shared terminal environment without changing defaults', () => {
  const environment = taskEnvironment({
    environment: {
      ...config,
      regressionRunner: 'jest-json',
      regressionEntry: 'node_modules/jest/build/index.js',
      regression: ['tests'],
      processEnvironment: { NO_COLOR: null, TZ: 'UTC' },
    },
  })
  const [runner, ...args] = regressionArguments(environment)
  assert.equal(runner, join(import.meta.dirname, 'jest-runner.mjs'))
  assert.deepEqual(args, ['node_modules/jest/build/index.js', 'tests'])
  const env = { NO_COLOR: '1', TZ: 'before', PATH: 'unchanged' }
  applyTaskEnvironment(environment, env)
  assert.deepEqual(env, { TZ: 'UTC', PATH: 'unchanged' })
  applyTaskEnvironment(taskEnvironment({ environment: config }), env)
  assert.deepEqual(env, { TZ: 'UTC', PATH: 'unchanged' })
  for (const processEnvironment of [{ PATH: 'override' }, { NO_COLOR: true }, [], null])
    assert.throws(() => taskEnvironment({ environment: { ...config, processEnvironment } }))
})

test('Jest reports preserve failures, skips, repeated names and suite errors with exact inventories', () => {
  const item = (fullName, status = 'passed') => ({
    fullName,
    status,
    failureMessages: status === 'failed' ? ['failure'] : [],
  })
  function result(assertions, { message = '', status, exitCode } = {}) {
    const counts = { passed: 0, failed: 0, pending: 0, todo: 0 }
    for (const row of assertions) counts[row.status]++
    const failed = Boolean(counts.failed || message)
    const raw = {
      wasInterrupted: false,
      success: !failed,
      numPassedTests: counts.passed,
      numFailedTests: counts.failed,
      numPendingTests: counts.pending,
      numTodoTests: counts.todo,
      numTotalTests: assertions.length,
      numTotalTestSuites: 1,
      numPassedTestSuites: failed ? 0 : 1,
      numFailedTestSuites: failed ? 1 : 0,
      numPendingTestSuites: 0,
      numRuntimeErrorTestSuites: message ? 1 : 0,
      testResults: [
        {
          name: '/repo/tests/a.js',
          status: status ?? (failed ? 'failed' : 'passed'),
          message,
          assertionResults: assertions,
        },
      ],
    }
    return { exitCode: exitCode ?? (failed ? 1 : 0), stdout: JSON.stringify(raw) }
  }
  const original = result([
    item('same'),
    item('same'),
    item('todo', 'todo'),
    item('pending', 'pending'),
  ])
  const base = jestReport(original, '/repo')
  assert.equal(base.summary.passed, 2)
  assert.equal(base.summary.skipped, 2)
  assert.equal(new Set(base.cases.map((c) => c.id)).size, 4)
  assert(regressionVerdict({ ...original, ...base }).suitePassed)
  assert.deepEqual(nodeRegressionReport(original, '/repo', 'jest-json'), base)
  for (const changed of [
    result([
      item('same'),
      item('same', 'failed'),
      item('todo', 'todo'),
      item('pending', 'pending'),
    ]),
    result([
      item('same'),
      item('same', 'pending'),
      item('todo', 'todo'),
      item('pending', 'pending'),
    ]),
    result([item('same'), item('todo', 'todo'), item('pending', 'pending')]),
  ])
    assert(
      !regressionVerdict({ ...changed, ...jestReport(changed, '/repo') }, [], base.cases)
        .suitePassed
    )
  for (const rows of [[], [item('passes before hook failure')]]) {
    const hook = result(rows, { message: 'suite setup or teardown failed' })
    const parsed = jestReport(hook, '/repo')
    assert.equal(parsed.summary.errors, 1)
    assert(!regressionVerdict({ ...hook, ...parsed }).suitePassed)
  }
  const empty = result([])
  assert(!regressionVerdict({ ...empty, ...jestReport(empty, '/repo') }).suitePassed)
  const skippedRaw = JSON.parse(result([item('entire skipped suite', 'pending')]).stdout)
  skippedRaw.numPassedTestSuites = 0
  skippedRaw.numPendingTestSuites = 1
  skippedRaw.testResults[0].status = 'skipped'
  const skippedSuite = jestReport({ exitCode: 0, stdout: JSON.stringify(skippedRaw) }, '/repo')
  assert.equal(skippedSuite.summary.skipped, 1)
  assert.equal(skippedSuite.summary.errors, 0)
  for (const patch of [
    { numPassedTests: 9 },
    { numTotalTests: 9 },
    { numTotalTestSuites: 9 },
    { wasInterrupted: true },
  ])
    assert.throws(() =>
      jestReport(
        { ...original, stdout: JSON.stringify({ ...JSON.parse(original.stdout), ...patch }) },
        '/repo'
      )
    )
  assert.throws(() => jestReport({ ...original, stdout: original.stdout.slice(0, -1) }, '/repo'))
  assert.throws(() =>
    jestReport({ ...original, stdout: original.stdout + original.stdout }, '/repo')
  )
  assert.throws(() => nodeRegressionReport(original, '/repo', 'unknown'))
})

test('Node dependency copies isolate both participants and judges and detect content or permission drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'node-evaluation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  await mkdir(join(source, 'node_modules/.bin'), { recursive: true })
  await writeFile(join(source, 'node_modules/tool.js'), 'frozen\n')
  await symlink('../tool.js', join(source, 'node_modules/.bin/tool'))
  const initial = await nodeDependencyState(source, process.execPath)
  for (const participant of ['scriptact', 'codex', 'judge']) {
    const path = join(root, participant)
    await copyNodeDependencies(source, path)
    assert.deepEqual(await nodeDependencyState(path, process.execPath), initial)
  }
  await writeFile(join(root, 'scriptact/node_modules/tool.js'), 'modified\n')
  assert.notDeepEqual(await nodeDependencyState(join(root, 'scriptact'), process.execPath), initial)
  assert.equal(await readFile(join(root, 'judge/node_modules/tool.js'), 'utf8'), 'frozen\n')
  assert.deepEqual(await nodeDependencyState(source, process.execPath), initial)
  await chmod(join(root, 'codex/node_modules/tool.js'), 0o755)
  assert.notDeepEqual(await nodeDependencyState(join(root, 'codex'), process.execPath), initial)
  await assert.rejects(copyNodeDependencies(source, join(root, 'judge')))
  await symlink('../../outside', join(source, 'node_modules/escape'))
  await assert.rejects(nodeDependencyState(source, process.execPath), /escapes checkout/u)
})

test('Mocha reports preserve failures, skips and inventory; malformed and empty successes do not pass', () => {
  const pass = { file: '/repo/test/a.js', fullTitle: 'suite case', err: {} }
  const skipped = { file: '/repo/test/a.js', fullTitle: 'suite pending', err: {} }
  const raw = {
    stats: { tests: 2, passes: 1, failures: 0, pending: 1 },
    tests: [pass, skipped],
    passes: [pass],
    pending: [skipped],
    failures: [],
  }
  const result = { exitCode: 0, stdout: JSON.stringify(raw) }
  const parsed = mochaReport(result, '/repo')
  assert.deepEqual(
    mochaReport(
      { ...result, stdout: `Diagnostic before tests\n${result.stdout}\ncleanup done\n` },
      '/repo'
    ),
    parsed
  )
  assert.deepEqual(
    mochaReport({ ...result, stdout: `<xml>diagnostic</xml>${result.stdout}cleanup` }, '/repo'),
    parsed
  )
  const escaped = { ...pass, fullTitle: 'quoted " and nested } { text \\ remain intact' }
  const escapedReport = JSON.stringify(
    {
      stats: { tests: 1, passes: 1, failures: 0, pending: 0 },
      tests: [escaped],
      passes: [escaped],
      pending: [],
      failures: [],
    },
    null,
    2
  )
  assert.equal(
    mochaReport({ exitCode: 0, stdout: `log\n${escapedReport}` }, '/repo').summary.passed,
    1
  )
  const nested = { ...pass, err: { diagnostic: { stats: { count: 1 } } } }
  const nestedReport = JSON.stringify({
    stats: { tests: 1, passes: 1, failures: 0, pending: 0 },
    tests: [nested],
    passes: [nested],
    pending: [],
    failures: [],
  })
  assert.equal(
    mochaReport({ exitCode: 0, stdout: `log${nestedReport}` }, '/repo').summary.passed,
    1
  )
  assert.throws(() =>
    mochaReport({ ...result, stdout: `${result.stdout}\n${result.stdout}` }, '/repo')
  )
  assert.throws(() => mochaReport({ ...result, stdout: result.stdout.slice(0, -1) }, '/repo'))
  assert.throws(() => mochaReport({ ...result, stdout: `${result.stdout}\n{"stats":` }, '/repo'))
  assert.equal(parsed.summary.passed, 1)
  assert.equal(parsed.summary.skipped, 1)
  assert(regressionVerdict({ ...result, ...parsed }).suitePassed)
  assert.equal(parsed.cases[0].id, 'test/a.js::suite case::1')
  const failure = { ...pass, err: { message: 'regression' } }
  const failed = {
    exitCode: 1,
    stdout: JSON.stringify({
      ...raw,
      stats: { ...raw.stats, passes: 0, failures: 1 },
      tests: [failure, skipped],
      passes: [],
      failures: [failure],
    }),
  }
  assert(
    !regressionVerdict({ ...failed, ...mochaReport(failed, '/repo') }, [], parsed.cases)
      .baselineCompatible
  )
  const missing = {
    exitCode: 0,
    stdout: JSON.stringify({
      stats: { tests: 1, passes: 1, failures: 0, pending: 0 },
      tests: [pass],
      passes: [pass],
      failures: [],
      pending: [],
    }),
  }
  assert(
    !regressionVerdict({ ...missing, ...mochaReport(missing, '/repo') }, [], parsed.cases)
      .baselineCompatible
  )
  const empty = {
    exitCode: 0,
    stdout: JSON.stringify({
      stats: { tests: 0, passes: 0, failures: 0, pending: 0 },
      tests: [],
      passes: [],
      pending: [],
      failures: [],
    }),
  }
  assert(!regressionVerdict({ ...empty, ...mochaReport(empty, '/repo') }).suitePassed)
  assert.throws(() => mochaReport({ ...result, stdout: '{}' }, '/repo'))
  assert.throws(() =>
    mochaReport({ ...result, stdout: JSON.stringify({ ...raw, passes: [] }) }, '/repo')
  )
  const hook = { ...pass, fullTitle: 'suite before each hook', err: { message: 'hook failed' } }
  const hookFailure = {
    exitCode: 1,
    stdout: JSON.stringify({ ...raw, stats: { ...raw.stats, failures: 1 }, failures: [hook] }),
  }
  const hookReport = mochaReport(hookFailure, '/repo')
  assert.equal(hookReport.summary.failed, 1)
  assert.equal(hookReport.cases.length, 3)
  assert(!regressionVerdict({ ...hookFailure, ...hookReport }, [], parsed.cases).baselineCompatible)
})

test('Node TAP summary rejects missing totals and preserves cancelled tests', () => {
  assert.equal(nodeTestSummary({ exitCode: 0, stdout: '' }).errors, 1)
  const result = nodeTestSummary({
    exitCode: 1,
    stdout:
      'not ok 2 - pending work\n# tests 4\n# pass 1\n# fail 1\n# cancelled 1\n# skipped 1\n# todo 0\n',
  })
  assert.deepEqual([result.passed, result.failed, result.skipped, result.errors], [1, 1, 1, 1])
  assert.equal(result.failures.length, 1)
})
