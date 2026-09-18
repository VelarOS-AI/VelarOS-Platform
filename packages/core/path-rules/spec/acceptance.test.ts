/**
 * 路径规则公共件的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，只经根入口；实现细节的测试在 test/ 目录。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createIgnorePolicy, type GitCheckIgnoreRunner, gitignoreRules, pathMatcher } from '../index'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'path-rules-acceptance-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 在临时根里写一个文件，缺的目录补上。 */
async function write(relativePath: string, content = ''): Promise<string> {
  const absolute = join(root, relativePath)
  await mkdir(join(absolute, '..'), { recursive: true })
  await writeFile(absolute, content)
  return absolute
}

/** 按一段 .gitignore 正文判一条相对路径。 */
function ignored(content: string, relativePath: string, isDirectory = false): boolean {
  return gitignoreRules.isIgnored(relativePath, gitignoreRules.parse(content), isDirectory)
}

describe('glob 匹配', () => {
  test('INV-1 三种写法：目录前缀、精确或目录前缀、picomatch', () => {
    expect(pathMatcher.matchesAny('src/a.ts', ['src/'])).toBe(true)
    expect(pathMatcher.matchesAny('src', ['src/'])).toBe(false)
    expect(pathMatcher.matchesAny('src', ['src'])).toBe(true)
    expect(pathMatcher.matchesAny('src/deep/a.ts', ['src'])).toBe(true)
    expect(pathMatcher.matchesAny('srcx/a.ts', ['src'])).toBe(false)
    expect(pathMatcher.matchesAny('src/a.generated.ts', ['**/*.generated.*'])).toBe(true)
    expect(pathMatcher.matchesAny('.env', ['*'])).toBe(true)
    expect(pathMatcher.matchesAny('a.ts', [])).toBe(false)
  })

  test('INV-1 缺省区分大小写，caseSensitive: false 时大小写变体一样命中', () => {
    expect(pathMatcher.matchesAny('.ENV', ['.env'])).toBe(false)
    expect(pathMatcher.matchesAny('.ENV', ['.env'], { caseSensitive: false })).toBe(true)
    expect(pathMatcher.matchesAny('SRC/a.ts', ['src/'], { caseSensitive: false })).toBe(true)
    expect(pathMatcher.matchesAny('SRC/a.ts', ['src/**'], { caseSensitive: false })).toBe(true)
    expect(pathMatcher.matchesAny('src/api.GENERATED.ts', ['**/*.generated.*'], { caseSensitive: false })).toBe(true)
    expect(pathMatcher.matchesAny('src/api.GENERATED.ts', ['**/*.generated.*'])).toBe(false)
  })
})

describe('.gitignore 判定', () => {
  test.each([
    ['/build*', 'build-output', true, true],
    ['docs/*.md', 'docs/a.md', false, true],
    ['docs/*.md', 'docs/deep/a.md', false, false],
    ['**/tmp', 'a/b/tmp', true, true],
    ['a/**/b', 'a/x/y/b', true, true],
    ['[Dd]ist', 'Dist', true, true],
    ['foo\\ ', 'foo ', false, true],
    ['*.log', 'deep/inside/x.log', false, true],
  ])('INV-2 规则 %j 对 %j 的结论跟 git 一致', (rule, path, isDirectory, expected) => {
    expect(ignored(rule, path, isDirectory)).toBe(expected)
  })

  test('INV-2 后面的规则覆盖前面的，反向规则把路径捞回来', () => {
    expect(ignored('*.log\n!keep.log\n', 'keep.log')).toBe(false)
    expect(ignored('!keep.log\n*.log\n', 'keep.log')).toBe(true)
    expect(ignored('# 注释不是规则\n\n', 'anything')).toBe(false)
  })

  test('INV-3 以 / 结尾的规则只匹配目录', () => {
    expect(ignored('build/', 'build', true)).toBe(true)
    expect(ignored('build/', 'build', false)).toBe(false)
    expect(ignored('build/', 'build/app.js')).toBe(true)
    expect(ignored('build', 'build', false)).toBe(true)
  })

  test('INV-4 上级目录被忽略时里面的一切跟着被忽略', () => {
    expect(ignored('node_modules\n', 'node_modules/pkg/deep/index.js')).toBe(true)
    expect(ignored('/build*\n', 'build-output/deep/app.js')).toBe(true)
    expect(ignored('[Dd]ist\n', 'Dist/a/b.js')).toBe(true)
  })

  test('INV-4 子目录里的 .gitignore 只管它自己那一支', async () => {
    await write('.gitignore', 'root-only\n')
    await write('pkg/.gitignore', 'local.log\n')
    const rules = [
      ...(await gitignoreRules.readAncestorRules(root, 'pkg')),
      ...(await gitignoreRules.readRules(root, 'pkg')),
    ]
    expect(gitignoreRules.isIgnored('pkg/local.log', rules, false)).toBe(true)
    expect(gitignoreRules.isIgnored('pkg/root-only', rules, false)).toBe(true)
    expect(gitignoreRules.isIgnored('other/local.log', rules, false)).toBe(false)
  })
})

