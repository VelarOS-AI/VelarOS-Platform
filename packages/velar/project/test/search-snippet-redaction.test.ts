import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import type { CommandProvider } from '../contract/requires'
import { createProjectKernel, createSecretRedactionProvider } from '../index'
import { clampSnippet, snippetWindow } from '../utils/search-snippet'
import { ProjectTuning } from '../utils/tuning'

/** 假密钥按段拼出来：仓库里不留完整的密钥形状，公开就绪扫描才不会把测试数据当成真泄漏。 */
const secret = ['sk', 'live', '0123456789abcdefghijklmnopqrstuvwxyzABCD'].join('-')
const marker = 'SNIPPETMARKER'
/** 密钥故意横跨按列截断的边界（400 列）：先截后脱敏就会把半截密钥原样回给模型。 */
const head = `const ${marker} = new Client({ `
const line = `${head}${'p'.repeat(ProjectTuning.ripgrep.snippetChars - 30 - head.length)}apiKey: "${secret}", region: "eu-west-1" })`

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-snippet-redaction-'))
  await writeFile(join(root, 'config.ts'), `${line}\n`)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 假 ripgrep：按 rg --json 的形状回一条命中，片段照 rg 的 --max-columns 截断。 */
function ripgrepProvider(): CommandProvider {
  return {
    run: async (input) => {
      if (input.command !== 'rg') return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 }
      const column = line.indexOf(marker)
      const message = {
        type: 'match',
        data: {
          path: { text: 'config.ts' },
          lines: { text: `${line.slice(0, ProjectTuning.ripgrep.snippetChars)}\n` },
          line_number: 1,
          submatches: [{ start: column, end: column + marker.length }],
        },
      }
      return { exitCode: 0, stdout: `${JSON.stringify(message)}\n`, stderr: '', durationMs: 0 }
    },
  }
}

test('这份样例确实踩在截断边界上：按列切一刀正好把密钥切成半截', () => {
  const cut = line.slice(0, ProjectTuning.ripgrep.snippetChars)
  expect(cut).toContain('sk-live-0')
  expect(cut).not.toContain(secret)
})

test('取窗按整行扩展，行太长时以命中为中心收窄，截断只发生在脱敏之后', () => {
  const content = 'aaa\nprefix SECRET-VALUE suffix\nbbb\n'
  const start = content.indexOf('SECRET')
  expect(snippetWindow(content, start, start + 6)).toBe('prefix SECRET-VALUE suffix')
  const long = `${'y'.repeat(5_000)}HIT${'z'.repeat(5_000)}`
  const narrowed = snippetWindow(long, 5_000, 5_003, 100)
  expect(narrowed).toContain('HIT')
  expect(narrowed.length).toBeLessThanOrEqual(104)
  expect(clampSnippet('abcdef', 3)).toBe('abc…')
})

test('adapter 回退搜索的片段先脱敏再截断，边界上的密钥不再漏出去', async () => {
  const kernel = await createProjectKernel({
    root,
    corePolicy: { enableRipgrepSearch: false },
    providers: { secretRedaction: createSecretRedactionProvider() },
  })
  const result = await kernel.search({ query: marker })
  const text = result.hits.filter((hit) => hit.kind === 'text')
  expect(text.length).toBeGreaterThan(0)
  for (const hit of text) expect(hit.snippet).toContain('[REDACTED]')
  for (const hit of result.hits) {
    expect(hit.snippet).not.toContain('sk-live-0')
    expect(hit.snippet!.length).toBeLessThanOrEqual(ProjectTuning.queries.snippetChars + 1)
  }
})

test('ripgrep 按列截断过的片段先把整行读回来再脱敏，密钥不会被切成半截漏出', async () => {
  const kernel = await createProjectKernel({
    root,
    providers: { secretRedaction: createSecretRedactionProvider(), command: ripgrepProvider() },
  })
  const result = await kernel.search({ query: marker })
  expect(result.backend).toBe('ripgrep')
  expect(result.hits).toHaveLength(1)
  const snippet = result.hits[0]!.snippet!
  expect(snippet).toContain('[REDACTED]')
  expect(snippet).not.toContain('sk-live-0')
  expect(snippet.length).toBeLessThanOrEqual(ProjectTuning.queries.snippetChars + 1)
})
