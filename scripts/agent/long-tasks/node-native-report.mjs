import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const canonical = (path) => {
  try {
    return realpathSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return resolve(path)
  }
}

// 核对原生最终汇总与全部测试/套件事件；取消、钩子故障和不完整输出不得变成通过。
export function nativeNodeReport(result, workspace) {
  const report = JSON.parse(result.stdout)
  assert.equal(report.schema, 'node-test-regression-1')
  assert(Array.isArray(report.summaries) && report.summaries.length === 1)
  const { counts, success } = report.summaries[0]
  assert.equal(typeof success, 'boolean')
  for (const name of ['tests', 'suites', 'passed', 'failed', 'cancelled', 'skipped', 'todo'])
    assert(Number.isSafeInteger(counts?.[name]) && counts[name] >= 0)
  assert(counts.tests > 0, 'Native Node regression must discover tests')
  assert(Array.isArray(report.cases))
  for (const item of report.cases) {
    assert.equal(typeof item.name, 'string')
    assert(['test', 'suite'].includes(item.kind))
    assert(['passed', 'failed', 'skipped', 'todo'].includes(item.outcome))
  }
  const tests = report.cases.filter((item) => item.kind === 'test')
  const suites = report.cases.filter((item) => item.kind === 'suite')
  assert.equal(tests.length, counts.tests)
  assert.equal(suites.length, counts.suites)
  for (const name of ['passed', 'skipped', 'todo'])
    assert.equal(tests.filter((item) => item.outcome === name).length, counts[name])
  assert.equal(
    tests.filter((item) => item.outcome === 'failed').length,
    counts.failed + counts.cancelled
  )
  const suiteErrors = suites.filter(
    (item) => item.outcome === 'failed' && item.failureType !== 'subtestsFailed'
  )
  const failed = counts.failed + counts.cancelled
  assert(!success || (failed === 0 && suiteErrors.length === 0))
  assert(result.exitCode !== 0 || success, 'Successful exit contradicts native Node summary')
  const occurrences = new Map()
  const cases = [...tests, ...suiteErrors].map((item) => {
    const file = item.file ? relative(canonical(workspace), canonical(item.file)) : ''
    const name = `node::${file}::${item.name}`
    const ordinal = (occurrences.get(name) ?? 0) + 1
    occurrences.set(name, ordinal)
    return {
      id: `${name}::${ordinal}`,
      outcomes:
        item.outcome === 'passed'
          ? []
          : [
              {
                kind: item.outcome === 'failed' ? 'failure' : 'skipped',
                message: item.message,
                text: item.text,
              },
            ],
    }
  })
  if (!success && !cases.some((item) => item.outcomes.some((value) => value.kind === 'failure')))
    cases.push({
      id: 'node::runner::1',
      outcomes: [
        {
          kind: 'failure',
          message: 'Native runner did not succeed',
          text: report.diagnostics?.join('\n') ?? '',
        },
      ],
    })
  return {
    cases,
    summary: {
      exitCode: result.exitCode,
      passed: counts.passed,
      failed,
      skipped: counts.skipped + counts.todo,
      errors: cases.length - tests.length,
      summary: `${counts.tests} native Node tests, ${suiteErrors.length} suite errors`,
      failures: cases
        .filter((item) => item.outcomes.some((value) => value.kind === 'failure'))
        .map((item) => item.id),
    },
  }
}
