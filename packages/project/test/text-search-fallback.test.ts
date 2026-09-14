import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createTextAdapter } from '../src/adapters/text-adapter'
import { createProjectKernel } from '../src/index'
import type { FileSnapshot } from '../src/types/snapshot'
import { encodeProjectTextBuffer } from '../src/utils/text'

function snapshot(content: string): FileSnapshot {
  return {
    path: 'sample.txt',
    absPath: '/project/sample.txt',
    exists: true,
    isDirectory: false,
    isBinary: false,
    content,
    size: Buffer.byteLength(content),
    sha256: 'test',
    revision: 'test',
    mtimeMs: 0,
    adapterIds: ['core.text'],
  }
}

function matchedText(content: string, range: { startOffset?: number; endOffset?: number }): string {
  return content.slice(range.startOffset, range.endOffset)
}

describe('text search fallback', () => {
  test.each(['[', ']', '{', '}', '(', ')', '*', '+', '?', '.', '^', '$', '|', String.fromCharCode(92)])('treats isolated %s literally', (query) => {
    const content = `before ${query} after`
    const hits = createTextAdapter().search!({ snapshot: snapshot(content), query, regex: false })
    expect(hits).toHaveLength(1)
    expect(matchedText(content, hits[0]!.range!)).toBe(query)
  })

  test.each([String.raw`\_`, String.raw`\a`, '{', ']'])('preserves legacy regex syntax %s', (query) => {
    const content = '_a{]'
    const expected = new RegExp(query, 'g').exec(content)!
    const hits = createTextAdapter().search!({ snapshot: snapshot(content), query, regex: true, caseSensitive: true })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.range).toMatchObject({ startOffset: expected.index, endOffset: expected.index + expected[0].length })
  })

  test('preserves whole-string lowercase semantics and maps matches within expanded characters', () => {
    const search = (content: string, query: string) => createTextAdapter().search!({ snapshot: snapshot(content), query, regex: false, caseSensitive: false })
    expect(search('ΟΣ', 'σ')).toEqual([])
    expect(search('ΟΣ', 'ς')[0]!.range).toMatchObject({ startOffset: 1, endOffset: 2 })
    for (const query of ['i', '\u0307', 'İ']) {
      expect(search('İİ', query).map((hit) => [hit.range!.startOffset, hit.range!.endOffset])).toEqual([[0, 1], [1, 2]])
    }
    const content = 'İ😀İ NEEDLE'
    const hits = search(content, 'needle')
    expect(hits[0]!.range).toMatchObject({ startOffset: 5, endOffset: 11 })
    expect(matchedText(content, hits[0]!.range!)).toBe('NEEDLE')
  })

  test('preserves case sensitivity, non-overlap, and result limits', () => {
    const adapter = createTextAdapter()
    const source = snapshot('AaAA')
    expect(adapter.search!({ snapshot: source, query: 'aa', caseSensitive: true })).toEqual([])
    expect(adapter.search!({ snapshot: source, query: 'aa', caseSensitive: false }).map((hit) => hit.range!.startOffset)).toEqual([0, 2])
    expect(adapter.search!({ snapshot: source, query: 'aa', caseSensitive: false, maxResults: 1 }).map((hit) => hit.range!.startOffset)).toEqual([0])
    expect(adapter.search!({ snapshot: source, query: 'aa', maxResults: 0 })).toEqual([])
  })

  test.each([false, true])('bounds empty queries and code-point advancement with regex=%s', (regex) => {
    const adapter = createTextAdapter()
    const search = (content: string, query: string, maxResults = 20) => adapter.search!({ snapshot: snapshot(content), query, regex, maxResults })
    expect(search('😀', '').map((hit) => [hit.range!.startOffset, hit.range!.endOffset])).toEqual([[0, 0], [2, 2]])
    expect(search('😀', '', 1).map((hit) => hit.range!.startOffset)).toEqual([0])
    expect(search('😀', '', 0)).toEqual([])
    expect(search('', '')).toEqual([])
  })

  test('treats backslashes and square brackets literally when regex is disabled', () => {
    const content = String.raw`prefix C:\work [needle] suffix`
    const adapter = createTextAdapter()

    const backslashHits = adapter.search!({
      snapshot: snapshot(content),
      query: String.raw`C:\work`,
      regex: false,
      caseSensitive: true,
    })
    const bracketHits = adapter.search!({
      snapshot: snapshot(content),
      query: '[needle]',
      regex: false,
      caseSensitive: true,
    })

    expect(backslashHits).toHaveLength(1)
    expect(bracketHits).toHaveLength(1)
    expect(matchedText(content, backslashHits[0]!.range!)).toBe(String.raw`C:\work`)
    expect(matchedText(content, bracketHits[0]!.range!)).toBe('[needle]')
  })

  test('returns each real zero-width position once and preserves the result cap', () => {
    const content = '😀needle 😀needle'
    const adapter = createTextAdapter()
    const search = (query: string, maxResults = 20) =>
      adapter.search!({
        snapshot: snapshot(content),
        query,
        regex: true,
        caseSensitive: true,
        maxResults,
      })

    expect(search('^').map((hit) => hit.range?.startOffset)).toEqual([0])
    expect(search('$').map((hit) => hit.range?.startOffset)).toEqual([content.length])
    expect(search('(?=needle)').map((hit) => hit.range?.startOffset)).toEqual([2, 11])
    expect(search('(?=needle)', 1).map((hit) => hit.range?.startOffset)).toEqual([2])
    expect(search('(?=😀)').map((hit) => hit.range?.startOffset)).toEqual([0, 9])
  })

  test('keeps case-insensitive Unicode match ranges aligned with the original text', () => {
    const content = 'İ needle'
    const hits = createTextAdapter().search!({
      snapshot: snapshot(content),
      query: 'needle',
      regex: false,
      caseSensitive: false,
    })

    expect(hits).toHaveLength(1)
    expect(hits[0]!.range).toMatchObject({
      startOffset: 2,
      endOffset: 8,
      startColumn: 3,
      endColumn: 9,
    })
    expect(matchedText(content, hits[0]!.range!)).toBe('needle')
  })

  test('searches decoded UTF-16 and GB18030 project files with exact source ranges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'velaros-project-search-encoding-'))
    const content = 'İ needle'
    try {
      await mkdir(join(root, 'encoded'))
      const encodings = ['utf16le', 'utf16be', 'gb18030'] as const
      for (const encoding of encodings) {
        await writeFile(
          join(root, 'encoded', `${encoding}.txt`),
          encodeProjectTextBuffer(content, encoding),
        )
      }

      const project = await createProjectKernel({ root })
      const result = await project.search({
        query: 'needle',
        root: 'encoded',
        caseSensitive: false,
        useRipgrep: false,
        maxResults: 10,
      })

      expect(result.backend).toBe('adapters')
      expect(result.hits).toHaveLength(encodings.length)
      expect(result.hits.map((hit) => hit.path).sort()).toEqual(
        encodings.map((encoding) => `encoded/${encoding}.txt`).sort(),
      )
      for (const hit of result.hits) {
        expect(hit.range).toMatchObject({
          startOffset: 2,
          endOffset: 8,
          startColumn: 3,
          endColumn: 9,
        })
        const read = await project.read({ path: hit.path })
        expect(read.content).toBe(content)
        expect(matchedText(read.content!, hit.range!)).toBe('needle')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
