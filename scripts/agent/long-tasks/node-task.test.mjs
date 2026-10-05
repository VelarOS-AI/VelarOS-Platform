import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  copyNodeDependencies,
  mochaReport,
  nodeDependencyState,
  nodeTestSummary,
} from './node-task.mjs'
import { regressionVerdict } from './regression.mjs'
import {
  acceptanceArguments,
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
