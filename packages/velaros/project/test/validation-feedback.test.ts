import { expect, test } from 'bun:test'

import { projectFailure } from '../utils/agent/ports'
import { jsTsSyntaxDiagnostics } from '../utils/jsts-ast'
import { validationFailed } from '../utils/transactions/transaction-errors'

test('failed candidate syntax shows both sides of the edit boundary in candidate coordinates', () => {
  const candidate =
    'export const adapter = {\n  search() { return [] },\n  },\n  resolveTarget() { return 1 },\n}\n'
  const diagnostics = jsTsSyntaxDiagnostics('adapter.ts', candidate, 'core.typescript')
  expect(diagnostics.length).toBeGreaterThan(0)
  const failure = validationFailed('candidate', { ok: false, diagnostics, checks: [] })
  expect(failure.details.executionOutcome).toBe('not-applied')
  expect(failure.details.recovery).toMatchObject({
    kind: 'project-edit-validation',
    coordinateSpace: 'candidate',
    applied: false,
  })
  const window = failure.details.recovery.windows[0]
  expect(window.lines).toContainEqual([2, '  search() { return [] },'])
  expect(window.lines).toContainEqual([3, '  },'])
  expect(window.lines).toContainEqual([4, '  resolveTarget() { return 1 },'])
  expect(failure.suggestedNextAction).toContain('预览里的行号是改完之后的')
  expect(failure.suggestedNextAction).not.toContain('reuse')
  // Candidate source lives only in the transient recovery envelope, never in current file views.
  expect(JSON.stringify(failure.details.diagnostics)).not.toContain('search()')
  expect(failure.details.diagnostics[0].data.coordinateSpace).toBe('candidate')
  expect(JSON.stringify(failure.details.recovery)).not.toContain('project-source-window')
  expect(JSON.stringify(diagnostics)).toContain('search()')
})

test('syntax context previews stay bounded and keep split Unicode characters well formed', () => {
  const content = `export const adapter = {\n${' '.repeat(79)}🙂${' '.repeat(5000)}value: ;\n}\n`
  const diagnostics = jsTsSyntaxDiagnostics('large.ts', content, 'core.typescript')
  expect(diagnostics.length).toBeGreaterThan(0)
  for (const diagnostic of diagnostics) {
    expect(diagnostic.data.excerpt.isWellFormed()).toBe(true)
    for (const [, text] of diagnostic.data.sourceContext?.lines ?? []) {
      expect(text.length).toBeLessThanOrEqual(163)
      expect(text.isWellFormed()).toBe(true)
    }
  }
  const many = jsTsSyntaxDiagnostics('many.ts', 'const = ;\n'.repeat(1000), 'core.typescript')
  expect(many.filter((diagnostic) => diagnostic.data.sourceContext).length).toBeLessThanOrEqual(10)
  const failure = validationFailed('large', { ok: false, diagnostics: many, checks: [] })
  expect(failure.details.recovery.windows.length).toBeLessThanOrEqual(10)
  expect(JSON.stringify(failure.details.recovery).length).toBeLessThan(12_000)
})

test('failed checks without diagnostics preserve their reason and safe retry outcome', () => {
  const failure = validationFailed('no-diagnostics', {
    ok: false,
    diagnostics: [],
    checks: [{ id: 'custom.validation', ok: false }],
  })
  expect(failure.reason).toBe('VALIDATION_FAILED')
  expect(failure.message).toContain('custom.validation')
  expect(failure.details.executionOutcome).toBe('not-applied')
  expect(failure.details.recovery).toBeUndefined()
  expect(failure.details.failedChecks).toEqual(['custom.validation'])
  expect(validationFailed('empty', { ok: false, diagnostics: [], checks: [] }).message).toContain(
    '未提供诊断'
  )
})

test('external validator excerpts are not relabeled as candidate source', () => {
  const failure = validationFailed('external', {
    ok: false,
    diagnostics: [
      { severity: 'error', message: 'external failed', data: { excerpt: 'command output' } },
    ],
    checks: [],
  })
  expect(failure.details.recovery).toBeUndefined()
  expect(failure.details.diagnostics[0].data.excerpt).toBe('command output')
})

test('交给程序的说明里，同一个文件的几处出错预览并成一段：连带出来的语法错误不把同几行重复好几遍', () => {
  const diagnostics = jsTsSyntaxDiagnostics('many.ts', 'const = ;\n'.repeat(6), 'core.typescript')
  expect(diagnostics.length).toBeGreaterThan(1)
  const failure = projectFailure(validationFailed('many', { ok: false, diagnostics, checks: [] }))
  const message = (failure as Error).message
  expect(message.split('改完之后（没写进去）')).toHaveLength(2)
  const rows = message.match(/^ {2}\d+: .*$/gm) ?? []
  expect(rows.length).toBeGreaterThan(0)
  expect(new Set(rows).size).toBe(rows.length)
  // 位置只在列诊断时写一次，说明本身不再带。
  expect(message).not.toMatch(/many\.ts:\d+:\d+ JS\/TS 语法错误（many\.ts/)
})
