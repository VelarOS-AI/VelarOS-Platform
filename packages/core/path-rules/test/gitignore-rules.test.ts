/**
 * .gitignore 解析的实现细节：一行解析成什么形状、注释与转义、所在目录怎么接。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { GitignoreRules } from '../impl/GitignoreRules'
import { PathMatcher } from '../impl/PathMatcher'

const rules = new GitignoreRules(new PathMatcher())

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'path-rules-gitignore-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('parse', () => {
  test('不锚定的规则展开成本级与任意层级两条，锚定的只有一条', () => {
    expect(rules.parse('tmp\n')).toEqual([{ negated: false, directoryOnly: false, patterns: ['tmp', '**/tmp'] }])
    expect(rules.parse('/tmp\n')).toEqual([{ negated: false, directoryOnly: false, patterns: ['tmp'] }])
    expect(rules.parse('a/b\n')).toEqual([{ negated: false, directoryOnly: false, patterns: ['a/b'] }])
  })

  test('所在目录接在规则前面', () => {
    expect(rules.parse('tmp\n', 'pkg/app')).toEqual([
      { negated: false, directoryOnly: false, patterns: ['pkg/app/tmp', 'pkg/app/**/tmp'] },
    ])
    expect(rules.parse('/tmp\n', 'pkg')).toEqual([{ negated: false, directoryOnly: false, patterns: ['pkg/tmp'] }])
  })

  test('注释、空行、只剩斜杠的行不成规则；转义的 # 与 ! 是字面量', () => {
    expect(rules.parse('# c\n\n   \n/\n')).toEqual([])
    expect(rules.parse('\\#literal\n')).toEqual([{ negated: false, directoryOnly: false, patterns: ['#literal', '**/#literal'] }])
    expect(rules.parse('\\!literal\n')).toEqual([{ negated: false, directoryOnly: false, patterns: ['!literal', '**/!literal'] }])
  })

  test('目录限定与取反各记一个标记，末尾多个斜杠只算一次', () => {
    expect(rules.parse('!build//\n')).toEqual([{ negated: true, directoryOnly: true, patterns: ['build', '**/build'] }])
  })

  test('没转义的尾随空格去掉，转义的留下', () => {
    expect(rules.parse('foo   \n')[0]?.patterns).toEqual(['foo', '**/foo'])
    expect(rules.parse('foo\\ \n')[0]?.patterns).toEqual(['foo ', '**/foo '])
  })
})

describe('readRules / readAncestorRules', () => {
  test('没有 .gitignore 时给空规则；各级祖先按从上到下累积，不含目录自己那份', async () => {
    expect(await rules.readRules(root, 'missing')).toEqual([])
    await writeFile(join(root, '.gitignore'), 'root-rule\n')
    expect((await rules.readRules(root, '.'))[0]?.patterns).toEqual(['root-rule', '**/root-rule'])
    expect((await rules.readAncestorRules(root, 'a/b'))[0]?.patterns).toEqual(['root-rule', '**/root-rule'])
    expect(await rules.readAncestorRules(root, '.')).toEqual([])
  })
})
