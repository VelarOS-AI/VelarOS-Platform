/**
 * 长期记忆的不变量验收：`spec/invariants.md` 里每一条「测试」档的检验器。
 * 用例名以 INV-<编号> 开头，`check:module-ownership` 按这个前缀核对登记表与实现对得上。
 * 四个操作一律经代码面的能力端口调（和模型的程序是同一条路）；记忆域的规则跑在真的文件档后端上，后端自己的承诺直接对后端验。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  memoryBackends,
  MemoryEvidenceCategories,
  type MemoryEvidenceInput,
  MemoryInputLimits,
  memoryScopes,
  type MemoryStoreBackend,
  memoryStoreCapabilities,
  VelarMemoryModule,
} from '../index.js'

import {
  checkModelProgram,
  failureOf,
  filesBackend,
  MemoryDeclarations,
  memorySpace,
  ProjectRoot,
  recallItem,
  runModelProgram,
  spyStore,
  storePort,
  SystemRoot,
} from './support.js'

/** 一份最小证据。 */
function evidence(overrides: Partial<MemoryEvidenceInput> = {}): MemoryEvidenceInput {
  return {
    sourceType: 'agent_tool',
    trustLevel: 'agent_derived',
    scopeType: 'workspace',
    scopeId: ProjectRoot.scopeId,
    content: '默认正文。',
    ...overrides,
  }
}

describe('四个操作的记忆规则', () => {
  test('INV-1 写下的证据来源固定 agent_tool、信任级封顶 agent_derived，夹带的自报身份不认', async () => {
    const spy = spyStore()
    await memorySpace(spy.port).call('save', {
      kind: 'preference',
      title: '回复风格',
      content: '用户偏好简洁中文回答。',
      // 模型自报的「用户已确认」不该改变来源与信任级：这两个字段根本不在模型面上，夹带进来也不认。
      trustLevel: 'user_stated',
      sourceType: 'user_message',
    })
    expect(spy.captured).toHaveLength(1)
    expect(spy.captured[0]).toMatchObject({ sourceType: 'agent_tool', trustLevel: 'agent_derived', scopeId: ProjectRoot.scopeId, category: 'preference' })
  })

  test('INV-2 去重键是作用域 + 类别 + 标题 + 正文', async () => {
    const { io, backend } = filesBackend()
    const space = memorySpace(storePort(backend))
    const same = { kind: 'preference', title: '回复风格', content: '用户偏好简洁中文回答。' }
    const first = await space.call('save', same)
    const again = await space.call('save', same)
    expect(again).toMatchObject({ memoryId: first.memoryId, inserted: false })
    const reworded = await space.call('save', { ...same, content: '用户偏好简洁中文回答，先给结论。' })
    expect(reworded.memoryId).not.toBe(first.memoryId)
    expect(Object.keys(io.snapshot()).filter((path) => path.includes('/entries/'))).toHaveLength(2)
  })

  test('INV-3 后端拒收时当场报错，不回「已记下」', async () => {
    // 只给系统根：项目作用域的证据没有可写根，必须拒收。
    const { backend } = filesBackend([SystemRoot])
    const failure = await failureOf(memorySpace(storePort(backend)).call('save', { kind: 'fact', title: '部署步骤', content: '先跑迁移再发版。' }))
    expect(failure.code).toBe('VALIDATION')
    expect(failure.message).toContain('没有对应的记忆目录')
  })

  test('INV-4 get 与 archive 用同一条读门，看不见的 id 一律 NOT_FOUND', async () => {
    const { backend } = filesBackend()
    const writer = memorySpace(storePort(backend), SystemRoot.scopeId)
    const { memoryId } = await writer.call('save', { kind: 'preference', title: '系统池的偏好', content: '这条只属于系统空间。' })
    const otherSpace = memorySpace(storePort(backend), ProjectRoot.scopeId)
    expect((await failureOf(otherSpace.call('get', { id: memoryId }))).code).toBe('NOT_FOUND')
    expect((await failureOf(otherSpace.call('archive', { id: memoryId }))).code).toBe('NOT_FOUND')
    // 归档没有发生：本空间仍然读得到。
    expect((await writer.call('get', { id: memoryId })).id).toBe(memoryId)
  })

  test('INV-5 归档不是删除：普通召回看不到、deep 召回找得到', async () => {
    const { backend } = filesBackend()
    const space = memorySpace(storePort(backend), SystemRoot.scopeId)
    const { memoryId } = await space.call('save', { kind: 'preference', title: '旧偏好', content: '这条稍后会被归档。' })
    expect(await space.call('archive', { id: memoryId })).toMatchObject({ archived: true })
    expect((await space.call('search', { query: '旧偏好' })).count).toBe(0)
    expect((await space.call('search', { query: '旧偏好', deep: true })).count).toBeGreaterThan(0)
  })
})

