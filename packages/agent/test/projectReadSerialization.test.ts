import { describe, expect, test } from 'bun:test'

import { fitProjectReadsForModel } from '../src/tools/projectReadSerialization'
import { serializeToolResultForModel, serializeToolResultForRecall } from '../src/tools/toolResultSerialization'

const source = `source:${  'a'.repeat(64)}`
const window = (lines: Array<[number, string]>) => ({
  kind: 'project-source-window', path: 'source.ts', revision: 'r1', viewSource: source, lines,
})

describe('Project source model presentation', () => {
  test('raw strings remain separate from line metadata and recall preserves physical source', () => {
    const raw = { snapshot: { path: 'script.ts', revision: 'r1' }, content: '123|literal\r\nconst value = "\\n🙂"\r\n', range: { startLine: 256, endLine: 258 } }
    const view = JSON.parse(serializeToolResultForModel(raw))
    expect(view.lines).toEqual([[256, '123|literal'], [257, 'const value = "\\n🙂"'], [258, '']])
    expect(view.content).toBeUndefined()
    expect(view.contentFormat).toBeUndefined()
    expect(JSON.parse(serializeToolResultForRecall(raw)).content).toBe(raw.content)
    expect(JSON.parse(serializeToolResultForModel(view))).toEqual(view)
  })

  test('long escaped line becomes a well formed fragment with the exact next column', () => {
    const text = '\\"🙂'.repeat(20_000)
    const serialized = serializeToolResultForModel(window([[80, text]]))
    const result = JSON.parse(serialized)
    expect(serialized.length).toBeLessThanOrEqual(32_000)
    expect(result.lines).toEqual([])
    expect(result.fragments).toHaveLength(1)
    const fragment = result.fragments[0]
    expect(fragment.text.length).toBeGreaterThan(0)
    expect(fragment.text.isWellFormed()).toBe(true)
    expect(text.startsWith(fragment.text)).toBe(true)
    expect(fragment.columns).toEqual([1, fragment.text.length + 1])
    expect(result.continuation.range).toMatchObject({ startLine: 80, startColumn: fragment.columns[1] })
    expect(result.hasMore).toBe(true)
  })

  test('whole line pages never silently clip large arrays or 2000 character strings', () => {
    const lines: Array<[number, string]> = Array.from({ length: 1000 }, (_, i) => [i + 1, 'abc'])
    const result = JSON.parse(serializeToolResultForModel(window(lines)))
    expect(result.lines).toHaveLength(1000)
    expect(result.lines).toEqual(lines)
    const long = 'x'.repeat(6000)
    expect(JSON.parse(serializeToolResultForModel(window([[1, long]]))).lines).toEqual([[1, long]])
  })

  test('final JSON escaping shares one budget across multiple source windows', () => {
    const files = ['a', 'b', 'c'].map((path) => ({ ...window(Array.from({ length: 3000 }, (_, i) => [i + 120, '中文🙂\\n literal'] as [number, string])), path }))
    const serialized = serializeToolResultForModel({ files })
    const result = JSON.parse(serialized)
    expect(serialized.length).toBeLessThanOrEqual(32_000)
    expect(result.files).toHaveLength(3)
    for (const file of result.files) {
      expect(file.lines.length).toBeGreaterThan(0)
      expect(file.fragments ?? []).toEqual([])
      expect(file.continuation.range).toMatchObject({ startLine: file.lines.at(-1)[0] + 1, startColumn: 1 })
    }
  })

  test('repeat compaction preserves original numeric prefixes and updates continuation', () => {
    const raw = window(Array.from({ length: 10_000 }, (_, i) => [i + 500, '123|source text🙂']))
    const large = JSON.parse(serializeToolResultForModel(raw, { maxChars: 50_000 }))
    const small = JSON.parse(serializeToolResultForModel(large))
    expect(small.lines[0]).toEqual([500, '123|source text🙂'])
    expect(small.lines.length).toBeLessThan(large.lines.length)
    expect(small.continuation.range.startLine).toBe(small.lines.at(-1)[0] + 1)
  })

  test('fragment continuation starts at the original noninitial column', () => {
    const raw = { ...window([]), fragments: [{ line: 42, columns: [51, 2051], text: '🙂'.repeat(1000) }] }
    const result = fitProjectReadsForModel(raw, 1000) as any
    expect(result.fragments[0].columns[0]).toBe(51)
    expect(result.continuation.range.startColumn).toBe(51 + result.fragments[0].text.length)
    expect(result.fragments[0].text.isWellFormed()).toBe(true)
  })
})
