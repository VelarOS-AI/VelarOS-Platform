/**
 * 遍历忽略策略的实现细节：每个目录的规则只读一次、一批条目只问一次 git、根之外的条目不判。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createIgnorePolicy } from '../src/impl/IgnorePolicy'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'path-rules-policy-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('createIgnorePolicy', () => {
  test('一批条目只问一次 git，问到的路径是相对规则根的可移植写法', async () => {
    const asked: string[][] = []
    const policy = createIgnorePolicy(root, {
      gitCheckIgnore: async (_root, paths) => {
        asked.push([...paths])
        return new Set(['a/b/c.log'])
      },
    })
    const entries = [
      { absolutePath: join(root, 'a', 'b', 'c.log'), isDirectory: false },
      { absolutePath: join(root, 'a', 'b', 'd.ts'), isDirectory: false },
    ]
    expect([...(await policy.ignoredAmong(entries))]).toEqual([join(root, 'a', 'b', 'c.log')])
    expect(asked).toEqual([['a/b/c.log', 'a/b/d.ts']])
  })

  test('每一级 .gitignore 只读一次，同一目录里的条目共用', async () => {
    await mkdir(join(root, 'pkg'), { recursive: true })
    await writeFile(join(root, '.gitignore'), 'out\n')
    await writeFile(join(root, 'pkg', '.gitignore'), '*.log\n')
    const policy = createIgnorePolicy(root, {})
    expect(await policy.shouldSkip(join(root, 'pkg', 'a.log'), false)).toBe(true)
    expect(await policy.shouldSkip(join(root, 'pkg', 'a.ts'), false)).toBe(false)
    expect(await policy.shouldSkip(join(root, 'out'), true)).toBe(true)

    // 规则读完之后把文件删掉，结论照样来自缓存。
    await rm(join(root, 'pkg', '.gitignore'))
    expect(await policy.shouldSkip(join(root, 'pkg', 'b.log'), false)).toBe(true)
  })

  test('规则根之外的条目不判（跟着符号链接走出去的那些）', async () => {
    await writeFile(join(root, '.gitignore'), '*.log\n')
    const policy = createIgnorePolicy(join(root, 'inside'), {})
    expect(await policy.shouldSkip(join(root, 'outside', 'a.log'), false)).toBe(false)
  })

  test('没给条目时不问 git', async () => {
    let calls = 0
    const policy = createIgnorePolicy(root, {
      gitCheckIgnore: async () => {
        calls += 1
        return new Set<string>()
      },
    })
    expect([...(await policy.ignoredAmong([]))]).toEqual([])
    expect(calls).toBe(0)
  })
})