describe('后端', () => {
  test('INV-6 作用域可见性只有一个判据', () => {
    const projectScope = memoryScopes.projectScope('/repo')
    expect(memoryScopes.scopeTypeOf(projectScope)).toBe('workspace')
    expect(memoryScopes.siteScope('https://example.com')).toBe('site:https://example.com')

    const target = { scopeType: 'workspace' as const, scopeId: projectScope }
    expect(memoryScopes.isVisible(target, { workspaceRoot: '/repo' })).toBe(true)
    expect(memoryScopes.isVisible(target, { workspaceRoot: '/other' })).toBe(false)
  })

  test('INV-7 文件权威层的条目只认本根下 entries/ 里的 .md', async () => {
    const { backend } = filesBackend()
    expect(await backend.getItem('project:/repo::../../../home/.aws/credentials')).toBeNull()
    expect(await backend.getItem('system::../home/id_rsa')).toBeNull()
    expect(await backend.getItem('project:/repo::entries/不存在.md')).toBeNull()
  })

  test('INV-8 落盘前经同一道清洗：秘密打码、正文截断、空内容拒收', async () => {
    // 拼出来而不是写成字面量：`check:public-readiness` 会把仓库里像 API key 的串当真凭据拦下。
    const fakeSecret = `${'sk'}-1234567890abcdefghijklmnop`
    const { io, backend } = filesBackend()
    await memorySpace(storePort(backend), SystemRoot.scopeId).call('save', {
      kind: 'fact',
      title: '接口凭据',
      content: `调用时带 Authorization: Bearer ${fakeSecret} 这个头。`,
    })
    expect(Object.values(io.snapshot()).join('\n')).not.toContain(fakeSecret)
    expect(() => backend.capture(evidence({ content: '   ' }))).toThrow(/不能为空/u)
  })

  test('INV-9 解析权威层跳过派生索引与缺必备动词的后端', () => {
    const { backend } = filesBackend()
    expect(memoryBackends.missingAuthorityVerbs(backend)).toEqual([])
    expect(memoryBackends.isDerivedIndex(backend)).toBe(false)

    const halfBaked = {
      descriptor: { id: 'half', role: 'authority', displayName: '半个权威层', verbs: ['capture'] },
      capture: () => {
        throw new Error('不该被调到')
      },
    } as unknown as MemoryStoreBackend
    expect(memoryBackends.missingAuthorityVerbs(halfBaked).length).toBeGreaterThan(0)

    const registry = {
      getOptionalService: (token: { id: string }) =>
        token.id === memoryStoreCapabilities.capabilityId('half') ? { backend: halfBaked } : undefined,
    }
    expect(memoryStoreCapabilities.resolveAuthority({ registry, preference: ['half'] } as never)).toBeUndefined()
  })

  test('INV-10 写入的作用域根必须与证据的作用域一致', () => {
    const { io, backend } = filesBackend([SystemRoot])
    const rejected = backend.capture(evidence({ scopeId: 'project:/repo', scopeType: 'workspace' }))
    expect(rejected.evidence.id).toBe('')
    expect(Object.keys(io.snapshot()).filter((path) => path.includes('/entries/'))).toHaveLength(0)
  })
})

