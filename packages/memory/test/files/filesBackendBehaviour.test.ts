/**
 * 文件权威层的四条行为回归（方案第 5 节 D-4、D-5、D-6、D-8）。
 *
 * 每条锁的都是「用户看得见的那个错」：归档的记忆自己回来了、带方括号的标题从索引里消失、
 * 一个项目的记忆落进另一个项目、画像召回稳定返回 0 条。
 */

import { describe, expect, test } from 'bun:test'

import type { MemoryFilesIo } from '../../src/contract/requires'
import type { InMemoryMemoryFilesIoApi } from '../../src/impl/files/InMemoryMemoryFilesIo'
import { InMemoryMemoryFilesIo } from '../../src/impl/files/InMemoryMemoryFilesIo'
import { createMemoryFilesBackend, type MemoryFilesScopeRoot } from '../../src/impl/files/MemoryFilesBackend'
import type { MemoryEvidenceInput } from '../../src/types/memory'
import { parseMemoryFileDocument } from '../../src/utils/files/frontmatter'
import { parseMemoryIndex, serializeMemoryIndex } from '../../src/utils/files/index-file'

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

function createBackend(roots: MemoryFilesScopeRoot[] = [SystemRoot, ProjectRoot]) {
  const io = new InMemoryMemoryFilesIo()
  return {
    io,
    backend: createMemoryFilesBackend({ roots, io, now: () => 1_700_000_000_000 }),
  }
}

function evidence(overrides: Partial<MemoryEvidenceInput> = {}): MemoryEvidenceInput {
  return {
    sourceType: 'agent_tool',
    trustLevel: 'agent_derived',
    scopeId: 'project:/repo',
    scopeType: 'workspace',
    content: '默认正文。',
    ...overrides,
  }
}

function entryFiles(io: InMemoryMemoryFilesIoApi): string[] {
  return Object.keys(io.snapshot()).filter((path) => path.includes('/entries/'))
}

describe('D-4 归档不复活', () => {
  test('同一来源再采集只更新内容，不解除归档、不新建文件', async () => {
    const { io, backend } = createBackend()
    const first = backend.capture(
      evidence({ title: '回复风格', content: '用户偏好简洁中文。', category: 'preference' }),
    )
    await backend.archive?.(first.evidence.id)

    const again = backend.capture(
      evidence({ title: '回复风格', content: '用户偏好简洁中文。', category: 'preference' }),
    )
    expect(again.evidence.id).toBe(first.evidence.id)
    expect(entryFiles(io)).toHaveLength(1)
    expect(backend.recall('回复风格', { scopeId: 'project:/repo' })).toEqual([])
    expect(
      parseMemoryFileDocument(io.snapshot()[entryFiles(io)[0]]).attributes.status,
    ).toBe('archived')
    expect(parseMemoryIndex(io.snapshot()['/repo/.velaros/memory/MEMORY.md'])).toEqual([])
  })

  test('归档后内容变了照样写进同一个文件，深层召回读得到新内容', async () => {
    const { io, backend } = createBackend()
    const first = backend.capture(
      evidence({ sourceId: 's1', title: '回复风格', content: '旧内容。', category: 'preference' }),
    )
    await backend.archive?.(first.evidence.id)
    await backend.capture(
      evidence({ sourceId: 's1', title: '回复风格', content: '新内容。', category: 'preference' }),
    )
    expect(entryFiles(io)).toHaveLength(1)
    const deep = backend.recall('回复风格', { scopeId: 'project:/repo', includeDormant: true })
    expect(deep).toHaveLength(1)
    expect(deep[0].value).toBe('新内容。')
    expect(deep[0].activation).toBe(0)
  })
})

describe('D-5 索引行转义', () => {
  test('名字里的方括号与换行经序列化往返保真', () => {
    const entries = [
      { path: 'entries/a.md', name: '[重要] 回复风格', description: '先给结论' },
      { path: 'entries/b.md', name: '多行\n标题', description: '描述' },
      { path: 'entries/c.md', name: '带反斜杠 \\ 的名字', description: '' },
    ]
    expect(parseMemoryIndex(serializeMemoryIndex(entries))).toEqual([
      { path: 'entries/a.md', name: '[重要] 回复风格', description: '先给结论' },
      { path: 'entries/b.md', name: '多行 标题', description: '描述' },
      { path: 'entries/c.md', name: '带反斜杠 \\ 的名字', description: '' },
    ])
  })

  test('标题含方括号的条目照常进索引、照常召回、不会每次新建文件', async () => {
    const { io, backend } = createBackend()
    const first = backend.capture(
      evidence({ title: '[重要] 回复风格', content: '先给结论。', category: 'preference' }),
    )
    expect(backend.recall('回复风格', { scopeId: 'project:/repo' })).toHaveLength(1)

    const again = backend.capture(
      evidence({ title: '[重要] 回复风格', content: '先给结论。', category: 'preference' }),
    )
    expect(again.evidence.id).toBe(first.evidence.id)
    expect(entryFiles(io)).toHaveLength(1)
    expect(parseMemoryIndex(io.snapshot()['/repo/.velaros/memory/MEMORY.md'])).toHaveLength(1)
  })
})

