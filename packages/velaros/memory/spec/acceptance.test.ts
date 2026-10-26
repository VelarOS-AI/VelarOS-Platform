/**
 * 长期记忆的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，不测实现细节；记忆库落在系统临时目录下的真磁盘上，每个用例一个根目录。
 */

import { readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { VelarMemoryModule } from '../contract/surface'
import type { MemorySaveInput } from '../index'
import { createMemoryStore, MemoryLimits, memoryOperations, MemoryTypes } from '../index'
import { MemoryTuning } from '../utils/tuning'

import {
  failureOf,
  makeScratch,
  MemoryDeclarations,
  memorySpace,
  removeScratch,
  runModelProgram,
  typecheckTemplate,
} from './support'

/** 一条合法的记忆，按用例改几个字段。 */
function entry(id: string, overrides: Partial<MemorySaveInput> = {}): MemorySaveInput {
  return {
    id,
    type: 'work',
    title: `标题 ${id}`,
    description: `描述 ${id}`,
    content: `正文 ${id}`,
    ...overrides,
  }
}

let root = ''
beforeEach(async () => {
  root = await makeScratch()
})
afterEach(async () => {
  await removeScratch(root)
})

describe('作用域', () => {
  test('INV-1 两个作用域互相列不到、删不到；只差大小写的两个字符串也是两个作用域', async () => {
    const store = createMemoryStore({ root })
    const upper = store.scope('project:/Repo')
    const lower = store.scope('project:/repo')
    await upper.save(entry('shared-id', { title: '大写那份' }))
    await lower.save(entry('shared-id', { title: '小写那份' }))
    expect((await upper.list()).map((memory) => memory.title)).toEqual(['大写那份'])
    expect((await lower.list()).map((memory) => memory.title)).toEqual(['小写那份'])
    expect(await store.scope('site:https://example.com').list()).toEqual([])
    expect(await store.scope('system').remove({ id: 'shared-id' })).toEqual({ removed: false })
    expect(await lower.remove({ id: 'shared-id' })).toEqual({ removed: true })
    expect((await upper.list()).map((memory) => memory.title)).toEqual(['大写那份'])
  })

  test('INV-2 作用域目录是小写前缀接哈希，第一次写入才建；.scope 记着原串，listScopes 交回原串、条数与最近更新，根目录的杂项不算', async () => {
    const store = createMemoryStore({ root })
    const project = store.scope('project:/Srv/Repos/VelarOS Platform')
    expect(await project.list()).toEqual([])
    expect(await project.renderIndex()).toBe('## 记忆\n还没有记忆。')
    expect(await readdir(root)).toEqual([])
    await project.save(entry('first'))
    const [directory] = await readdir(root)
    expect(directory).toMatch(/^project-srv-repos-velaros-platform-[0-9a-f]{16}$/u)
    expect(await readFile(join(root, directory!, '.scope'), 'utf8')).toBe(
      'project:/Srv/Repos/VelarOS Platform'
    )

    await store.scope('system').save(entry('second'))
    const emptied = store.scope('site:https://emptied.example')
    await emptied.save(entry('gone'))
    await emptied.remove({ id: 'gone' })
    // Finder 的 .DS_Store、宿主以前留下的文件与目录都在根目录里，但它们不是作用域
    await writeFile(join(root, '.DS_Store'), 'finder')
    await writeFile(join(root, 'MEMORY.md'), '# 旧索引')
    await mkdir(join(root, 'entries'))
    const scopes = await store.listScopes()
    expect(scopes.map(({ scope, count }) => [scope, count]).sort()).toEqual([
      ['project:/Srv/Repos/VelarOS Platform', 1],
      ['system', 1],
    ])
    expect(scopes[0]!.updatedAt >= scopes[1]!.updatedAt).toBe(true)
    expect(Date.parse(scopes[0]!.updatedAt)).not.toBeNaN()

    expect((await failureOf(Promise.resolve().then(() => store.scope('  ')))).code).toBe(
      'VALIDATION'
    )
    expect(
      (
        await failureOf(
          Promise.resolve().then(() => createMemoryStore({ root: 'relative/memory' }))
        )
      ).code
    ).toBe('VALIDATION')
  })

  test('INV-3 id 就是文件名：只许小写字母、数字和连字符，最多 64 个字符，不许 Windows 保留名', async () => {
    const scope = createMemoryStore({ root }).scope('system')
    const rejected = [
      '../escape',
      'a/b',
      'Upper',
      'with space',
      'dot.md',
      '-lead',
      'trail-',
      'double--dash',
      '',
      'x'.repeat(MemoryLimits.idChars + 1),
      'con',
      'nul',
      'com1',
      'lpt9',
    ]
    for (const id of rejected) {
      expect((await failureOf(scope.save(entry(id)))).code, id).toBe('VALIDATION')
      expect((await failureOf(scope.remove({ id }))).code, id).toBe('VALIDATION')
    }
    expect(await readdir(root)).toEqual([])
    const longest = 'a'.repeat(MemoryLimits.idChars)
    expect(await scope.save(entry(longest))).toEqual({
      id: longest,
      created: true,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(await scope.save(entry('release-2026-09'))).toEqual({
      id: 'release-2026-09',
      created: true,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })
})

describe('读写', () => {
  test('INV-4 同一个 id 再写就是整条覆盖（tags 见 INV-13）；头部只有五个字段，更新时间由记忆库填，标签规整，不留临时文件', async () => {
    const scope = createMemoryStore({ root }).scope('system')
    const first = {
      ...entry('reply-style'),
      title: '  回复风格  ',
      tags: [' 汇报 ', 'Lang', 'lang', ''],
      extra: '不落盘',
    } as MemorySaveInput
    expect(await scope.save(first)).toEqual({
      id: 'reply-style',
      created: true,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    const [saved] = await scope.list()
    expect(saved).toMatchObject({
      id: 'reply-style',
      title: '回复风格',
      tags: ['汇报', 'lang'],
      content: '正文 reply-style',
    })
    expect(Date.parse(saved!.updatedAt)).not.toBeNaN()

    expect(
      await scope.save(entry('reply-style', { title: '回复风格（改）', content: '  新的正文  ' }))
    ).toEqual({
      id: 'reply-style',
      created: false,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    const listed = await scope.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      title: '回复风格（改）',
      content: '新的正文',
      tags: ['汇报', 'lang'],
    })

    const [directory] = await readdir(root)
    expect((await readdir(join(root, directory!))).sort()).toEqual(['.scope', 'reply-style.md'])
    const file = await readFile(join(root, directory!, 'reply-style.md'), 'utf8')
    expect(file.split('\n').slice(0, 7)).toEqual([
      '---',
      'title: 回复风格（改）',
      'description: 描述 reply-style',
      'type: work',
      'tags: 汇报, lang',
      `updated: ${listed[0]!.updatedAt}`,
      '---',
    ])
    expect(file).not.toContain('不落盘')
  })

  test('INV-4 会被读歪的值写出去之后照样读得回来', async () => {
    const scope = createMemoryStore({ root }).scope('system')
    const tricky = { title: "'开头是引号", description: '中间有: 冒号 #井号' }
    await scope.save(entry('tricky', tricky))
    expect((await scope.list())[0]).toMatchObject(tricky)
  })

  test('INV-13 改一条时 tags 不给就沿用原来的，给 [] 才清空，给了就整组换掉；新建时不给就是没有', async () => {
    const scope = createMemoryStore({ root }).scope('system')
    const tagsOf = async (id: string) =>
      (await scope.list()).find((memory) => memory.id === id)?.tags
    await scope.save(entry('plain'))
    expect(await tagsOf('plain')).toEqual([])

    await scope.save(entry('tagged', { tags: ['发版', '提交'] }))
    expect(await scope.save(entry('tagged', { content: '只改了正文' }))).toEqual({
      id: 'tagged',
      created: false,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(await tagsOf('tagged')).toEqual(['发版', '提交'])
    await scope.save(entry('tagged', { tags: ['发版'] }))
    expect(await tagsOf('tagged')).toEqual(['发版'])
    await scope.save(entry('tagged', { tags: [] }))
    expect(await tagsOf('tagged')).toEqual([])

    // 人手改过的文件也一样：头部里手写的标签，模型改正文时没给 tags，照样留着
    const [directory] = await readdir(root)
    await writeFile(
      join(root, directory!, 'hand-written.md'),
      '---\ntitle: 手写\ntags: [Release, 发版]\n---\n正文'
    )
    await scope.save(entry('hand-written', { content: '模型改过的正文' }))
    expect(await tagsOf('hand-written')).toEqual(['release', '发版'])
  })

  test('INV-5 remove 真删：文件没了、之后列不到；本来就没有时 removed 为假', async () => {
    const scope = createMemoryStore({ root }).scope('system')
    await scope.save(entry('stale'))
    expect(await scope.remove({ id: 'stale' })).toEqual({ removed: true })
    expect(await scope.list()).toEqual([])
    const [directory] = await readdir(root)
    expect(await readdir(join(root, directory!))).toEqual(['.scope'])
    expect(await scope.remove({ id: 'stale' })).toEqual({ removed: false })
  })

  test('INV-6 入参不合法时一个文件都不写、不删', async () => {
    const space = memorySpace(createMemoryStore({ root }).scope('system'))
    const tooManyTags = Array.from({ length: MemoryLimits.tagCount + 1 }, (_, index) => `t${index}`)
    const cases: Array<[string, unknown]> = [
      ['save', 'not an object'],
      ['save', { ...entry('a'), type: 'preference' }],
      ['save', { ...entry('a'), title: '   ' }],
      ['save', { ...entry('a'), title: '两\n行' }],
      ['save', { ...entry('a'), title: 'x'.repeat(MemoryLimits.titleChars + 1) }],
      ['save', { ...entry('a'), description: '' }],
      ['save', { ...entry('a'), description: 'x'.repeat(MemoryLimits.descriptionChars + 1) }],
      ['save', { ...entry('a'), content: 42 }],
      ['save', { ...entry('a'), content: 'x'.repeat(MemoryLimits.contentChars + 1) }],
      ['save', { ...entry('a'), tags: '发版' }],
      ['save', { ...entry('a'), tags: ['发版,提交'] }],
      ['save', { ...entry('a'), tags: ['x'.repeat(MemoryLimits.tagChars + 1)] }],
      ['save', { ...entry('a'), tags: tooManyTags }],
      ['remove', {}],
      ['remove', { id: 42 }],
    ]
    for (const [operation, input] of cases) {
      expect(
        (await failureOf(space.call(operation, input))).code,
        `${operation} ${JSON.stringify(input).slice(0, 60)}`
      ).toBe('VALIDATION')
    }
    expect(await readdir(root)).toEqual([])
  })

  test('INV-6 取消之后三个操作都不碰磁盘', async () => {
    const scope = createMemoryStore({ root }).scope('system')
    await scope.save(entry('kept'))
    const controller = new AbortController()
    controller.abort(new Error('用户取消了'))
    const { context } = memorySpace(scope, controller.signal)
    await expect(memoryOperations.list(context)).rejects.toThrow('用户取消了')
    await expect(memoryOperations.save(entry('new-one'), context)).rejects.toThrow('用户取消了')
    await expect(memoryOperations.remove({ id: 'kept' }, context)).rejects.toThrow('用户取消了')
    expect((await scope.list()).map((memory) => memory.id)).toEqual(['kept'])
  })

  test('INV-7 人手改过的文件照样认；不是 <合法 id>.md 的文件不算记忆', async () => {
    const scope = createMemoryStore({ root }).scope('system')
    await scope.save(entry('seed'))
    const [directory] = await readdir(root)
    const at = (name: string) => join(root, directory!, name)
    await writeFile(at('plain-note.md'), '# 手写的笔记\r\n\r\n第二段')
    await writeFile(
      at('aliased.md'),
      `${String.fromCharCode(0xfe_ff)}---\r\nname: 别名标题\r\nsummary: "带引号的描述"\r\nkind: Feedback\r\ntags: [发版, Release]\r\n---\r\n正文`
    )
    await writeFile(
      at('odd-type.md'),
      '---\ntitle: 旧类别\ntype: preference\nupdated: 2026-09-01\n---\n还是旧的写法'
    )
    await writeFile(at('Upper-Case.md'), '不算')
    await writeFile(at('notes.txt'), '不算')
    const modified = new Date('2026-01-02T03:04:05.000Z')
    await utimes(at('plain-note.md'), modified, modified)

    const byId = new Map((await scope.list()).map((memory) => [memory.id, memory]))
    expect([...byId.keys()].sort()).toEqual(['aliased', 'odd-type', 'plain-note', 'seed'])
    expect(byId.get('plain-note')).toEqual({
      id: 'plain-note',
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      type: 'work',
      title: 'plain-note',
      description: '手写的笔记',
      tags: [],
      content: '# 手写的笔记\n\n第二段',
      updatedAt: modified.toISOString(),
    })
    expect(byId.get('aliased')).toMatchObject({
      title: '别名标题',
      description: '带引号的描述',
      type: 'feedback',
      tags: ['发版', 'release'],
      content: '正文',
    })
    expect(byId.get('odd-type')).toMatchObject({
      type: 'work',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })
  })
})

describe('开场索引', () => {
  test('INV-8 按类别分组、一行一条，条目后面一行数出现有标签', async () => {
    const scope = createMemoryStore({ root }).scope('system')
    await scope.save(
      entry('ref', {
        type: 'reference',
        title: '发版流水线',
        description: '发版进度看 release 工作流',
        tags: ['发版'],
      })
    )
    await scope.save(
      entry('rule', {
        type: 'feedback',
        title: '提交前先看暂存区',
        description: '提交前跑 git diff --cached',
        tags: ['提交', '发版'],
      })
    )
    await scope.save(
      entry('who', { type: 'user', title: '汇报用中文', description: '写给用户的文字都用中文' })
    )
    await scope.save(
      entry('plan', {
        type: 'work',
        title: '发版顺序',
        description: 'Platform → 产品 → Cloud',
        tags: ['发版'],
      })
    )
    expect(await scope.renderIndex()).toBe(
      [
        '## 记忆（共 4 条，括号里是 id）',
        '### 用户',
        '- [汇报用中文](who) — 写给用户的文字都用中文',
        '### 反馈',
        '- [提交前先看暂存区](rule) — 提交前跑 git diff --cached',
        '### 工作',
        '- [发版顺序](plan) — Platform → 产品 → Cloud',
        '### 参考',
        '- [发版流水线](ref) — 发版进度看 release 工作流',
        '现有标签：发版 3 · 提交 1',
      ].join('\n')
    )
  })

  test('INV-8 放不下时先保用户与反馈，再按更新时间放，条数与字数都有上限，剩下的只报条数', async () => {
    const scope = createMemoryStore({ root }).scope('system')
    await scope.save(entry('old-feedback', { type: 'feedback' }))
    const works = MemoryTuning.index.maxEntries + 20
    for (let index = 0; index < works; index += 1)
      await scope.save(entry(`work-${String(index).padStart(3, '0')}`))

    const byCount = await scope.renderIndex()
    const listedByCount = [...byCount.matchAll(/\]\(([a-z0-9-]+)\)/gu)].map((match) => match[1])
    const newestWorks = (await scope.list())
      .filter((memory) => memory.type === 'work')
      .map((memory) => memory.id)
    expect(listedByCount).toEqual([
      'old-feedback',
      ...newestWorks.slice(0, MemoryTuning.index.maxEntries - 1),
    ])
    expect(byCount).toContain(
      `另有 ${works + 1 - MemoryTuning.index.maxEntries} 条没列出，用 list() 看全部`
    )

    const long = 'x'.repeat(MemoryLimits.descriptionChars)
    for (let index = 0; index < works; index += 1)
      await scope.save(entry(`work-${String(index).padStart(3, '0')}`, { description: long }))
    const byChars = await scope.renderIndex()
    const listedByChars = [...byChars.matchAll(/\]\(([a-z0-9-]+)\)/gu)].map((match) => match[1])
    expect(listedByChars.length).toBeLessThan(MemoryTuning.index.maxEntries)
    expect(listedByChars[0]).toBe('old-feedback')
    const entryLines = byChars.split('\n').filter((line) => line.startsWith('- ['))
    expect(entryLines.reduce((sum, line) => sum + line.length + 1, 0)).toBeLessThanOrEqual(
      MemoryTuning.index.maxChars
    )
    expect(byChars).toContain(`另有 ${works + 1 - listedByChars.length} 条没列出`)
  }, 60_000)
})

describe('模型面', () => {
  test('INV-9 程序照生成的声明调到真实操作；失败时看得到 code 与 message', async () => {
    const space = memorySpace(createMemoryStore({ root }).scope('system'))
    const result = await runModelProgram(
      space,
      `import { list, remove, save } from 'velaros:memory'

export const saved = await save({ id: 'reply-style', type: 'user', title: '回复风格', description: '先给结论', tags: ['汇报'], content: '用户要先给结论。' })
export const titles = (await list()).filter((memory) => memory.tags.includes('汇报')).map((memory) => memory.title)
let failure
try {
  await save({ id: 'Bad Id', type: 'user', title: 't', description: 'd', content: '' })
  failure = '没拦住'
} catch (error) {
  failure = { code: error.code, hasMessage: error.message.includes('reply-style') }
}
export { failure }
export const removed = await remove({ id: 'reply-style' })`
    )
    expect(result.failed).toBeUndefined()
    expect(result.value).toEqual({
      saved: {
        id: 'reply-style',
        created: true,
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      titles: ['回复风格'],
      failure: { code: 'VALIDATION', hasMessage: true },
      removed: { removed: true },
    })
  }, 60_000)

  test('INV-9 声明只放出三个操作，宿主那一面不进模型面', () => {
    expect(VelarMemoryModule.specifier).toBe('velaros:memory')
    expect(VelarMemoryModule.declarations).toBe(MemoryDeclarations)
    expect([...VelarMemoryModule.methods].sort()).toEqual(['list', 'remove', 'save'])
    const space = memorySpace(createMemoryStore({ root }).scope('system'))
    expect([...(space.capabilities.listOperations().memory ?? [])].sort()).toEqual([
      'list',
      'remove',
      'save',
    ])
    const hidden = [
      'MemoryScopePort',
      'MemoryOperationContext',
      'MemoryStore',
      'MemoryScopeSummary',
      'renderIndex',
      'listScopes',
      'abortSignal',
      'AbortSignal',
    ]
    for (const name of hidden)
      expect({ name, shown: MemoryDeclarations.includes(name) }).toEqual({ name, shown: false })
  })

  test('INV-10 声明里写给模型的上限与类别就是常量表里的', () => {
    for (const phrase of [
      `id 用小写字母、数字和连字符，最多 ${MemoryLimits.idChars} 个字符`,
      `标题最多 ${MemoryLimits.titleChars} 个字符、描述最多 ${MemoryLimits.descriptionChars} 个字符`,
      `正文最多 ${MemoryLimits.contentChars} 个字符`,
      `最多 ${MemoryLimits.tagCount} 个，每个最多 ${MemoryLimits.tagChars} 个字符`,
    ])
      expect(MemoryDeclarations, phrase).toContain(phrase)
    expect(MemoryDeclarations).toContain(
      `type MemoryType = ${MemoryTypes.map((type) => `'${type}'`).join(' | ')}`
    )
  })

  test('INV-11 代码模版整份照声明过类型检查，不嵌进声明，随模型面发布的就是这份文件', () => {
    const template = readFileSync(fileURLToPath(new URL('../template.js', import.meta.url)), 'utf8')
    expect(typecheckTemplate(template)).toEqual([])
    expect(template.match(/^import /gmu)).toHaveLength(1)
    expect(VelarMemoryModule.template).toBe(template.replace(/\r\n/g, '\n').trim())
    expect(MemoryDeclarations).not.toContain('的代码模版')
  })

  test('INV-11 代码模版在真的记忆库上逐个函数跑通', async () => {
    const space = memorySpace(createMemoryStore({ root }).scope('system'))
    const result = await runModelProgram(
      space,
      `${VelarMemoryModule.template}
export const first = await rememberPreference()
export const again = await rememberPreference()
export const reason = await addReason()
export const found = await findByTopic()
export const missing = await addReason('no-such-memory')
export const forgot = await forget()
export const forgotAgain = await forget()
`
    )
    expect(result.failed).toBeUndefined()
    expect(result.value).toEqual({
      first: '记下了 reply-in-chinese',
      again: '更新了 reply-in-chinese',
      reason: '给 reply-in-chinese 补上了原因',
      found: [
        {
          id: 'reply-in-chinese',
          title: '汇报用中文',
          content: '写给用户的文字一律用中文；命令、路径、报错原文不翻。\n为什么：用户明确要求过。',
        },
      ],
      missing: '没有 no-such-memory 这一条',
      forgot: '删掉了 reply-in-chinese',
      forgotAgain: '本来就没有 reply-in-chinese',
    })
  }, 120_000)
})
