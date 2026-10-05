import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { avaReport } from './ava-report.mjs'
import { nodeRegressionReport } from './node-task.mjs'
import { regressionVerdict } from './regression.mjs'
import { regressionSummary } from './analyze.mjs'
import { taskEnvironment, regressionArguments } from './task-environment.mjs'

const passing =
  'TAP version 13\nok 1 - alpha › reads\nok 2 - beta › writes\n1..2\n# tests 2\n# pass 2\n# fail 0\n'

test('AVA inventory preserves titles, duplicate occurrences, skips, TODO and failure diagnostics', () => {
  const report = avaReport({
    exitCode: 1,
    stdout:
      'TAP version 13\nok 1 - alpha › same\nok 2 - alpha › same # SKIP\nnot ok 3 - beta › future # TODO\nnot ok 4 - beta › fails\n  ---\n    message: exact failure\n  ...\n1..4\n# tests 3\n# pass 1\n# skip 1\n# fail 2\n',
  })
  assert.deepEqual(report.summary, {
    exitCode: 1,
    passed: 1,
    failed: 1,
    skipped: 2,
    errors: 0,
    summary: '1 passed, 1 failed, 2 skipped, 0 errors',
    failures: ['ava::beta › fails::1'],
  })
  assert.equal(report.cases[1].id, 'ava::alpha › same::2')
  assert.match(report.cases[3].outcomes[0].text, /exact failure/u)
})

test('AVA reports must have one complete, nonempty, numbered plan and consistent counts', () => {
  for (const stdout of [
    '',
    'TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0',
    passing.replace('1..2', '1..3'),
    passing.replace('# pass 2', '# pass 1'),
    passing.replace('ok 2', 'ok 1'),
    passing.replace('1..2', ''),
    passing + passing,
    passing.replace('# fail 0', '# fail 1'),
    passing + 'not ok 3 - late failure',
    passing + '# pass 2',
  ]) {
    assert.throws(() => avaReport({ exitCode: 0, stdout }))
  }
  assert.throws(() =>
    avaReport({
      exitCode: 0,
      stdout: passing
        .replace('ok 2', 'not ok 2')
        .replace('# pass 2', '# pass 1')
        .replace('# fail 0', '# fail 1'),
    })
  )
})

test('AVA process failure and lost, newly skipped or renamed original cases remain failed regressions', () => {
  const before = avaReport({ exitCode: 0, stdout: passing })
  assert(regressionVerdict({ exitCode: 0, cases: before.cases }).suitePassed)
  assert(!regressionVerdict({ exitCode: 1, cases: before.cases }).baselineCompatible)
  for (const cases of [
    before.cases.slice(0, 1),
    [{ ...before.cases[0], outcomes: [{ kind: 'skipped' }] }, before.cases[1]],
    [{ ...before.cases[0], id: 'renamed' }, before.cases[1]],
  ])
    assert(!regressionVerdict({ exitCode: 0, cases }, [], before.cases).baselineCompatible)
  assert.deepEqual(
    nodeRegressionReport({ exitCode: 0, stdout: passing }, '/unused', 'ava-tap'),
    before
  )
  assert.deepEqual(regressionSummary({ exitCode: 0, stdout: passing }, 'ava-tap'), before.summary)
})

test('AVA launches the pinned project CLI with literal selection and npm-compatible local tools', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-ava-runner-')))
  try {
    await mkdir(join(root, 'node_modules/ava/entrypoints'), { recursive: true })
    await mkdir(join(root, 'node_modules/.bin'), { recursive: true })
    await writeFile(
      join(root, 'node_modules/ava/entrypoints/cli.mjs'),
      'console.log(JSON.stringify({args:process.argv.slice(2),path:process.env.PATH}));process.exitCode=7'
    )
    const environment = taskEnvironment({
      environment: {
        runtime: 'node',
        project: 'sample',
        acceptance: 'test_sample.mjs',
        regressionRunner: 'ava-tap',
        regressionEntry: 'node_modules/ava/entrypoints/cli.mjs',
        regression: ['test/*.js'],
        preserve: ['test', 'package.json'],
        baselineFailure: 'missing feature',
      },
    })
    await assert.rejects(
      promisify(execFile)(process.execPath, regressionArguments(environment), { cwd: root }),
      (error) => {
        assert.equal(error.code, 7)
        const data = JSON.parse(error.stdout)
        assert.deepEqual(data.args, ['--tap', 'test/*.js'])
        assert.equal(data.path.split(delimiter)[0], join(root, 'node_modules/.bin'))
        return true
      }
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
