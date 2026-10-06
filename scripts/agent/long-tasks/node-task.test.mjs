import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import {
  buildNodeProject,
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
  regressionEnvironment,
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

test('project checks retain a complete large report when a Node process exits immediately', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'long-task-report-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(
    join(workspace, 'report.cjs'),
    `process.stdout.write(JSON.stringify({ data: 'x'.repeat(4_000_000) })); process.exit(0)`
  )
  const result = await buildNodeProject(
    { ...config, build: { entry: 'report.cjs', args: [] } },
    workspace,
    process.execPath
  )
  assert.equal(result.exitCode, 0)
  assert.equal(JSON.parse(result.stdout).data.length, 4_000_000)
})

test('optional project build hooks distinguish an unchanged baseline from a failed delivered build', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'long-task-build '))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const environment = taskEnvironment({
    environment: {
      ...config,
      build: { entry: 'scripts/build.mjs', args: ['argument with spaces'], optional: true },
    },
  })
  const baseline = await buildNodeProject(environment, workspace, process.execPath)
  assert.equal(baseline.exitCode, 0)
  assert.equal(baseline.skipped, true)
  await mkdir(join(workspace, 'scripts'))
  await writeFile(
    join(workspace, 'scripts/build.mjs'),
    `import {writeFileSync} from 'node:fs'; writeFileSync('built.json', JSON.stringify(process.argv.slice(2)))`
  )
  const built = await buildNodeProject(environment, workspace, process.execPath)
  assert.equal(built.exitCode, 0)
  assert.notEqual(built.skipped, true)
  assert.deepEqual(JSON.parse(await readFile(join(workspace, 'built.json'), 'utf8')), [
    'argument with spaces',
  ])
  await writeFile(join(workspace, 'scripts/build.mjs'), 'process.exit(7)')
  const failed = await buildNodeProject(environment, workspace, process.execPath)
  assert.equal(failed.exitCode, 7)
  assert.notEqual(failed.skipped, true)
  await rm(join(workspace, 'scripts/build.mjs'))
  const required = await buildNodeProject(
    { ...environment, build: { ...environment.build, optional: false } },
    workspace,
    process.execPath
  )
  assert.notEqual(required.exitCode, 0)
  assert.notEqual(required.skipped, true)
  await symlink('missing.mjs', join(workspace, 'scripts/build.mjs'))
  const brokenLink = await buildNodeProject(environment, workspace, process.execPath)
  assert.notEqual(brokenLink.exitCode, 0)
  assert.notEqual(brokenLink.skipped, true)
})

test('project build hooks remain explicit bounded workspace paths', () => {
  for (const entry of [
    '/outside.mjs',
    '../outside.mjs',
    'scripts/../../outside.mjs',
    '.git/hooks/check',
    '-argument.mjs',
  ])
    assert.throws(() =>
      taskEnvironment({ environment: { ...config, build: { entry, args: [], optional: true } } })
    )
  for (const optional of ['true', 1, null])
    assert.throws(() =>
      taskEnvironment({
        environment: { ...config, build: { entry: 'scripts/build.mjs', args: [], optional } },
      })
    )
})

test('Node regression preloads use frozen local dependencies and appear in both task environments', () => {
  const task = {
    prompt: 'Update the project.',
    environment: {
      ...config,
      regressionRunner: 'vitest-json',
      regressionEntry: 'node_modules/vitest/dist/node.js',
      regressionPreloads: ['node_modules/undici/index.js'],
    },
  }
  const environment = taskEnvironment(task)
  const args = regressionArguments(environment)
  assert(args[0].endsWith('/vitest-runner.mjs'))
  assert.equal(args[1], 'node_modules/vitest/dist/node.js')
  const base = { NODE_OPTIONS: '--enable-source-maps', UNRELATED: 'same' }
  assert.deepEqual(regressionEnvironment(environment, base, '/project root'), {
    NODE_OPTIONS: '--enable-source-maps --require="/project root/node_modules/undici/index.js"',
    UNRELATED: 'same',
  })
  assert.equal(base.NODE_OPTIONS, '--enable-source-maps')
  assert.deepEqual(regressionEnvironment(config, base), base)
  assert.match(
    taskPrompt(task, '/node'),
    /NODE_OPTIONS.*node_modules\/undici\/index.js.*absolute path/u
  )
  task.environment.regressionPreloads.push('node_modules/another/index.js')
  assert.equal(environment.regressionPreloads.length, 1)
  for (const values of [
    [],
    ['../outside.js'],
    ['/tmp/outside.js'],
    ['node_modules/../outside.js'],
    ['node_modules/a.js', 'node_modules/a.js'],
  ])
    assert.throws(() => taskEnvironment({ environment: { ...config, regressionPreloads: values } }))
  assert.throws(() =>
    taskEnvironment({
      environment: {
        project: 'python',
        python: 'python',
        acceptance: 'test_example.py',
        regression: ['test'],
        preserve: ['test'],
        baselineFailure: 'missing',
        regressionPreloads: ['node_modules/a.js'],
      },
    })
  )
})

