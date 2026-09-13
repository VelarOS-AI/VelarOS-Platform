import { describe, expect, test } from 'bun:test'

import { serializeToolResultForModel } from '../src/tools/toolResultSerialization'

describe('Project read model pagination', () => {
  test('resumes at the actual column when JSON escaping consumes the budget', () => {
    const content = '\\"🙂'.repeat(20000)
    const raw = { snapshot: { path: 'escaped.txt', revision: 'r1' }, content,
      range: { startLine: 80, endLine: 80, startColumn: 7, endColumn: 7 + content.length },
      totalLines: 100, truncated: false, hasMore: false }
    const serialized = serializeToolResultForModel(raw)
    const result = JSON.parse(serialized)
    expect(serialized.length).toBeLessThanOrEqual(32000)
    expect(result.content.length).toBeGreaterThan(0)
    expect(content.startsWith(result.content)).toBe(true)
    expect(result.content.isWellFormed()).toBe(true)
    expect(result.hasMore).toBe(true)
    expect(result.range.endLine).toBe(80)
    expect(result.range.endColumn).toBe(7 + result.content.length)
    expect(result.continuation).toMatchObject({ path: 'escaped.txt', range: { startLine: 80, startColumn: 7 + result.content.length }, baseRevisions: { 'escaped.txt': 'r1' } })
    expect(result.nextStartLine).toBeUndefined()
  })

  test('preserves accurate continuation for unknown total lines and batch reads', () => {
    const content = '中文🙂\\n literal\r\n'.repeat(10000)
    const files = ['a.txt', 'b.txt', 'c.txt'].map((path) => ({
      snapshot: { path, revision: 'r1' }, content,
      range: { startLine: 120, endLine: 10120 }, truncated: true,
      continuation: { path, range: { startLine: 10120 }, baseRevisions: { [path]: 'r1' } },
    }))
    const serialized = serializeToolResultForModel({ files })
    const result = JSON.parse(serialized)
    expect(serialized.length).toBeLessThanOrEqual(32000)
    expect(result.files).toHaveLength(3)
    for (const file of result.files) {
      expect(file.content.length).toBeGreaterThan(0)
      expect(content.startsWith(file.content)).toBe(true)
      const lines = file.content.split('\n')
      expect(file.continuation.range.startLine).toBe(120 + lines.length - 1)
      expect(file.continuation.range.startColumn).toBe(lines.at(-1).length + 1)
      expect(file.range.endLine).toBe(file.continuation.range.startLine)
      expect(file.content.endsWith('\r')).toBe(false)
    }
  })

  test('round trips a large read through repeated model pages without losing or duplicating text', () => {
    const original = (`"\\\t\r\n${  '🙂'.repeat(19000)  }\n中文\n`).repeat(2)
    let remaining = original
    let actual = ''
    let startLine = 11
    let startColumn = 1
    let pages = 0
    while (remaining && pages++ < 20) {
      const result = JSON.parse(serializeToolResultForModel({
        snapshot: { path: 'large.txt', revision: 'r' }, content: remaining,
        range: { startLine, startColumn, endLine: 999 }, totalLines: 999, hasMore: false,
      }))
      expect(result.content.length).toBeGreaterThan(0)
      actual += result.content
      remaining = remaining.slice(result.content.length)
      if (remaining) {
        startLine = result.continuation.range.startLine
        startColumn = result.continuation.range.startColumn
      }
    }
    expect(actual).toBe(original)
    expect(pages).toBeGreaterThan(1)
  })
})
