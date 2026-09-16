/**
 * INV-4（不变量候选，方案 6.4）：**`memory:get` 与 `memory:archive` 用同一条可见性判据，
 * 当前空间看不见的 id 一律 `NOT_FOUND`，不读不改。**
 *
 * 回归的形状有两个：
 *  ① 归档不过读门——项目会话拿到一个系统池的 id 就能把别的空间的记忆归档掉（系统根总在根列表里）；
 *  ② 工具不看后端回执——文件后端对不存在的 id 回一个空的 `affectedEvidenceIds`，工具照样回
 *     `archived: true` 和「已归档」，模型拿错 id 也会告诉用户归档成功了。
 */

import { describe, expect, test } from 'bun:test'

import type { MemoryApi, MemoryToolContext } from '../../src/contract/requires'
import { createInMemoryMemoryFilesIo } from '../../src/impl/files/InMemoryMemoryFilesIo'
import { createMemoryFilesBackend, type MemoryFilesScopeRoot } from '../../src/impl/files/MemoryFilesBackend'
import { memoryTools } from '../../src/impl/MemoryTools'
import type { MemoryRecallItem } from '../../src/types/memory'

const Verbs = ['capture', 'recall', 'inspect', 'archive'] as const

function createRecallItem(patch: Partial<MemoryRecallItem> = {}): MemoryRecallItem {
  return {
    id: 'project:/repo::entries/a.md',
    claimId: 'project:/repo::entries/a.md',
    conceptId: 'entries/a.md',
    conceptType: 'entity',
    predicate: 'memory',
    title: '回复风格',
    summary: '先给结论。',
    value: '先给结论。',
    scopeType: 'workspace',
    scopeId: 'project:/repo',
    confidence: 1,
    salience: 1,
    activation: 1,
    updatedAt: 1,
    snapshotVersion: 0,
    retrievalReason: 'scope',
    evidenceIds: ['project:/repo::entries/a.md'],
    sourceTypes: ['agent_tool'],
    path: [],
    ...patch,
  }
}

function createContext(input: {
  memoryScope?: string
  item?: Nullable<MemoryRecallItem>
  affectedEvidenceIds?: string[]
  onArchive?: (id: string) => void
}): MemoryToolContext {
  const memory = {
    describeBackend: () => ({ id: 'stub', verbs: Verbs as never }),
    recall: () => [],
    getMemory: () => input.item ?? null,
    archiveMemory: (id: string) => {
      input.onArchive?.(id)
      return { claimId: id, affectedEvidenceIds: input.affectedEvidenceIds ?? [id], treeVersion: 0 }
    },
  } as unknown as MemoryApi

  return {
    abortSignal: new AbortController().signal,
    sessionId: 'session-1',
    memoryScope: input.memoryScope,
    memory,
  }
}

async function archive(id: string, ctx: MemoryToolContext): Promise<Record<string, unknown>> {
  return (await memoryTools['memory:archive'].execute({ id }, ctx)) as Record<string, unknown>
}

describe('memory:archive 可见性读门', () => {
  test('本空间的记忆放行', async () => {
    const result = await archive(
      'project:/repo::entries/a.md',
      createContext({ memoryScope: 'project:/repo', item: createRecallItem() }),
    )
    expect(result.archived).toBe(true)
  })

  test('别的空间的 id 一律 NOT_FOUND，且不下发归档', async () => {
    const touched: string[] = []
    await expect(
      archive(
        'system::entries/a.md',
        createContext({
          memoryScope: 'project:/repo',
          item: createRecallItem({ scopeType: 'system', scopeId: 'system' }),
          onArchive: (id) => touched.push(id),
        }),
      )
    ).rejects.toThrow(/记忆不存在/u)
    expect(touched).toEqual([])
  })

  test('不存在的 id 与越界 id 回同一个 NOT_FOUND', async () => {
    await expect(
      archive('project:/repo::entries/无.md', createContext({ memoryScope: 'project:/repo', item: null }))
    ).rejects.toThrow(/记忆不存在/u)
  })

  test('后端一条都没归档到时如实回 archived: false', async () => {
    const result = await archive(
      'project:/repo::entries/a.md',
      createContext({
        memoryScope: 'project:/repo',
        item: createRecallItem(),
        affectedEvidenceIds: [],
      }),
    )
    expect(result.archived).toBe(false)
    expect(String(result.message)).toContain('没有归档成')
  })
})

describe('文件后端的归档回执', () => {
  const root: MemoryFilesScopeRoot = {
    scopeType: 'workspace',
    scopeId: 'project:/repo',
    directory: '/repo/.velaros/memory',
  }

  function createBackend(readOnly = false) {
    const io = createInMemoryMemoryFilesIo()
    const backend = createMemoryFilesBackend({
      roots: [readOnly ? { ...root, readOnly: true } : root],
      io,
      now: () => 1_700_000_000_000,
    })
    return { io, backend }
  }

  test('不存在的条目抛 NOT_FOUND（与树后端同口径）', () => {
    const { backend } = createBackend()
    expect(() => backend.archive('project:/repo::entries/不存在.md')).toThrow(/记忆不存在/u)
    expect(() => backend.archive('胡编的id')).toThrow(/记忆不存在/u)
  })

  test('只读根上的条目回空 affectedEvidenceIds，而不是假装归档了', () => {
    const { io, backend } = createBackend()
    const captured = backend.capture({
      sourceType: 'agent_tool',
      trustLevel: 'agent_derived',
      scopeId: 'project:/repo',
      scopeType: 'workspace',
      title: '回复风格',
      content: '先给结论。',
      category: 'preference',
    })
    const readOnly = createMemoryFilesBackend({ roots: [{ ...root, readOnly: true }], io })
    expect(readOnly.archive?.(captured.evidence.id).affectedEvidenceIds).toEqual([])
  })
})
