import assert from 'node:assert/strict'

// 核对 Brittle 自身的顶层计划与断言计数；测试名去掉计时，重复名字保留稳定序号。
export function brittleReport(result) {
  const cases = [],
    occurrences = new Map(),
    summaries = new Map()
  let header = 0,
    plan,
    terminal,
    pending = [],
    assertionCount = 0,
    passedAssertions = 0
  let pendingFailures = 0
  for (const line of result.stdout.replaceAll('\r\n', '\n').split('\n')) {
    if (line === 'TAP version 13') {
      assert.equal(++header, 1, 'Multiple Brittle reports')
      continue
    }
    const assertion = /^\s+(ok|not ok) \d+ - /u.exec(line)
    if (assertion) {
      assert.equal(header, 1, 'Missing Brittle TAP header')
      assert.equal(plan, undefined, 'Brittle assertion after plan')
      assertionCount++
      if (assertion[1] === 'ok') passedAssertions++
      else pendingFailures++
    }
    const item = /^(ok|not ok) (\d+) - (.+)$/u.exec(line)
    if (item) {
      assert.equal(header, 1, 'Missing Brittle TAP header')
      assert.equal(plan, undefined, 'Brittle test after plan')
      assert.equal(Number(item[2]), cases.length + 1, 'Nonsequential Brittle test number')
      const skip = / # SKIP(?: .*)?$/u.test(item[3])
      const name = item[3].replace(/ # time = [\d.]+ms$/u, '').replace(/ # SKIP(?: .*)?$/u, '')
      assert(name.trim())
      assert(
        item[1] === 'not ok' || pendingFailures === 0,
        'Passing test contains failed assertions'
      )
      const occurrence = (occurrences.get(name) ?? 0) + 1
      occurrences.set(name, occurrence)
      cases.push({
        id: `brittle::${name}::${occurrence}`,
        outcomes: skip
          ? [{ kind: 'skipped', message: name, text: '' }]
          : item[1] === 'ok'
            ? []
            : [{ kind: 'failure', message: name, text: pending.join('\n') }],
      })
      pending = []
      pendingFailures = 0
      continue
    }
    const planned = /^1\.\.(\d+)$/u.exec(line)
    if (planned) {
      assert.equal(plan, undefined, 'Multiple Brittle plans')
      assert.equal(pendingFailures, 0, 'Unsettled failed assertion')
      plan = Number(planned[1])
      continue
    }
    const summary = /^# (tests|asserts) = (\d+)\/(\d+) pass$/u.exec(line)
    if (summary) {
      assert.notEqual(plan, undefined, 'Brittle summary before plan')
      assert(!summaries.has(summary[1]), 'Duplicate Brittle count')
      summaries.set(summary[1], [Number(summary[2]), Number(summary[3])])
      continue
    }
    if (line === '# ok' || line === '# not ok') {
      assert.equal(terminal, undefined, 'Multiple Brittle terminal markers')
      terminal = line === '# ok'
      continue
    }
    assert(
      !line.trim() || line.startsWith('#') || /^\s/u.test(line),
      'Unexpected Brittle TAP content'
    )
    if (plan === undefined) pending.push(line)
  }
  const failed = cases.filter((c) => c.outcomes.some((o) => o.kind === 'failure')).length
  const skipped = cases.filter((c) => c.outcomes.some((o) => o.kind === 'skipped')).length
  const passed = cases.length - failed - skipped
  assert.equal(header, 1, 'Missing Brittle report')
  assert(cases.length > 0, 'Empty Brittle suite')
  assert.equal(plan, cases.length, 'Incomplete Brittle plan')
  assert.deepEqual(
    summaries.get('tests'),
    [passed + skipped, cases.length],
    'Brittle test count mismatch'
  )
  assert.deepEqual(
    summaries.get('asserts'),
    [passedAssertions, assertionCount],
    'Brittle assertion count mismatch'
  )
  assert.equal(terminal, failed === 0, 'Brittle terminal contradicts tests')
  assert(result.exitCode !== 0 || failed === 0, 'Brittle successful exit contradicts failures')
  const errors = result.exitCode !== 0 && failed === 0 ? 1 : 0
  return {
    cases,
    summary: {
      exitCode: result.exitCode,
      passed,
      failed,
      skipped,
      errors,
      summary: `${passed} passed, ${failed} failed, ${skipped} skipped, ${errors} errors`,
      failures: cases.filter((c) => c.outcomes.some((o) => o.kind === 'failure')).map((c) => c.id),
    },
  }
}
