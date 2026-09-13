import { describe, expect, test } from 'bun:test'

import {
  serializeToolResultForModel,
  serializeToolResultForRecall,
} from '../src/tools/toolResultSerialization'

function rawContent(file: { content: string; contentFormat: string }): string {
  expect(file.contentFormat).toBe('line-numbered')
  return file.content.replace(/^\d+\|/gm, '')
}

describe('Project read model pagination', () => {
  test('resumes at the actual column when JSON escaping consumes the budget', () => {
    const content = '\\"🙂'.repeat(20000)
    const raw = {
      snapshot: { path: 'escaped.txt', revision: 'r1' },
      content,
      range: { startLine: 80, endLine: 80, startColumn: 7, endColumn: 7 + content.length },
      totalLines: 100,
      truncated: false,
      hasMore: false,
    }
    const serialized = serializeToolResultForModel(raw)
    const result = JSON.parse(serialized)
    expect(serialized.length).toBeLessThanOrEqual(32000)
    expect(rawContent(result).length).toBeGreaterThan(0)
    expect(content.startsWith(rawContent(result))).toBe(true)
    expect(result.content.isWellFormed()).toBe(true)
    expect(result.hasMore).toBe(true)
    expect(result.range.endLine).toBe(80)
    expect(result.range.endColumn).toBe(7 + rawContent(result).length)
    expect(result.continuation).toMatchObject({
      path: 'escaped.txt',
      range: { startLine: 80, startColumn: 7 + rawContent(result).length },
      baseRevisions: { 'escaped.txt': 'r1' },
    })
    expect(result.nextStartLine).toBeUndefined()
  })

  test('preserves accurate continuation for unknown total lines and batch reads', () => {
    const content = '中文🙂\\n literal\r\n'.repeat(10000)
    const files = ['a.txt', 'b.txt', 'c.txt'].map((path) => ({
      snapshot: { path, revision: 'r1' },
      content,
      range: { startLine: 120, endLine: 10120 },
      truncated: true,
      continuation: { path, range: { startLine: 10120 }, baseRevisions: { [path]: 'r1' } },
    }))
    const serialized = serializeToolResultForModel({ files })
    const result = JSON.parse(serialized)
    expect(serialized.length).toBeLessThanOrEqual(32000)
    expect(result.files).toHaveLength(3)
    for (const file of result.files) {
      expect(rawContent(file).length).toBeGreaterThan(0)
      expect(content.startsWith(rawContent(file))).toBe(true)
      const lines = rawContent(file).split('\n')
      expect(file.continuation.range.startLine).toBe(120 + lines.length - 1)
      expect(file.continuation.range.startColumn).toBe(lines.at(-1).length + 1)
      expect(file.range.endLine).toBe(file.continuation.range.startLine)
      expect(file.content.endsWith('\r')).toBe(false)
    }
  })

  test('round trips a large read through repeated model pages without losing or duplicating text', () => {
    const original = `"\\\t\r\n${'🙂'.repeat(19000)}\n中文\n`.repeat(2)
    let remaining = original
    let actual = ''
    let startLine = 11
    let startColumn = 1
    let pages = 0
    while (remaining && pages++ < 20) {
      const result = JSON.parse(
        serializeToolResultForModel({
          snapshot: { path: 'large.txt', revision: 'r' },
          content: remaining,
          range: { startLine, startColumn, endLine: 999 },
          totalLines: 999,
          hasMore: false,
        }),
      )
      expect(rawContent(result).length).toBeGreaterThan(0)
      actual += rawContent(result)
      remaining = remaining.slice(rawContent(result).length)
      if (remaining) {
        startLine = result.continuation.range.startLine
        startColumn = result.continuation.range.startColumn
      }
    }
    expect(actual).toBe(original)
    expect(pages).toBeGreaterThan(1)
  })
})

test('shows exact line numbers without changing raw results or recall payloads', () => {
  const raw = {
    snapshot: { path: 'script.ts', revision: 'r1' },
    content: 'const read = await load()\r\nassert(read)\r\nfor (const item of read) {\r\n',
    range: { startLine: 256, startColumn: 1, endLine: 259, endColumn: 1 },
  }
  const before = structuredClone(raw)
  const view = JSON.parse(serializeToolResultForModel(raw))
  expect(view.content).toBe(
    '256|const read = await load()\r\n257|assert(read)\r\n258|for (const item of read) {\r\n259|',
  )
  expect(raw).toEqual(before)
  expect(JSON.parse(serializeToolResultForRecall(raw)).content).toBe(raw.content)
  expect(JSON.parse(serializeToolResultForModel(view))).toEqual(view)
})

test('recompacts numbered history under a smaller budget without consuming source characters', () => {
  const raw = {
    snapshot: { path: 'numbers.txt', revision: 'r1' },
    content: '123|source text🙂\n'.repeat(10000),
    range: { startLine: 500, startColumn: 1 },
  }
  const large = JSON.parse(serializeToolResultForModel(raw, { maxChars: 50000 }))
  const small = JSON.parse(serializeToolResultForModel(large))
  expect(raw.content.startsWith(rawContent(small))).toBe(true)
  expect(small.content.startsWith('500|123|source text🙂')).toBe(true)
  expect(rawContent(small).length).toBeLessThan(rawContent(large).length)
  const lines = rawContent(small).split('\n')
  expect(small.continuation.range).toMatchObject({
    startLine: 500 + lines.length - 1,
    startColumn: lines.at(-1)!.length + 1,
  })
})