describe('D-6 找不到对应作用域根就拒收', () => {
  test('别的项目的证据不落进当前项目', () => {
    const { io, backend } = createBackend()
    const result = backend.capture(
      evidence({ scopeId: 'project:/other', title: '别的项目', content: '属于 /other 的记忆。' }),
    )
    expect(result.inserted).toBe(false)
    expect(result.evidence.id).toBe('')
    expect(result.evidence.scopeId).toBe('project:/other')
    expect(entryFiles(io)).toEqual([])
  })

  test('站点证据不落进系统池', () => {
    const { io, backend } = createBackend()
    const result = backend.capture(
      evidence({
        scopeId: 'site:https://example.com',
        scopeType: 'site',
        title: '站点',
        content: '来自网页。',
      }),
    )
    expect(result.evidence.scopeId).toBe('site:https://example.com')
    expect(entryFiles(io)).toEqual([])
  })

  test('两轴皆空（调用方没说作用域）才走兜底根', () => {
    const { io, backend } = createBackend([SystemRoot])
    const result = backend.capture({
      sourceType: 'agent_tool',
      trustLevel: 'agent_derived',
      title: '无作用域',
      content: '内容。',
    })
    expect(result.inserted).toBe(true)
    expect(result.evidence.scopeId).toBe('system')
    expect(entryFiles(io)).toHaveLength(1)
  })
})

describe('D-8 先筛后截断', () => {
  test('30 条会话之后画像召回仍然返回偏好', async () => {
    const { backend } = createBackend()
    await backend.capture(
      evidence({ title: '回复风格', content: '用户偏好简洁中文。', category: 'preference' }),
    )
    for (let index = 0; index < 30; index += 1) {
      await backend.capture(
        evidence({
          sourceType: 'chat_message',
          trustLevel: 'user_stated',
          sourceId: `m${index}`,
          title: `消息 ${index}`,
          content: `第 ${index} 条聊天`,
          category: 'conversation',
        }),
      )
    }
    const profile = backend.recall('', {
      scopeId: 'project:/repo',
      categories: ['preference', 'feedback', 'interest'],
      limit: 12,
    })
    expect(profile).toHaveLength(1)
    expect(profile[0].title).toBe('回复风格')
  })
})

describe('D-10 稳定键映射（进程内）', () => {
  test('已有 200 条时再写一条不会把每个条目都读一遍', async () => {
    const io = new InMemoryMemoryFilesIo()
    let reads = 0
    const counted: MemoryFilesIo = {
      join: (...segments: readonly string[]) => io.join(...segments),
      ensureDirectory: (directory: string) => { io.ensureDirectory(directory) },
      listFiles: (directory: string) => io.listFiles(directory),
      readTextFile: (path: string) => { reads += 1; return io.readTextFile(path) },
      writeTextFile: (path: string, content: string) => { io.writeTextFile(path, content) },
      deleteFile: (path: string) => { io.deleteFile(path) },
      isInsideDirectory: (path: string, root: string) => io.isInsideDirectory?.(path, root) ?? true,
    }
    const backend = createMemoryFilesBackend({
      roots: [ProjectRoot],
      io: counted,
      now: () => 1_700_000_000_000,
    })
    for (let index = 0; index < 200; index += 1) {
      await backend.capture(
        evidence({
          sourceType: 'chat_message',
          trustLevel: 'user_stated',
          sourceId: `s${index}`,
          title: `消息 ${index}`,
          content: `第 ${index} 条`,
          category: 'conversation',
        }),
      )
    }
    reads = 0
    await backend.capture(
      evidence({
        sourceType: 'chat_message',
        trustLevel: 'user_stated',
        sourceId: 'new',
        title: '新消息',
        content: '新',
        category: 'conversation',
      }),
    )
    expect(reads).toBeLessThan(10)
  })
})
