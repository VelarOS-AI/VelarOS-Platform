import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { readPytestReport, regressionVerdict, validateBaselineIssues } from './regression.mjs'

const issue = {
  test: 'tests.upload::test_timeout[trio]',
  contains: ['ResourceWarning', 'generator was not exhausted'],
  reason: 'Existing upstream stream cleanup bug',
  source: 'https://example.invalid/upstream/issues/1',
}
const pass = { id: 'tests.body::test_read', outcomes: [] }
const fail = {
  id: issue.test,
  outcomes: [{ kind: 'failure', message: 'ResourceWarning', text: 'generator was not exhausted' }],
}

test('known baseline failures stay visible and only identical failures or actual fixes are accepted', () => {
  const cases = [pass, fail]
  const result = { exitCode: 1, cases }
  const verdict = regressionVerdict(result, [issue])
  assert.equal(verdict.baselineCompatible, true)
  assert.equal(verdict.suitePassed, false)
  assert.deepEqual(verdict.knownFailures, [issue.test])
  assert.equal(result.exitCode, 1)
  assert.equal(regressionVerdict(result, [issue], cases).baselineCompatible, true)
  const fixed = { exitCode: 0, cases: [pass, { ...fail, outcomes: [] }] }
  assert.equal(regressionVerdict(fixed, [issue], cases).suitePassed, true)
  assert.equal(regressionVerdict(fixed, [issue]).baselineCompatible, false)
})

test('same test with a different failure, new failures, missing tests and extra skips are regressions', () => {
  for (const cases of [
    [
      pass,
      { ...fail, outcomes: [{ kind: 'failure', message: 'assert body == expected', text: '' }] },
    ],
    [pass, { ...fail, outcomes: [{ ...fail.outcomes[0], kind: 'error' }] }],
    [fail, { ...pass, outcomes: fail.outcomes }],
    [fail],
    [pass, fail, { ...pass, id: 'unexpected::test' }],
    [fail, { ...pass, outcomes: [{ kind: 'skipped', message: 'skip', text: '' }] }],
    [pass, fail, fail],
  ])
    assert.equal(
      regressionVerdict({ exitCode: 1, cases }, [issue], [pass, fail]).baselineCompatible,
      false
    )
  for (const exitCode of [2, null, 'ETIMEDOUT'])
    assert.equal(
      regressionVerdict({ exitCode, cases: [pass, fail] }, [issue]).baselineCompatible,
      false
    )
  assert.equal(regressionVerdict({ exitCode: 0, cases: [] }).baselineCompatible, false)
  assert.equal(regressionVerdict({ exitCode: 1, cases: [pass] }).baselineCompatible, false)
})

test('baseline exceptions require a unique test, concrete fingerprint and public source', () => {
  for (const runner of ['pytest', 'mocha-json', 'jest-json'])
    validateBaselineIssues([issue], runner)
  for (const issues of [[issue, issue], [{ ...issue, contains: [] }], [{ ...issue, source: '' }]])
    assert.throws(() => validateBaselineIssues(issues, 'pytest'))
  assert.throws(() => validateBaselineIssues([issue], 'unittest'))
})

test('JUnit parsing keeps parameterized identities, escaped traceback and setup errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'velaros-junit-'))
  try {
    const path = join(root, 'tests.xml')
    await writeFile(
      path,
      `<testsuites><testsuite><testcase classname="tests.upload" name="test_timeout[trio]"><failure message="ResourceWarning &lt;asyncgen&gt;">generator was not exhausted</failure></testcase><testcase classname="tests.body" name="test_read"/><testcase classname="tests.setup" name="test_init"><error message="setup error">trace</error></testcase></testsuite></testsuites>`
    )
    const cases = await readPytestReport('python3', path)
    assert.equal(cases[0].id, issue.test)
    assert.equal(cases[0].outcomes[0].message, 'ResourceWarning <asyncgen>')
    assert.deepEqual(cases[1], pass)
    assert.equal(cases[2].outcomes[0].kind, 'error')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
