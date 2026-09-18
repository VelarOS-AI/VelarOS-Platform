import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import type { CommandProvider } from '../contract/requires'
import { createProjectKernel } from '../index'
import { clampSnippet, snippetWindow } from '../utils/search-snippet'
import { ProjectTuning } from '../utils/tuning'

const marker = 'SNIPPETMARKER'
/** 命中落在一行很长的代码中间（压缩过的脚本常见）：从行首截 400 字就看不见它。 */
const line = `${'p'.repeat(1_000)} ${marker} ${'q'.repeat(1_000)}`

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-snippet-'))
  await writeFile(join(root, 'bundle.js'), `${line}\n`)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 假 ripgrep：按 rg --json 的形状回一条命中，lines 是整行（真 rg 的 --json 就是这样）。 */
function ripgrepProvider(): CommandProvider {
  return {
    run: async (input) => {
      if (input.command !== 'rg') return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 }
      const column = line.indexOf(marker)
      const message = {
        type: 'match',
        data: {
          path: { text: 'bundle.js' },
          lines: { text: `${line}\n` },
          line_number: 1,
          submatches: [{ start: column, end: column + marker.length }],
        },
      }
      return { exitCode: 0, stdout: `${JSON.stringify(message)}\n`, stderr: '', durationMs: 0 }
    },
  }
}

test('取窗按整行扩展，行太长时以命中为中心收窄；截断补省略号，没有片段原样返回', () => {
  const content = 'aaa\nprefix VALUE suffix\nbbb\n'
  const start = content.indexOf('VALUE')
  expect(snippetWindow(content, start, start + 5)).toBe('prefix VALUE suffix')
  const long = `${'y'.repeat(5_000)}HIT${'z'.repeat(5_000)}`
  const narrowed = snippetWindow(long, 5_000, 5_003, 100)
  expect(narrowed).toContain('HIT')
  expect(narrowed.length).toBeLessThanOrEqual(100)
  expect(clampSnippet('abcdef', 3)).toBe('abc…')
  expect(clampSnippet(undefined)).toBeUndefined()
})

test('adapter 回退搜索：长行里的命中在片段里，片段不超过展示长度', async () => {
  const kernel = await createProjectKernel({ root, corePolicy: { enableRipgrepSearch: false } })
  const result = await kernel.search({ query: marker })
  const text = result.hits.filter((hit) => hit.kind === 'text')
  expect(text.length).toBeGreaterThan(0)
  for (const hit of text) {
    expect(hit.snippet).toContain(marker)
    expect(hit.snippet!.length).toBeLessThanOrEqual(ProjectTuning.queries.snippetChars + 1)
  }
})

test('ripgrep：长行里的命中在片段里，片段不超过展示长度', async () => {
  const kernel = await createProjectKernel({ root, providers: { command: ripgrepProvider() } })
  const result = await kernel.search({ query: marker })
  expect(result.backend).toBe('ripgrep')
  expect(result.hits).toHaveLength(1)
  const snippet = result.hits[0]!.snippet!
  expect(snippet).toContain(marker)
  expect(snippet.length).toBeLessThanOrEqual(ProjectTuning.queries.snippetChars + 1)
})
