/**
 * @test-meta
 * title: 工作区文本搜索
 * summary: 发布契约：验证高速文本搜索提供者集成与结果格式。
 * area: packages
 */
import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { DEFAULT_CORE_POLICY } from '../dist/index.js'
import { createNodeCommandProvider } from '../dist/providers/index.js'
import { parseRipgrepJsonLines, searchWithRipgrep } from '../dist/search/ripgrep.js'

test('parseRipgrepJsonLines extracts path, line, columns from rg --json match line', () => {
  const line = JSON.stringify({
    type: 'match',
    data: {
      path: { text: 'src/a.ts' },
      lines: { text: 'hello world\n' },
      line_number: 3,
      submatches: [{ start: 0, end: 5 }],
    },
  })
  const hits = parseRipgrepJsonLines(`${line}\n`, 10)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].path, 'src/a.ts')
  assert.equal(hits[0].range?.startLine, 3)
  assert.equal(hits[0].range?.startColumn, 1)
  assert.equal(hits[0].range?.endColumn, 6)
  assert.match(hits[0].snippet ?? '', /hello world/)
})

test('parseRipgrepJsonLines ignores bad JSON lines and respects maxResults', () => {
  const good = JSON.stringify({
    type: 'match',
    data: {
      path: { text: 'b.ts' },
      lines: { text: 'x\n' },
      line_number: 1,
      submatches: [],
    },
  })
  const stdout = ['not-json', good, good].join('\n')
  const hits = parseRipgrepJsonLines(stdout, 1)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].path, 'b.ts')
})

test('searchWithRipgrep preserves partial matches when the command times out', async () => {
  const line = JSON.stringify({
    type: 'match',
    data: {
      path: { text: 'src/a.ts' },
      lines: { text: 'const needle = true\n' },
      line_number: 7,
      submatches: [{ start: 6, end: 12 }],
    },
  })
  const result = await searchWithRipgrep({
    rootAbs: '/repo',
    query: 'needle',
    regex: false,
    maxResults: 10,
    command: {
      run: async () => ({
        exitCode: 124,
        stdout: `${line}\n`,
        stderr: 'ripgrep timed out',
        timedOut: true,
      }),
    },
    policy: DEFAULT_CORE_POLICY,
  })

  assert.equal(result.timedOut, true)
  assert.equal(result.hits?.length, 1)
  assert.equal(result.hits?.[0]?.path, 'src/a.ts')
})

test('node command provider reports a missing ripgrep executable for adapter fallback', async () => {
  const provider = createNodeCommandProvider()
  const missingCommand = `velaros-missing-ripgrep-${process.pid}`
  const commandResult = await provider.run({
    command: missingCommand,
    args: [],
  })

  assert.equal(commandResult.exitCode, 127)
  assert.deepEqual(commandResult.toolRequirements, [{
    kind: 'missing-command',
    command: missingCommand,
    sourceCommand: missingCommand,
    reason: `${missingCommand} 不在 PATH 中，当前环境无法调用该命令。`,
  }])

  const searchResult = await searchWithRipgrep({
    rootAbs: '/repo',
    query: 'needle',
    regex: false,
    maxResults: 10,
    command: {
      run: (input) => provider.run({ ...input, command: missingCommand }),
    },
    policy: DEFAULT_CORE_POLICY,
  })

  assert.equal(searchResult.hits, null)
  assert.equal(searchResult.toolRequirements?.[0]?.kind, 'missing-command')
})
