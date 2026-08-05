import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  filterBackgroundJobOutput,
  formatBackgroundJobOutput,
} from '../src/tool-library/builtin/BackgroundJobs'
import type { ToolBackgroundJobOutputSnapshot } from '../src/tool-library/KernelToolContext'

function snapshot(
  overrides: Partial<ToolBackgroundJobOutputSnapshot> = {}
): ToolBackgroundJobOutputSnapshot {
  return {
    id: 'subagent:abc:background:1',
    sessionId: 'session-1',
    kind: 'sub-agent',
    label: 'research',
    status: 'running',
    output: '',
    truncated: false,
    omittedChars: 0,
    ...overrides,
  }
}

void describe('background job output filter fails open', () => {
  void test('an invalid regex is ignored instead of throwing VALIDATION', () => {
    const output = 'line one\nline two'
    // 曾经这里直接抛 AppError('VALIDATION')：模型只想瞄一眼进展，拿到的是一个异常。
    const filtered = filterBackgroundJobOutput(output, '([unclosed')

    assert.equal(filtered.applied, false)
    assert.equal(filtered.output, output)
    assert.ok(filtered.ignoredReason)

    const rendered = formatBackgroundJobOutput(snapshot({ output }), filtered)
    assert.ok(rendered.includes('filter ignored'))
    assert.ok(rendered.includes('line one'))
  })

  void test('zero filter hits reads differently from genuinely empty output', () => {
    const output = ['progress 1', 'progress 2', 'progress 3'].join('\n')
    const filtered = filterBackgroundJobOutput(output, 'error|failed')

    assert.equal(filtered.applied, true)
    assert.equal(filtered.totalLines, 3)
    assert.equal(filtered.matchedLines, 0)

    const rendered = formatBackgroundJobOutput(snapshot({ output }), filtered)
    // 关键回归：曾经这里印的是 `(no new output)`，模型据此判定 job 停滞去 cancel 或重派，
    // 而那几行已经被增量游标吞掉。
    assert.ok(!rendered.includes('(no new output)'))
    assert.ok(rendered.includes('3 new line(s), 0 matched the filter'))
    assert.ok(rendered.includes('mode=snapshot'))
  })

  void test('genuinely empty output still says no new output', () => {
    const filtered = filterBackgroundJobOutput('', 'error')
    const rendered = formatBackgroundJobOutput(snapshot({ output: '' }), filtered)

    assert.equal(filtered.totalLines, 0)
    assert.ok(rendered.includes('(no new output)'))
  })

  void test('partial hits report how many lines the cursor consumed', () => {
    const output = ['boot', 'error: nope', 'done'].join('\n')
    const filtered = filterBackgroundJobOutput(output, 'error')

    assert.equal(filtered.matchedLines, 1)
    assert.equal(filtered.totalLines, 3)

    const rendered = formatBackgroundJobOutput(snapshot({ output }), filtered)
    assert.ok(rendered.includes('filter matched 1/3 line(s)'))
    assert.ok(rendered.includes('error: nope'))
  })

  void test('no filter passes the output through untouched', () => {
    const output = 'a\nb'
    const filtered = filterBackgroundJobOutput(output)

    assert.equal(filtered.applied, false)
    assert.equal(filtered.ignoredReason, null)
    assert.equal(filtered.output, output)
    assert.ok(formatBackgroundJobOutput(snapshot({ output }), filtered).endsWith('a\nb'))
  })
})
