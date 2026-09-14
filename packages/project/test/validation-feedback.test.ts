import { expect, test } from 'bun:test'

import { jsTsSyntaxDiagnostics } from '../src/adapters/jsts-ast'
import { validationFailed } from '../src/transactions/transaction-errors'

test('failed candidate syntax shows both sides of the edit boundary in candidate coordinates', () => {
  const candidate = 'export const adapter = {\n  search() { return [] },\n  },\n  resolveTarget() { return 1 },\n}\n'
  const diagnostics = jsTsSyntaxDiagnostics('adapter.ts', candidate, 'core.typescript')
  expect(diagnostics.length).toBeGreaterThan(0)
  const failure = validationFailed('candidate', { ok: false, diagnostics, checks: [] })
  expect(failure.details.executionOutcome).toBe('not-applied')
  expect(failure.details.recovery).toMatchObject({
    kind: 'project-edit-validation', coordinateSpace: 'candidate', applied: false,
  })
  const window = failure.details.recovery.windows[0]
  expect(window.lines).toContainEqual([2, '  search() { return [] },'])
  expect(window.lines).toContainEqual([3, '  },'])
  expect(window.lines).toContainEqual([4, '  resolveTarget() { return 1 },'])
  expect(failure.suggestedNextAction).toContain('原文 range')
  expect(failure.suggestedNextAction).toContain('reuse + changes')
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
    ok: false, diagnostics: [], checks: [{ id: 'custom.validation', ok: false }],
  })
  expect(failure.reason).toBe('VALIDATION_FAILED')
  expect(failure.message).toContain('custom.validation')
  expect(failure.details.executionOutcome).toBe('not-applied')
  expect(failure.details.recovery).toBeUndefined()
  expect(failure.details.failedChecks).toEqual(['custom.validation'])
  expect(validationFailed('empty', { ok: false, diagnostics: [], checks: [] }).message).toContain('未提供诊断')
})

test('external validator excerpts are not relabeled as candidate source', () => {
  const failure = validationFailed('external', {
    ok: false,
    diagnostics: [{ severity: 'error', message: 'external failed', data: { excerpt: 'command output' } }],
    checks: [],
  })
  expect(failure.details.recovery).toBeUndefined()
  expect(failure.details.diagnostics[0].data.excerpt).toBe('command output')
})
