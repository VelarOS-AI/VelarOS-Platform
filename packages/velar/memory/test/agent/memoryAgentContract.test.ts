/**
 * velar:memory契约的机械锁（2026-08-05 裁决二：契约后端无关化）。
 *
 * 两件事必须锁住，因为它们最终都是**对模型的承诺**（模型面 `velar:memory` 原样转述）：
 * ① 没有整理管线的后端不许说「稍后整理」，也不许回一个恒 0 的 treeVersion；
 * ② 跨作用域读门只有 get 这一处，删了它 = 拿到 id 就能跨项目读全文。
 * 参数面不许出现 userConfirmed 这种没有读者的旋钮——那是模型面的事，钉在 `velar:memory` 的验收里。
 */

import { describe, expect, test } from 'bun:test'

import type { MemoryApi, MemoryOperationContext } from '../../contract/requires.js'
import { memoryOperations } from '../../impl/MemoryOperations.js'
import type { MemoryRecallItem } from '../../types/memory.js'

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
}): MemoryOperationContext {
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

describe('save 契约', () => {
  test('无 dream 的后端：availability=immediate 且不回 treeVersion', async () => {
    const result = await memoryOperations.save(
      { kind: 'fact', title: 't', content: 'c' },
      createContext({ verbs: ['capture', 'recall', 'inspect', 'archive'] })
    )

    expect(result.availability).toBe('immediate')
    expect('treeVersion' in result).toBe(false)
  })

  test('有 dream 的后端：availability=consolidating 且回该档的版本号', async () => {
    const result = await memoryOperations.save(
      { kind: 'fact', title: 't', content: 'c' },
      createContext({ verbs: ['capture', 'recall', 'inspect', 'archive', 'dream'] })
    )

    expect(result.availability).toBe('consolidating')
    expect(result.treeVersion).toBe(42)
  })
})

describe('get 跨作用域读门', () => {
  const verbs = ['capture', 'recall', 'inspect', 'archive'] as const

  test('本空间的记忆放行', async () => {
    const result = await memoryOperations.get(
      { id: 'project:/repo::entries/a.md' },
      createContext({ verbs, memoryScope: 'project:/repo', item: createRecallItem() })
    )
    expect(result.id).toBeTruthy()
  })

  test('全局记忆处处可读', async () => {
    const result = await memoryOperations.get(
      { id: 'global::entries/a.md' },
      createContext({
        verbs,
        memoryScope: 'project:/repo',
        item: createRecallItem({ scopeType: 'global', scopeId: 'global' }),
      })
    )
    expect(result.id).toBeTruthy()
  })

  test('别的空间的记忆当作不存在（不泄漏「存在但无权」）', async () => {
    await expect(
      memoryOperations.get(
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
    const result = await memoryOperations.get(
      { id: 'project:/other::entries/a.md' },
      createContext({
        verbs,
        memoryScope: 'global',
        item: createRecallItem({ scopeId: 'project:/other' }),
      })
    )
    expect(result.id).toBeTruthy()
  })
})
