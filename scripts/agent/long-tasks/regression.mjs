import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

// 读取 pytest 自身生成的逐例结果；原始失败和退出码始终保留。
export async function readPytestReport(python, path) {
  const { stdout } = await execute(
    python,
    [
      '-c',
      `import json, sys, xml.etree.ElementTree as ET
cases = []
for case in ET.parse(sys.argv[1]).iter('testcase'):
    events = [item for item in case if item.tag in ('failure', 'error', 'skipped')]
    cases.append(dict(id=case.get('classname', '') + '::' + case.get('name', ''),
        outcomes=[dict(kind=item.tag, message=item.get('message', ''), text=item.text or '') for item in events]))
print(json.dumps(cases))`,
      path,
    ],
    { maxBuffer: 8_000_000 }
  )
  return JSON.parse(stdout)
}

// 已知问题必须在付费前逐例冻结；新增通过用例可保留，原用例缺失、新失败与新增跳过仍拒绝。
export function regressionVerdict(result, issues = [], baseline) {
  const cases = result.cases ?? []
  const failures = []
  const known = []
  const seen = new Set()
  for (const item of cases) {
    if (seen.has(item.id)) failures.push(`Duplicate test: ${item.id}`)
    seen.add(item.id)
    for (const outcome of item.outcomes) {
      if (outcome.kind === 'skipped') continue
      const issue = issues.find((value) => value.test === item.id)
      const text = `${outcome.message}\n${outcome.text}`
      if (outcome.kind === 'failure' && issue?.contains.every((value) => text.includes(value)))
        known.push(item.id)
      else failures.push(`Unexpected ${outcome.kind}: ${item.id}`)
    }
  }
  if (![0, 1].includes(result.exitCode)) failures.push(`Test process exit: ${result.exitCode}`)
  if (!cases.length) failures.push('No test cases recorded')
  if (result.exitCode === 1 && !known.length && !failures.length)
    failures.push('Failed process without a recorded failure')
  if (result.exitCode === 0 && known.length) failures.push('Inconsistent successful exit')
  if (baseline) {
    const original = new Map(baseline.map((item) => [item.id, item]))
    for (const item of cases) {
      const before = original.get(item.id)
      if (
        item.outcomes.some((value) => value.kind === 'skipped') &&
        !before?.outcomes.some((value) => value.kind === 'skipped')
      )
        failures.push(`${before ? 'Previously executed test' : 'New test'} skipped: ${item.id}`)
    }
    for (const id of original.keys()) if (!seen.has(id)) failures.push(`Missing test: ${id}`)
  } else {
    for (const issue of issues)
      if (!known.includes(issue.test))
        failures.push(`Declared baseline issue not reproduced: ${issue.test}`)
  }
  return {
    baselineCompatible: failures.length === 0,
    suitePassed: result.exitCode === 0 && failures.length === 0,
    knownFailures: known,
    unexpected: failures,
  }
}

export function validateBaselineIssues(issues, runner) {
  assert(Array.isArray(issues))
  if (issues.length)
    assert(['pytest', 'mocha-json', 'jest-json', 'ava-tap', 'vitest-json'].includes(runner))
  const names = new Set()
  for (const issue of issues) {
    assert.equal(typeof issue.test, 'string')
    assert(issue.test.includes('::') && !names.has(issue.test))
    names.add(issue.test)
    assert(Array.isArray(issue.contains) && issue.contains.length > 0)
    for (const value of issue.contains) assert(typeof value === 'string' && value.length > 0)
    assert(typeof issue.reason === 'string' && issue.reason.length > 0)
    assert.match(issue.source, /^https:\/\//u)
  }
}
