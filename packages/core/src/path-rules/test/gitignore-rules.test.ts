/**
 * .gitignore 解析的实现细节：一行解析成什么形状、注释与转义、所在目录怎么接。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { GitignoreRules } from '../impl/GitignoreRules'

const rules = new GitignoreRules()

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'path-rules-gitignore-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('parse', () => {
  test('不锚定的规则展开成本级与任意层级两条，锚定的只有一条', () => {
    expect(rules.parse('tmp\n')).toEqual([
      { negated: false, directoryOnly: false, patterns: ['tmp', '**/tmp'] },
    ])
    expect(rules.parse('/tmp\n')).toEqual([
      { negated: false, directoryOnly: false, patterns: ['tmp'] },
    ])
    expect(rules.parse('a/b\n')).toEqual([
      { negated: false, directoryOnly: false, patterns: ['a/b'] },
    ])
  })

  test('所在目录接在规则前面', () => {
    expect(rules.parse('tmp\n', 'pkg/app')).toEqual([
      { negated: false, directoryOnly: false, patterns: ['pkg/app/tmp', 'pkg/app/**/tmp'] },
    ])
    expect(rules.parse('/tmp\n', 'pkg')).toEqual([
      { negated: false, directoryOnly: false, patterns: ['pkg/tmp'] },
    ])
  })

  test('注释、空行、只剩斜杠的行不成规则；转义的 # 与 ! 是字面量', () => {
    expect(rules.parse('# c\n\n   \n/\n')).toEqual([])
    expect(rules.parse('\\#literal\n')).toEqual([
      { negated: false, directoryOnly: false, patterns: ['\\#literal', '**/\\#literal'] },
    ])
    expect(rules.parse('\\!literal\n')).toEqual([
      { negated: false, directoryOnly: false, patterns: ['\\!literal', '**/\\!literal'] },
    ])
  })

  test('目录限定与取反各记一个标记', () => {
    expect(rules.parse('!build/\n')).toEqual([
      { negated: true, directoryOnly: true, patterns: ['build', '**/build'] },
    ])
  })

  test('没转义的尾随空格去掉，转义的留下', () => {
    expect(rules.parse('foo   \n')[0]?.patterns).toEqual(['foo', '**/foo'])
    expect(rules.parse('foo\\ \n')[0]?.patterns).toEqual(['foo\\ ', '**/foo\\ '])
  })
})

