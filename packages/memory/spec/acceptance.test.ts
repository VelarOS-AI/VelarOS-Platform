/**
 * 长期记忆的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，只经根入口 `../src/index`；实现细节的测试在 test/ 目录。
 */

import { describe, expect, test } from 'bun:test'

import {
  createMemoryFilesBackend,
  memoryBackends,
  type MemoryEvidenceInput,
  type MemoryFilesIo,
  type MemoryFilesScopeRoot,
  type MemoryRecallItem,
  memoryScopes,
  type MemoryStoreBackend,
  memoryStoreCapabilities,
  type MemoryToolApi,
  type MemoryToolContext,
  memoryTools,
} from '../src/index'

const ProjectRoot: MemoryFilesScopeRoot = {
  scopeType: 'workspace',
  scopeId: 'project:/repo',
  directory: '/repo/.velaros/memory',
}
const SystemRoot: MemoryFilesScopeRoot = {
  scopeType: 'system',
  scopeId: 'system',
  directory: '/userData/memory',
}

/** 纯内存的文件端口：验收只经公开的注入面，不碰磁盘，也不用包内的测试替身。 */
function memoryIo(): MemoryFilesIo & { snapshot(): Record<string, string> } {
  const files = new Map<string, string>()
  return {
    join: (...segments) => segments.join('/'),
    ensureDirectory: () => {},
    listFiles: (directory) =>
      [...files.keys()]
        .filter((path) => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes('/'))
        .map((path) => path.slice(directory.length + 1)),
    readTextFile: (path) => files.get(path) ?? null,
    writeTextFile: (path, content) => {
      files.set(path, content)
    },
    deleteFile: (path) => {
      files.delete(path)
    },
    snapshot: () => Object.fromEntries([...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
  }
}

/** 一个跑在文件权威层上的后端，外加它的文件快照。 */
function filesBackend(roots: readonly MemoryFilesScopeRoot[] = [SystemRoot, ProjectRoot]) {
  const io = memoryIo()
  return { io, backend: createMemoryFilesBackend({ roots, io, now: () => 1_700_000_000_000 }) }
}

/** 把一个后端包成工具上下文里的宿主端口 `ctx.memory`。 */
function toolContext(backend: MemoryStoreBackend, scopeId: string): MemoryToolContext {
  const memory: MemoryToolApi = {
    describeBackend: () => ({ id: backend.descriptor.id, verbs: backend.descriptor.verbs }),
    captureEvidence: (input) => backend.capture(input),
    recall: (query, options) => backend.recall(query, options),
    getMemory: (memoryId) => backend.getItem(memoryId),
    getDiagnostics: () => {
      throw new Error('本用例不读诊断')
    },
    archiveMemory: (memoryId) => backend.archive?.(memoryId) ?? { affectedEvidenceIds: [] },
  } as unknown as MemoryToolApi
  return {
    abortSignal: new AbortController().signal,
    sessionId: 'session-acceptance',
    memoryScope: scopeId,
    memory,
  } as unknown as MemoryToolContext
}

/** 跑一个记忆工具：先过它自己的 schema，再执行，和宿主的调用路径一致。 */
async function runTool(
  name: 'memory:save' | 'memory:search' | 'memory:get' | 'memory:archive',
  raw: Record<string, unknown>,
  ctx: MemoryToolContext,
): Promise<Record<string, unknown>> {
  const tool = memoryTools[name]
  const input = tool.schema.parse(raw) as Record<string, unknown>
  return (await tool.execute(input as never, ctx)) as Record<string, unknown>
}

/** 一份最小证据。 */
function evidence(overrides: Partial<MemoryEvidenceInput> = {}): MemoryEvidenceInput {
  return {
    sourceType: 'agent_tool',
    trustLevel: 'agent_derived',
    scopeType: 'workspace',
    scopeId: 'project:/repo',
    content: '默认正文。',
    ...overrides,
  }
}

describe('记忆包的对外承诺', () => {
  test('INV-1 工具写下的证据来源固定 agent_tool、信任级封顶 agent_derived', async () => {
    const { backend } = filesBackend()
    const captured: MemoryEvidenceInput[] = []
    const ctx = toolContext(
      {
        ...backend,
        capture: (input: MemoryEvidenceInput) => {
          captured.push(input)
          return backend.capture(input)
        },
      } as unknown as MemoryStoreBackend,
      'project:/repo',
    )

    await runTool('memory:save', {
      kind: 'preference',
      title: '回复风格',
      content: '用户偏好简洁中文回答。',
      // 模型自报的「用户已确认」不该改变来源与信任级：这两个字段根本不在模型面上。
      trustLevel: 'user_stated',
      sourceType: 'user_message',
    }, ctx)

    expect(captured).toHaveLength(1)
    expect(captured[0]?.sourceType).toBe('agent_tool')
    expect(captured[0]?.trustLevel).toBe('agent_derived')
  })

  test('INV-2 去重键是作用域 + 类别 + 标题 + 正文', async () => {
    const { io, backend } = filesBackend()
    const ctx = toolContext(backend, 'project:/repo')
    const same = { kind: 'preference', title: '回复风格', content: '用户偏好简洁中文回答。' }

    const first = await runTool('memory:save', same, ctx)
    const again = await runTool('memory:save', same, ctx)
    expect(first.memoryId).toBe(again.memoryId as string)

    const reworded = await runTool('memory:save', { ...same, content: '用户偏好简洁中文回答，先给结论。' }, ctx)
    expect(reworded.memoryId).not.toBe(first.memoryId as string)

    const entries = Object.keys(io.snapshot()).filter((path) => path.includes('/entries/'))
    expect(entries).toHaveLength(2)
  })

  test('INV-3 后端拒收时当场报错，不回「已记下」', async () => {
    // 只给系统根：项目作用域的证据没有可写根，必须拒收。
    const { backend } = filesBackend([SystemRoot])
    const ctx = toolContext(backend, 'project:/repo')

    await expect(
      runTool('memory:save', { kind: 'fact', title: '部署步骤', content: '先跑迁移再发版。' }, ctx),
    ).rejects.toThrow(/没有对应的记忆目录/u)
  })

  test('INV-4 get 与 archive 用同一条读门，看不见的 id 一律 NOT_FOUND', async () => {
    const { backend } = filesBackend()
    const writer = toolContext(backend, 'system')
    const written = await runTool('memory:save', {
      kind: 'preference',
      title: '系统池的偏好',
      content: '这条只属于系统空间。',
    }, writer)
    const id = written.memoryId as string

    const otherSpace = toolContext(backend, 'project:/repo')
    await expect(runTool('memory:get', { id }, otherSpace)).rejects.toThrow(/记忆不存在/u)
    await expect(runTool('memory:archive', { id }, otherSpace)).rejects.toThrow(/记忆不存在/u)

    // 归档没有发生：本空间仍然读得到。
    const read = await runTool('memory:get', { id }, writer)
    expect((read.memory as MemoryRecallItem).id).toBe(id)
  })

  test('INV-5 归档不是删除：普通召回看不到、deep 召回找得到', async () => {
    const { backend } = filesBackend()
    const ctx = toolContext(backend, 'system')
    const written = await runTool('memory:save', {
      kind: 'preference',
      title: '旧偏好',
      content: '这条稍后会被归档。',
    }, ctx)
    const id = written.memoryId as string

    const archived = await runTool('memory:archive', { id }, ctx)
    expect(archived.archived).toBe(true)
    expect(archived.physicalDelete).toBe(false)

    const normal = await runTool('memory:search', { query: '旧偏好' }, ctx)
    expect((normal.memories as unknown[]).length).toBe(0)

    const deep = await runTool('memory:search', { query: '旧偏好', deep: true }, ctx)
    expect((deep.memories as unknown[]).length).toBeGreaterThan(0)
  })

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
    const { io, backend } = filesBackend()
    const ctx = toolContext(backend, 'system')
    await runTool('memory:save', {
      kind: 'fact',
      title: '接口凭据',
      content: '调用时带 Authorization: Bearer sk-1234567890abcdefghijklmnop 这个头。',
    }, ctx)

    const written = Object.values(io.snapshot()).join('\n')
    expect(written).not.toContain('sk-1234567890abcdefghijklmnop')

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
    expect(
      memoryStoreCapabilities.resolveAuthority({ registry, preference: ['half'] } as never),
    ).toBeUndefined()
  })

  test('INV-10 写入的作用域根必须与证据的作用域一致', () => {
    const { io, backend } = filesBackend([SystemRoot])
    const rejected = backend.capture(evidence({ scopeId: 'project:/repo', scopeType: 'workspace' }))
    expect(rejected.evidence.id).toBe('')
    expect(Object.keys(io.snapshot()).filter((path) => path.includes('/entries/'))).toHaveLength(0)
  })
})
