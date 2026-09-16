/**
 * D-7：**叠加编排的语义通道与词法通道过同一道过滤**。
 *
 * 回归的形状：装上向量档、重建一次派生索引之后，
 *  - 用户归档掉的记忆回到普通召回（`rebuild` 按设计把归档条目也收进索引，语义通道不看归档状态）；
 *  - 回合自动召回的 `categories`、`excludeConversationObservations` 口径对语义命中不生效，
 *    原始会话条目被注回模型上下文。
 *
 * 语义命中的检索理由同时改成 `semantic`：从前标 `deep`，和「深层召回 = 把归档翻出来」撞成同一个词。
 */

import { describe, expect, test } from 'bun:test'

import { createLayeredMemoryStoreBackend } from '../../src/backend/Layered'
import { isMemoryRecallItemExcluded } from '../../src/backend/RecallFilter'
import { createInMemoryMemoryFilesIo, createMemoryFilesBackend } from '../../src/files'
import type { MemoryEvidenceInput, MemoryRecallItem } from '../../src/memory-tree/Types'
import type { MemoryEmbedder } from '../../src/vector'
import { createMemoryVectorBackend } from '../../src/vector'

/** 所有文本映射到同一方向：语义层必定全命中，过滤是否生效因此可观测。 */
const allHitEmbedder: MemoryEmbedder = {
  identity: 'fake:1:3',
  dimensions: 3,
  embed: (texts) => Promise.resolve(texts.map(() => [1, 0.5, 0.25])),
}

const Scope = 'project:/repo'

function createStack() {
  const authority = createMemoryFilesBackend({
    roots: [{ scopeType: 'workspace', scopeId: Scope, directory: '/repo/.velaros/memory' }],
    io: createInMemoryMemoryFilesIo(),
    now: () => 1_700_000_000_000,
  })
  return createLayeredMemoryStoreBackend({
    authority,
    derived: [createMemoryVectorBackend({ embedder: allHitEmbedder })],
  })
}

function evidence(overrides: Partial<MemoryEvidenceInput> = {}): MemoryEvidenceInput {
  return {
    sourceType: 'agent_tool',
    trustLevel: 'agent_derived',
    scopeId: Scope,
    scopeType: 'workspace',
    content: '默认正文。',
    ...overrides,
  }
}

describe('语义通道的过滤口径', () => {
  test('重建派生索引之后归档条目不回到普通召回', async () => {
    const layered = createStack()
    const archivedItem = await layered.capture(
      evidence({ title: '旧偏好', content: '用户以前喜欢英文回答。', category: 'preference' }),
    )
    await layered.archive?.(archivedItem.evidence.id)
    await layered.rebuildDerivedIndexes()

    const normal = await layered.recall('喜欢什么语言', { scopeId: Scope })
    expect(normal.map((item) => item.id)).not.toContain(archivedItem.evidence.id)

    const deep = await layered.recall('喜欢什么语言', { scopeId: Scope, includeDormant: true })
    expect(deep.map((item) => item.id)).toContain(archivedItem.evidence.id)
  })

  test('categories 与 excludeConversationObservations 对语义命中同样生效', async () => {
    const layered = createStack()
    await layered.capture(
      evidence({
        sourceType: 'chat_message',
        trustLevel: 'user_stated',
        sourceId: 'c1',
        title: '会话',
        content: '随便聊聊。',
        category: 'conversation',
      }),
    )
    await layered.capture(
      evidence({ title: '偏好', content: '用户偏好简洁中文。', category: 'preference' }),
    )
    await layered.rebuildDerivedIndexes()

    const autoRecall = await layered.recall('喜欢什么', {
      scopeId: Scope,
      excludeConversationObservations: true,
      categories: ['preference'],
    })
    expect(autoRecall.every((item) => item.conceptType !== 'conversation')).toBe(true)
    expect(autoRecall.map((item) => item.title)).toEqual(['偏好'])
  })

  test('语义命中的检索理由是 semantic', async () => {
    const layered = createStack()
    // 正文第二行的词只有语义层看得见：索引行只吃得到首行。
    await layered.capture(
      evidence({ title: '沟通偏好', content: '先给结论再展开细节\n另外不要写任何寒暄' }),
    )
    await layered.rebuildDerivedIndexes()
    const merged = await layered.recall('寒暄', { scopeId: Scope })
    expect(merged).toHaveLength(1)
    expect(merged[0].retrievalReason).toBe('semantic')
  })
})

describe('过滤判据本身', () => {
  function item(patch: Partial<MemoryRecallItem> = {}): MemoryRecallItem {
    return {
      id: 'a',
      claimId: 'a',
      conceptId: 'a',
      conceptType: 'user',
      predicate: 'memory',
      title: 't',
      summary: 's',
      value: 'v',
      scopeType: 'workspace',
      scopeId: Scope,
      confidence: 1,
      salience: 1,
      activation: 1,
      updatedAt: 0,
      snapshotVersion: 0,
      retrievalReason: 'text',
      evidenceIds: ['a'],
      sourceTypes: ['agent_tool'],
      path: [],
      ...patch,
    }
  }

  test('activation 归零 = 归档：普通召回挡下、深层召回放行', () => {
    expect(isMemoryRecallItemExcluded(item({ activation: 0 }), {})).toBe(true)
    expect(isMemoryRecallItemExcluded(item({ activation: 0 }), { includeDormant: true })).toBe(false)
  })

  test('有确切类别时按类别判，缺席时按概念类型反推', () => {
    expect(
      isMemoryRecallItemExcluded(item(), { categories: ['preference'] }, { category: 'feedback' })
    ).toBe(true)
    // 概念类型 user 由 preference / feedback 两个类别共用：只有条目本身能给出确切类别。
    expect(isMemoryRecallItemExcluded(item(), { categories: ['preference'] })).toBe(false)
  })

  test('混合来源只要还有一个未排除的来源就保留', () => {
    const options = { excludeSourceTypes: ['execution_event'] } as const
    expect(
      isMemoryRecallItemExcluded(item({ sourceTypes: ['execution_event'] }), options)
    ).toBe(true)
    expect(
      isMemoryRecallItemExcluded(item({ sourceTypes: ['execution_event', 'chat_message'] }), options)
    ).toBe(false)
  })
})
