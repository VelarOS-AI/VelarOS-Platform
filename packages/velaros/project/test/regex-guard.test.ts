import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execa } from 'execa'

import { createProjectKernel } from '../index'
import { execGuardedRegex } from '../utils/regex-guard'
import { ProjectTuning } from '../utils/tuning'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-regex-guard-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('护栏里的扫描结果与直接跑 RegExp 一致（含空匹配按码点前进）', () => {
  const content = 'alpha 🙂 beta alpha\nALPHA'
  const direct = [...content.matchAll(/alpha/gi)].map((match) => ({ index: match.index, length: match[0].length }))
  expect(execGuardedRegex('alpha', 'gi', content, 10)).toEqual(direct)
  expect(execGuardedRegex('', 'g', '🙂b', 10)).toEqual([{ index: 0, length: 0 }, { index: 2, length: 0 }, { index: 3, length: 0 }])
  expect(execGuardedRegex('a', 'g', 'aaaa', 2)).toHaveLength(2)
  expect(execGuardedRegex('a', 'g', 'aaaa', 0)).toEqual([])
})

test('写错的正则报 INVALID_INPUT 并给中文下一步，不再把 SyntaxError 直接抛给模型', () => {
  expect(() => execGuardedRegex('(', 'g', 'abc', 5)).toThrow('正则表达式无效')
  try {
    execGuardedRegex('(', 'g', 'abc', 5)
  } catch (error) {
    expect((error as { reason?: string }).reason).toBe('INVALID_INPUT')
    expect((error as { suggestedNextAction?: string }).suggestedNextAction).toContain('合法的 JavaScript 正则')
  }
})

test('灾难回溯的正则被时限打断（V8）；Bun 的正则引擎不回溯，本进程里照常跑完', () => {
  const started = Date.now()
  let timedOut = false
  try {
    execGuardedRegex('(x+x+)+y', 'gi', 'x'.repeat(40), 10)
  } catch (error) {
    timedOut = true
    expect((error as { reason?: string }).reason).toBe('INVALID_INPUT')
    expect((error as Error).message).toContain('没跑完')
  }
  // 不管哪种引擎，都不会一直卡着：要么按时限中止，要么本来就跑得完。
  expect(Date.now() - started).toBeLessThan(ProjectTuning.regex.executionTimeoutMs * 5)
  if (!timedOut) expect(process.versions.bun).toBeDefined()
})

test('Node（生产用的 V8/Electron 引擎）下灾难回溯确实被时限打断', async () => {
  const bundle = resolve(import.meta.dir, '../../dist/project/utils/regex-guard.js')
  if (!existsSync(bundle)) {
    // 单跑这个文件时还没 build；包的 test 脚本会先 build，那时这条断言才真正生效。
    expect(bundle).toContain('dist')
    return
  }
  const script = `import { execGuardedRegex } from ${JSON.stringify(bundle)}
try { execGuardedRegex('(x+x+)+y', 'gi', 'x'.repeat(40), 10); console.log('COMPLETED') }
catch (error) { console.log(error.reason, '|', error.message.slice(0, 40)) }`
  const result = await execa('node', ['--input-type=module', '--eval', script], { reject: false, timeout: 30_000 })
  expect(result.stdout).toContain('INVALID_INPUT')
  expect(result.stdout).toContain('没跑完')
}, 60_000)

test('模型给的正则经 project 搜索时也走护栏：写错的 pattern 按 INVALID_INPUT 拒绝', async () => {
  await writeFile(join(root, 'a.txt'), 'hello\n')
  const kernel = await createProjectKernel({ root, corePolicy: { enableRipgrepSearch: false } })
  await expect(kernel.search({ query: '(', regex: true })).rejects.toMatchObject({ reason: 'INVALID_INPUT' })
  const ok = await kernel.search({ query: 'hel+o', regex: true })
  expect(ok.hits.some((hit) => hit.path === 'a.txt')).toBe(true)
})