test('Node regression preloads survive a worker changing cwd and paths containing spaces', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'node preload '))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'node_modules/frozen-preload'), { recursive: true })
  await mkdir(join(root, 'worker'))
  await writeFile(
    join(root, 'node_modules/frozen-preload/index.cjs'),
    'globalThis.fixturePreloaded = true'
  )
  const environment = taskEnvironment({
    environment: {
      ...config,
      regressionPreloads: ['node_modules/frozen-preload/index.cjs'],
    },
  })
  const code = `
    const { execFileSync } = require('node:child_process');
    if (globalThis.fixturePreloaded !== true) process.exit(4);
    const output = execFileSync(process.execPath, ['-p', 'globalThis.fixturePreloaded'], {
      cwd: require('node:path').join(process.cwd(), 'worker'), encoding: 'utf8'
    });
    process.stdout.write(output);
  `
  const output = await promisify(execFile)(process.execPath, ['-e', code], {
    cwd: root,
    env: regressionEnvironment(environment, process.env, root),
    timeout: 10000,
  })
  assert.equal(output.stdout.trim(), 'true')
})

test('Node baseline declarations preserve actual failures and reject changed fingerprints or skipped tests', () => {
  const known = {
    test: 'test/reference.mjs::reference checksum::1',
    contains: ['checksum changed', 'old=aaa new=bbb'],
    reason: 'The upstream reference changed after the release',
    source: 'https://example.invalid/reference/source',
  }
  const environment = taskEnvironment({ environment: { ...config, baselineIssues: [known] } })
  const passed = { file: '/workspace/test/plain.mjs', fullTitle: 'ordinary behavior', err: {} }
  const failed = {
    file: '/workspace/test/reference.mjs',
    fullTitle: 'reference checksum',
    err: { message: 'checksum changed: old=aaa new=bbb', stack: 'original failure stack' },
  }
  const document = {
    stats: { tests: 2, passes: 1, failures: 1, pending: 0 },
    tests: [passed, failed],
    passes: [passed],
    failures: [failed],
    pending: [],
  }
  const raw = { exitCode: 1, stdout: JSON.stringify(document), stderr: '' }
  const baseline = {
    ...raw,
    ...nodeRegressionReport(raw, '/workspace', environment.regressionRunner),
  }
  const verdict = regressionVerdict(baseline, environment.baselineIssues)
  assert.equal(verdict.baselineCompatible, true)
  assert.equal(verdict.suitePassed, false)
  assert.equal(baseline.summary.failed, 1)
  assert.equal(baseline.exitCode, 1)
  assert.deepEqual(verdict.knownFailures, [known.test])
  for (const altered of [
    { ...failed, err: { message: 'checksum changed: old=aaa new=ccc' } },
    { ...failed, fullTitle: 'different failing test' },
  ]) {
    const result = {
      exitCode: 1,
      stdout: JSON.stringify({ ...document, tests: [passed, altered], failures: [altered] }),
    }
    assert.equal(
      regressionVerdict(
        { ...result, ...nodeRegressionReport(result, '/workspace', environment.regressionRunner) },
        [known],
        baseline.cases
      ).baselineCompatible,
      false
    )
  }
  assert.equal(
    regressionVerdict(
      {
        exitCode: 0,
        cases: baseline.cases.map((item) =>
          item.id === known.test ? { ...item, outcomes: [{ kind: 'skipped', message: '' }] } : item
        ),
      },
      [known],
      baseline.cases
    ).baselineCompatible,
    false
  )
  assert.equal(
    regressionVerdict(
      { exitCode: 0, cases: baseline.cases.map((item) => ({ ...item, outcomes: [] })) },
      [known],
      baseline.cases
    ).suitePassed,
    true
  )
})

