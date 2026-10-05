import assert from 'node:assert/strict'

// AVA 的官方 TAP 报告包含逐项编号、尾部计划与计数；缺失、矛盾及崩溃均不能算通过。
export function avaReport(result) {
  const lines = result.stdout.replaceAll('\r\n', '\n').split('\n')
  const cases = []
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 }
  const summaries = new Map()
  const occurrences = new Map()
  let headers = 0
  let plan
  let current
  for (const line of lines) {
    if (line === 'TAP version 13') {
      assert.equal(++headers, 1, 'Multiple AVA reports')
      continue
    }
    const item = /^(ok|not ok) (\d+) - (.+?)(?: #(SKIP|TODO)| # (SKIP|TODO))?$/u.exec(line)
    if (item) {
      assert.equal(headers, 1, 'Missing AVA TAP header')
      assert.equal(plan, undefined, 'AVA test after final plan')
      assert.equal(Number(item[2]), cases.length + 1, 'Nonsequential AVA test number')
      const name = item[3].trim()
      assert(name.length > 0)
      const directive = item[4] ?? item[5]
      const status =
        directive === 'SKIP'
          ? 'skipped'
          : directive === 'TODO'
            ? 'todo'
            : item[1] === 'ok'
              ? 'passed'
              : 'failed'
      counts[status]++
      const occurrence = (occurrences.get(name) ?? 0) + 1
      occurrences.set(name, occurrence)
      current = {
        id: `ava::${name}::${occurrence}`,
        outcomes:
          status === 'passed'
            ? []
            : [{ kind: directive ? 'skipped' : 'failure', message: name, text: '' }],
      }
      cases.push(current)
      continue
    }
    const planned = /^1\.\.(\d+)$/u.exec(line)
    if (planned) {
      assert.equal(plan, undefined, 'Multiple AVA plans')
      plan = Number(planned[1])
      current = undefined
      continue
    }
    const summary = /^# (tests|pass|skip|fail) (\d+)$/u.exec(line)
    if (summary) {
      assert.notEqual(plan, undefined, 'AVA count before final plan')
      assert(!summaries.has(summary[1]), 'Duplicate AVA count')
      summaries.set(summary[1], Number(summary[2]))
      continue
    }
    if (/^ {2,}/u.test(line) && current?.outcomes[0]) current.outcomes[0].text += `${line}\n`
    else
      assert(
        !line.trim() || line.startsWith('#') || /^ {2,}/u.test(line),
        'Unexpected AVA TAP content'
      )
  }
  assert.equal(headers, 1, 'Missing AVA report')
  assert(cases.length > 0, 'Empty AVA suite')
  assert.equal(plan, cases.length, 'Incomplete AVA plan or worker crash')
  assert.equal(summaries.get('tests'), counts.passed + counts.failed + counts.skipped)
  assert.equal(summaries.get('pass'), counts.passed)
  assert.equal(summaries.get('skip') ?? 0, counts.skipped)
  assert.equal(summaries.get('fail'), counts.failed + counts.todo)
  assert(result.exitCode !== 0 || !counts.failed, 'AVA successful exit contradicts failures')
  return {
    cases,
    summary: {
      exitCode: result.exitCode,
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped + counts.todo,
      errors: 0,
      summary: `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped + counts.todo} skipped, 0 errors`,
      failures: cases
        .filter((item) => item.outcomes.some((outcome) => outcome.kind === 'failure'))
        .map((item) => item.id),
    },
  }
}