describe('模型面', () => {
  test('INV-15 入参在做事之前核对：不合法当场 VALIDATION，端口一次都不调', async () => {
    const spy = spyStore()
    const space = memorySpace(spy.port)
    const cases: Array<[string, unknown]> = [
      ['save', { kind: 'user', title: 't', content: 'c' }],
      ['save', { kind: 'secret', title: 't', content: 'c' }],
      ['save', { kind: 'fact', title: '   ', content: 'c' }],
      ['save', { kind: 'fact', title: 'x'.repeat(MemoryInputLimits.titleChars + 1), content: 'c' }],
      ['save', { kind: 'fact', title: 't', content: 'x'.repeat(MemoryInputLimits.contentChars + 1) }],
      ['save', { kind: 'fact', title: 't', content: 'c', summary: 'x'.repeat(MemoryInputLimits.summaryChars + 1) }],
      ['save', { kind: 'fact', title: 't', content: 'c', tags: Array.from({ length: MemoryInputLimits.tagCount + 1 }, (_, index) => `t${index}`) }],
      ['save', { kind: 'fact', title: 't', content: 'c', tags: ['x'.repeat(MemoryInputLimits.tagChars + 1)] }],
      ['search', { query: 'x'.repeat(MemoryInputLimits.queryChars + 1) }],
      ['search', { limit: 0 }],
      ['search', { limit: MemoryInputLimits.results + 1 }],
      ['search', { deep: 'yes' }],
      ['search', { categories: ['reference'] }],
      ['get', { id: '' }],
      ['archive', {}],
    ]
    for (const [operation, input] of cases) {
      expect((await failureOf(space.call(operation, input))).code, `${operation} ${JSON.stringify(input).slice(0, 60)}`).toBe('VALIDATION')
    }
    expect([spy.captured, spy.recalls, spy.reads, spy.archives]).toEqual([[], [], [], []])
  })

  test('INV-16 召回的条数由模型面定、按当前空间的作用域收敛；global 作用域才代表全部', async () => {
    const spy = spyStore()
    await memorySpace(spy.port).call('search', { query: ' 回复风格 ' })
    await memorySpace(spy.port).call('search', {})
    await memorySpace(spy.port).call('search', { query: '旧偏好', deep: true, limit: 3, categories: ['preference'] })
    await memorySpace(spy.port, 'global').call('search', {})
    expect(spy.recalls.map(({ query, options }) => [query, options?.limit, options?.deep, options?.scopeId, options?.categories])).toEqual([
      ['回复风格', MemoryInputLimits.searchDefaultResults, false, ProjectRoot.scopeId, undefined],
      ['', MemoryInputLimits.browseDefaultResults, false, ProjectRoot.scopeId, undefined],
      ['旧偏好', 3, true, ProjectRoot.scopeId, ['preference']],
      ['', MemoryInputLimits.browseDefaultResults, false, undefined, undefined],
    ])
  })

  test('INV-17 交给模型的只有声明里的字段：内部字段不往外带，证据 id 叫 sources，内容不折叠', async () => {
    const tree = recallItem('tree-1', { path: [{ id: 'n1', nodeType: 'trunk', title: '偏好', subjectType: '', subjectId: '' }] })
    const spy = spyStore({ pages: [[recallItem('file-1'), tree]], known: [tree] })
    const space = memorySpace(spy.port)
    const found = await space.call('search', { query: '回复风格' })
    expect(found.count).toBe(2)
    expect(Object.keys(found.memories[0]).sort()).toEqual([
      'activation', 'conceptType', 'confidence', 'id', 'predicate', 'retrievalReason', 'scopeId', 'scopeType', 'sourceTypes', 'sources', 'summary', 'title', 'updatedAt', 'value',
    ])
    expect(found.memories[0]).toMatchObject({ value: '内容 file-1', sources: ['file-1'] })
    expect(found.memories[1].path).toEqual([{ type: 'trunk', title: '偏好' }])
    const read = await space.call('get', { id: 'tree-1' })
    expect(JSON.stringify(read)).not.toContain('claim:')
    expect(JSON.stringify(read)).not.toContain('snapshotVersion')
  })

  test('INV-18 写入回执照后端说：有整理管线的回 consolidating 与 treeVersion，没有的只回 immediate', async () => {
    const files = spyStore()
    expect(await memorySpace(files.port).call('save', { kind: 'fact', title: 't', content: 'c' })).toEqual({ memoryId: `${ProjectRoot.scopeId}::entries/1.md`, inserted: true, availability: 'immediate' })
    const tree = spyStore({ verbs: ['capture', 'recall', 'inspect', 'archive', 'dream'], treeVersion: 42 })
    expect(await memorySpace(tree.port).call('save', { kind: 'fact', title: 't', content: 'c' })).toMatchObject({ availability: 'consolidating', treeVersion: 42 })
  })

  test('INV-19 归档没归到时 archived 为假', async () => {
    const readOnly = spyStore({ known: [recallItem('mine')], readOnly: true })
    expect(await memorySpace(readOnly.port).call('archive', { id: 'mine' })).toEqual({ archived: false, affectedEvidenceIds: [] })
  })

  test('INV-21 声明从源码生成、只放出四个操作；空间端口不进模型面、没有自报身份的旋钮；程序照声明调到真实操作', async () => {
    expect(VelarMemoryModule.specifier).toBe('velar:memory')
    expect(VelarMemoryModule.declarations).toBe(MemoryDeclarations)
    expect([...VelarMemoryModule.methods].sort()).toEqual(['archive', 'get', 'save', 'search'])
    const { backend } = filesBackend()
    const space = memorySpace(storePort(backend))
    expect([...VelarMemoryModule.methods].sort()).toEqual([...(space.capabilities.listOperations().memory ?? [])].sort())
    for (const hidden of ['MemorySpacePort', 'MemoryOperationContext', 'MemoryRecallItem', 'userConfirmed', 'trustLevel', 'sourceType:']) {
      expect(MemoryDeclarations, hidden).not.toContain(hidden)
    }
    const result = await runModelProgram(space, `import { save, search } from 'velar:memory'
export const saved = await save({ kind: 'preference', title: '回复风格', content: '先给结论。' })
const found = await search({ query: '回复风格' })
export const titles = found.memories.map((memory) => memory.title)`)
    expect(result.failed).toBeUndefined()
    expect(result.value).toMatchObject({ saved: { availability: 'immediate', inserted: true }, titles: ['回复风格'] })
  }, 60_000)

  test('INV-22 声明里写给模型的数字与取值就是常量表里的', () => {
    for (const phrase of [
      `title 最多 ${MemoryInputLimits.titleChars} 个字符，content 最多 ${MemoryInputLimits.contentChars} 个字符`,
      `最多 ${MemoryInputLimits.summaryChars} 个字符`,
      `source 最多 ${MemoryInputLimits.sourceChars} 个字符，tags 最多 ${MemoryInputLimits.tagCount} 个、每个最多 ${MemoryInputLimits.tagChars} 个字符`,
      `taskKey 是任务的稳定键，最多 ${MemoryInputLimits.taskKeyChars} 个字符`,
      `最多 ${MemoryInputLimits.queryChars} 个字符`,
      `有 query 时默认 ${MemoryInputLimits.searchDefaultResults}，没有时默认 ${MemoryInputLimits.browseDefaultResults}，最多 ${MemoryInputLimits.results}`,
    ]) expect(MemoryDeclarations, phrase).toContain(phrase)
    expect(MemoryDeclarations).toContain(`type MemoryKind = ${MemoryEvidenceCategories.map((kind) => `'${kind}'`).join(' | ')}`)
  })

  test('INV-23 代码模版整份照生成的声明过类型检查，import 只写一次；它不嵌进声明，随模型面发布的就是这份文件', () => {
    const template = readFileSync(resolve(import.meta.dir, '../template.js'), 'utf8')
    expect(checkModelProgram(template)).toEqual([])
    expect(template.match(/^import /gmu)).toHaveLength(1)
    expect(VelarMemoryModule.template).toBe(template.trim())
    expect(MemoryDeclarations).not.toContain('的代码模版')
  })
})