test('Node project builds regenerate current sources with literal arguments and report compiler failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'node-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'node_modules/frozen-builder'), { recursive: true })
  await mkdir(join(root, 'fixtures/fixture-pkg'), { recursive: true })
  await writeFile(join(root, 'fixtures/fixture-pkg/index.js'), "module.exports = 'fixture-module'")
  await writeFile(
    join(root, 'node_modules/frozen-builder/build'),
    `
    const fs = require('node:fs');
    const [source, target, literal] = process.argv.slice(2);
    const body = fs.readFileSync(source, 'utf8');
    if (body === 'FAIL') { console.error('compiler rejected source'); process.exit(7); }
    fs.writeFileSync(target, body.toUpperCase());
    console.log(JSON.stringify({ fixture: require('fixture-pkg'), literal }));
  `
  )
  const environment = taskEnvironment({
    environment: {
      ...config,
      build: {
        entry: 'node_modules/frozen-builder/build',
        args: ['source.txt', 'generated.txt', '$(literal) `text`'],
      },
      processEnvironment: { NODE_PATH: 'fixtures' },
    },
  })
  const env = { ...process.env }
  applyTaskEnvironment(environment, env)
  for (const source of ['original source', 'updated source']) {
    await writeFile(join(root, 'source.txt'), source)
    const result = await buildNodeProject(environment, root, process.execPath, env)
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(await readFile(join(root, 'generated.txt'), 'utf8'), source.toUpperCase())
    assert.deepEqual(JSON.parse(result.stdout), {
      fixture: 'fixture-module',
      literal: '$(literal) `text`',
    })
  }
  await writeFile(join(root, 'source.txt'), 'FAIL')
  const failure = await buildNodeProject(environment, root, process.execPath, env)
  assert.equal(failure.exitCode, 7)
  assert.match(failure.stderr, /compiler rejected source/)
  assert.equal(failure.timedOut, false)
  assert.equal(await buildNodeProject(config, 'absent-workspace', 'unavailable-node'), null)
})

test('Node builds and fixture module paths are explicitly frozen and stay within their environment', () => {
  for (const build of [
    null,
    [],
    { entry: '../build.js', args: [] },
    { entry: 'node_modules/../build.js', args: [] },
    { entry: 'node_modules/build.js', args: '--eval' },
    { entry: 'node_modules/build.js', args: [null] },
    { entry: 'node_modules/build.js', args: ['nul\0'] },
  ])
    assert.throws(() => taskEnvironment({ environment: { ...config, build } }))
  assert.deepEqual(
    taskEnvironment({ environment: { ...config, build: { entry: 'scripts/build.js', args: [] } } })
      .build,
    { entry: 'scripts/build.js', args: [] }
  )
  for (const NODE_PATH of ['', '.', '../outside', '/absolute', 'fixtures/../outside'])
    assert.throws(() =>
      taskEnvironment({ environment: { ...config, processEnvironment: { NODE_PATH } } })
    )
  const python = {
    ...config,
    runtime: undefined,
    python: 'python-env',
    regressionRunner: 'pytest',
    acceptance: 'test_example.py',
  }
  assert.throws(() =>
    taskEnvironment({ environment: { ...python, processEnvironment: { NODE_PATH: 'fixtures' } } })
  )
  assert.throws(() =>
    taskEnvironment({
      environment: { ...python, build: { entry: 'node_modules/build.js', args: [] } },
    })
  )
})

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
  const extensionless = taskEnvironment({
    environment: { ...config, regressionEntry: 'node_modules/mocha/bin/mocha' },
  })
  assert.equal(regressionArguments(extensionless)[0], 'node_modules/mocha/bin/mocha')
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
