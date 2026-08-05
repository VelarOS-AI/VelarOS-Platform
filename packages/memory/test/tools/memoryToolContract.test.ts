/**
 * `memory:*` 工具契约的机械锁（2026-08-05 裁决二：契约后端无关化 + 死旋钮删除）。
 *
 * 三件事必须锁住，因为它们都是**对模型的承诺**：
 * ① 没有整理管线的后端不许说「稍后整理」，也不许回一个恒 0 的 treeVersion；
 * ② 参数面不许再出现 userConfirmed 这种没有读者的旋钮；
 * ③ 跨作用域读门只有 `memory:get` 这一处，删了它 = 拿到 id 就能跨项目读全文。
 */

import { describe, expect, test } from 'bun:test'

import type { MemoryRecallItem } from '../../src'
import { memoryTools } from '../../src/tools/memory'
import type { MemoryApi, MemoryToolContext } from '../../src/Types'

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
  verbs: MemoryApi extends never ? never : readonly string[]
  memoryScope?: string
  item?: Nullable<MemoryRecallItem>
}): MemoryToolContext {
  const memory = {
    describeBackend: () => ({ id: 'stub', verbs: input.verbs as never }),
    captureEvidence: () => ({
      evidence: { id: 'stub::entries/a.md', ingestSequence: 0 },
      inserted: true,
    }),
    recall: () => [],
    getMemory: () => input.item ?? null,
    getTreeState: () => {
      throw new Error('not used')
    },
    getTreeStateAtVersion: () => {
      throw new Error('not used')
    },
    verifyTreeIntegrity: () => {
      throw new Error('not used')
    },
    getDiagnostics: () => ({ treeVersion: 42 }),
    runDream: () => {
      throw new Error('not used')
    },
    archiveMemory: (id: string) => ({ claimId: id, affectedEvidenceIds: [id], treeVersion: 0 }),
    setEvidenceEligibility: () => {
      throw new Error('not used')
    },
    setSessionEvidenceEligibility: () => {
      throw new Error('not used')
    },
  } as unknown as MemoryApi

  return {
    abortSignal: new AbortController().signal,
    sessionId: 'session-1',
    memoryScope: input.memoryScope,
    memory,
  }
}

describe('memory:save 契约', () => {
  test('参数面不再有 userConfirmed（零读者的死旋钮已删）', () => {
    const parsed = memoryTools['memory:save'].schema.safeParse({
      kind: 'preference',
      title: 't',
      content: 'c',
      userConfirmed: true,
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && 'userConfirmed' in parsed.data).toBe(false)
  })

  test('无 dream 的后端：availability=immediate 且不回 treeVersion', async () => {
    const result = (await memoryTools['memory:save'].execute(
      { kind: 'fact', title: 't', content: 'c' },
      createContext({ verbs: ['capture', 'recall', 'inspect', 'archive'] })
    )) as Record<string, unknown>

    expect(result.availability).toBe('immediate')
    expect('treeVersion' in result).toBe(false)
    expect(result.message).not.toContain('整理')
  })

  test('有 dream 的后端：availability=consolidating 且回该档的版本号', async () => {
    const result = (await memoryTools['memory:save'].execute(
      { kind: 'fact', title: 't', content: 'c' },
      createContext({ verbs: ['capture', 'recall', 'inspect', 'archive', 'dream'] })
    )) as Record<string, unknown>

    expect(result.availability).toBe('consolidating')
    expect(result.treeVersion).toBe(42)
  })
})

describe('memory:get 跨作用域读门', () => {
  const verbs = ['capture', 'recall', 'inspect', 'archive'] as const

  test('本空间的记忆放行', async () => {
    const result = (await memoryTools['memory:get'].execute(
      { id: 'project:/repo::entries/a.md' },
      createContext({ verbs, memoryScope: 'project:/repo', item: createRecallItem() })
    )) as Record<string, unknown>
    expect(result.memory).toBeTruthy()
  })

  test('全局记忆处处可读', async () => {
    const result = (await memoryTools['memory:get'].execute(
      { id: 'global::entries/a.md' },
      createContext({
        verbs,
        memoryScope: 'project:/repo',
        item: createRecallItem({ scopeType: 'global', scopeId: 'global' }),
      })
    )) as Record<string, unknown>
    expect(result.memory).toBeTruthy()
  })

  test('别的空间的记忆当作不存在（不泄漏「存在但无权」）', async () => {
    await expect(
      memoryTools['memory:get'].execute(
        { id: 'project:/other::entries/a.md' },
        createContext({
          verbs,
          memoryScope: 'project:/repo',
          item: createRecallItem({ scopeId: 'project:/other' }),
        })
      )
    ).rejects.toThrow(/记忆不存在/u)
  })

  test('记忆管理面（global scope）代表全部，不受空间门限制', async () => {
    const result = (await memoryTools['memory:get'].execute(
      { id: 'project:/other::entries/a.md' },
      createContext({
        verbs,
        memoryScope: 'global',
        item: createRecallItem({ scopeId: 'project:/other' }),
      })
    )) as Record<string, unknown>
    expect(result.memory).toBeTruthy()
  })
})