describe('Git 的路径匹配', () => {
  test('转义、字符类和字面字符按 Git 的含义匹配', () => {
    const cases = [
      [' leading', ' leading', true],
      [' leading', 'leading', false],
      [' #literal', ' #literal', true],
      ['\\#literal', '#literal', true],
      ['\\!literal', '!literal', true],
      ['foo\\ ', 'foo ', true],
      ['foo\\\\ ', 'foo ', false],
      ['foo\\*', 'foo*', true],
      ['foo\\*', 'fooX', false],
      ['foo\\?', 'foo?', true],
      ['foo\\?', 'fooX', false],
      ['foo\\[1\\]', 'foo[1]', true],
      ['foo\\[1\\]', 'foo1', false],
      ['\\bar', 'bar', true],
      ['foo\\\\bar', 'foo\\bar', true],
      ['foo\\\\bar', 'foo/bar', false],
      ['unclosed\\', 'unclosed', false],
      ['[!a].txt', 'b.txt', true],
      ['[!a].txt', 'a.txt', false],
      ['[ab].txt', 'a.txt', true],
      ['[ab].txt', 'b.txt', true],
      ['[ab].txt', '[ab].txt', false],
      ['[a\\-z].txt', '-.txt', true],
      ['[a\\-z].txt', 'm.txt', false],
      ['[[:digit:]].txt', '1.txt', true],
      ['"*.log"', '"x.log"', true],
      ['"*.log"', 'x.log', false],
      ['@(one|two)', 'one', false],
      ['@(one|two)', '@(one|two)', true],
      ['{one,two}', 'one', false],
      ['{one,two}', '{one,two}', true],
    ] as const
    for (const [pattern, target, expected] of cases)
      expect({
        pattern,
        target,
        ignored: rules.isIgnored(target, rules.parse(pattern), false),
      }).toEqual({ pattern, target, ignored: expected })
  })

  test('规则所在目录的 glob 字符是实际目录名，不会匹配它的名字变体', () => {
    const parsed = rules.parse('*.log', 'pkg[1]')
    expect(rules.isIgnored('pkg[1]/a.log', parsed, false)).toBe(true)
    expect(rules.isIgnored('pkg1/a.log', parsed, false)).toBe(false)
    const backslash = rules.parse('*.log', 'pkg\\name')
    expect(rules.isIgnored('pkg\\name/a.log', backslash, false)).toBe(true)
    expect(rules.isIgnored('pkg/name/a.log', backslash, false)).toBe(false)
  })

  test.skipIf(!Bun.which('git'))('本地判定逐项对照真实 git check-ignore', async () => {
    const initialized = Bun.spawnSync(['git', 'init', '--quiet', root])
    expect(initialized.exitCode).toBe(0)
    const cases = [
      {
        content: 'build/**\n!build/keep.txt\n',
        paths: ['build/', 'build/keep.txt', 'build/drop.txt', 'build/deep/', 'build/deep/x'],
      },
      {
        content: 'build/\n!build/keep.txt\n',
        paths: ['build/', 'build/keep.txt', 'build/drop.txt'],
      },
      {
        content: '*\n!build/\nbuild/*\n!build/keep.txt\n',
        paths: ['build/', 'build/keep.txt', 'build/drop.txt', 'other.txt'],
      },
      {
        content: ' leading\n #literal\n\\#hash\n\\!bang\nfoo\\*\nfoo\\?\nfoo\\[1\\]\n\\bar\n',
        paths: [
          ' leading',
          'leading',
          ' #literal',
          '#hash',
          '!bang',
          'foo*',
          'fooX',
          'foo?',
          'foo[1]',
          'bar',
        ],
      },
      {
        content: '[!a].txt\n"*.log"\n@(one|two)\n{one,two}\n',
        paths: ['a.txt', 'b.txt', '"x.log"', 'x.log', '@(one|two)', 'one', '{one,two}'],
      },
      {
        content: '[ab].txt\n',
        paths: ['a.txt', 'b.txt', '[ab].txt', 'ab.txt'],
      },
    ]
    for (const { content, paths } of cases) {
      await writeFile(join(root, '.gitignore'), content)
      // walker 交付实际目录名及独立的目录身份；Git 的 "build/" 查询则会匹配 build/**。
      // 差分统一使用真实目录的无尾斜杠 entry 名，避免把目录内容查询当作剪枝判定。
      const entries = paths.map((path) => ({
        target: path.replace(/\/$/u, ''),
        isDirectory: path.endsWith('/'),
      }))
      for (const entry of entries)
        if (entry.isDirectory) await mkdir(join(root, entry.target), { recursive: true })
      const checked = Bun.spawnSync(
        [
          'git',
          '-c',
          'core.excludesFile=',
          '-c',
          'core.ignoreCase=false',
          'check-ignore',
          '--no-index',
          '--stdin',
          '-z',
        ],
        { cwd: root, stdin: Buffer.from(`${entries.map((entry) => entry.target).join('\0')}\0`) }
      )
      expect([0, 1]).toContain(checked.exitCode)
      const ignored = new Set(checked.stdout.toString('utf8').split('\0').filter(Boolean))
      const parsed = rules.parse(content)
      for (const { target, isDirectory } of entries)
        expect({
          content,
          target,
          ignored: rules.isIgnored(target, parsed, isDirectory),
        }).toEqual({ content, target, ignored: ignored.has(target) })
    }
  })
})

describe('readRules / readAncestorRules', () => {
  test('没有 .gitignore 时给空规则；各级祖先按从上到下累积，不含目录自己那份', async () => {
    expect(await rules.readRules(root, 'missing')).toEqual([])
    await writeFile(join(root, '.gitignore'), 'root-rule\n')
    expect((await rules.readRules(root, '.'))[0]?.patterns).toEqual(['root-rule', '**/root-rule'])
    expect((await rules.readAncestorRules(root, 'a/b'))[0]?.patterns).toEqual([
      'root-rule',
      '**/root-rule',
    ])
    expect(await rules.readAncestorRules(root, '.')).toEqual([])
  })
})