describe('遍历忽略策略', () => {
  test('INV-5 有 git 执行口时以 git 的结论为准', async () => {
    await write('.gitignore', 'never-matches-locally\n')
    const asked: string[][] = []
    const gitCheckIgnore: GitCheckIgnoreRunner = async (_root, paths) => {
      asked.push([...paths])
      return new Set(paths.filter((path) => path === 'out'))
    }
    const policy = createIgnorePolicy(root, { gitCheckIgnore })
    const ignoredPaths = await policy.ignoredAmong([
      { absolutePath: join(root, 'out'), isDirectory: true },
      { absolutePath: join(root, 'src'), isDirectory: true },
    ])
    expect([...ignoredPaths]).toEqual([join(root, 'out')])
    expect(asked).toEqual([['out', 'src']])
  })

  test('INV-5 执行口返回 null 之后不再问它，改按本地规则判', async () => {
    await write('.gitignore', 'out\n')
    let calls = 0
    const gitCheckIgnore: GitCheckIgnoreRunner = async () => {
      calls += 1
      return null
    }
    const policy = createIgnorePolicy(root, { gitCheckIgnore })
    expect(await policy.shouldSkip(join(root, 'out'), true)).toBe(true)
    expect(await policy.shouldSkip(join(root, 'out', 'deep', 'a.js'), false)).toBe(true)
    expect(await policy.shouldSkip(join(root, 'src', 'a.ts'), false)).toBe(false)
    expect(calls).toBe(1)
  })

  test('INV-6 规则根自己不跳过，unrestricted 一律不跳', async () => {
    await write('.gitignore', 'out\n')
    const policy = createIgnorePolicy(join(root, 'out'), {})
    expect(await policy.shouldSkip(join(root, 'out'), true)).toBe(false)

    const strict = createIgnorePolicy(root, {})
    expect(await strict.shouldSkip(join(root, 'out'), true)).toBe(true)
    const unrestricted = createIgnorePolicy(root, { unrestricted: true })
    expect(await unrestricted.shouldSkip(join(root, 'out'), true)).toBe(false)
  })

  test('INV-6 rulesFrom repository：不在版本库里什么都不跳', async () => {
    await write('.gitignore', 'out\n')
    const policy = createIgnorePolicy(root, { rulesFrom: 'repository' })
    expect(await policy.shouldSkip(join(root, 'out'), true)).toBe(false)
  })

  test('INV-6 rulesFrom repository：搜索根自己被忽略时整次遍历什么都不跳', async () => {
    await mkdir(join(root, '.git'), { recursive: true })
    await write('.gitignore', 'node_modules\nout\n')
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(root, 'out'), { recursive: true })

    const insideRepo = createIgnorePolicy(root, { rulesFrom: 'repository' })
    expect(await insideRepo.shouldSkip(join(root, 'out'), true)).toBe(true)

    const insideIgnored = createIgnorePolicy(join(root, 'node_modules'), { rulesFrom: 'repository' })
    expect(await insideIgnored.shouldSkip(join(root, 'node_modules', 'pkg'), true)).toBe(false)
  })
})
