import { describe, expect, setSystemTime, test } from 'bun:test'

import type { MemoryRecallItem, MemoryRecallOptions } from '../../src'
import { MemoryTurnRecallCoordinator } from '../../src/adapter-kernel/TurnRecallCoordinator'

const RecallItem: MemoryRecallItem = {
  id: 'memory-1',
  claimId: 'claim-1',
  conceptId: 'concept-1',
  conceptType: 'topic',
  predicate: 'summary',
  title: 'Engine memory',
  summary: 'Keep the engine route fail closed.',
  value: null,
  scopeType: 'workspace',
  scopeId: 'workspace-1',
  confidence: 0.9,
  salience: 0.8,
  activation: 0.7,
  updatedAt: 1,
  snapshotVersion: 1,
  retrievalReason: 'scope',
  evidenceIds: ['evidence-1'],
  sourceTypes: ['user_correction'],
  path: [],
}

function createCoordinator(
  recall: (query: string) => Promise<MemoryRecallItem[]>
): MemoryTurnRecallCoordinator {
  return new MemoryTurnRecallCoordinator({
    recall,
    resolveScope: () => ({
      scopeType: 'workspace',
      scopeId: 'workspace-1' as never,
    }),
    turnContextScopes: ['engine'],
  })
}

describe('MemoryTurnRecallCoordinator awaitable engine recall', () => {
  test('returns summaries without writing the Solo turn-context ledger', async () => {
    let recallOptions: MemoryRecallOptions | undefined
    const coordinator = new MemoryTurnRecallCoordinator({
      recall: async (_query, options) => {
        recallOptions = options
        return [RecallItem]
      },
      resolveScope: () => ({ scopeType: 'workspace', scopeId: 'workspace-1' as never }),
      turnContextScopes: ['engine'],
    })
    const result = await coordinator.recallUserMessage({
      sessionId: 'engine-session',
      query: 'remember engine contract',
      workspaceRoot: '/workspace',
    })

    expect(result.summaries).toHaveLength(1)
    expect(result.summaries[0]).toContain('Keep the engine route fail closed.')
    expect(recallOptions).toMatchObject({
      excludeAgentConversationEchoes: true,
      excludeConversationObservations: true,
      excludeSourceTypes: ['workspace_event', 'execution_event', 'computer_use'],
    })
    expect(
      coordinator.createTurnContextSource().peekCached({
        sessionId: 'engine-session',
        afterSeq: 0,
        generation: null,
      }).deltas
    ).toEqual([])
  })

  test('times out to an empty result and never blocks the send path', async () => {
    let resolveRecall: (items: MemoryRecallItem[]) => void = () => undefined
    const coordinator = createCoordinator(
      () =>
        new Promise((resolve) => {
          resolveRecall = resolve
        })
    )
    const startedAt = Date.now()
    const result = await coordinator.recallUserMessage(
      {
        sessionId: 'slow-engine-session',
        query: 'remember engine contract',
      },
      20
    )

    expect(result).toEqual({ summaries: [] })
    expect(Date.now() - startedAt).toBeLessThan(250)
    resolveRecall([RecallItem])
    await Promise.resolve()
  })

  test('swallows recall failures into an empty result', async () => {
    const coordinator = createCoordinator(async () => {
      throw new Error('recall unavailable')
    })

    await expect(
      coordinator.recallUserMessage({
        sessionId: 'failed-engine-session',
        query: 'remember engine contract',
      })
    ).resolves.toEqual({ summaries: [] })
  })

  test('does not inject operational-only observations even if a backend ignores source filters', async () => {
    const coordinator = createCoordinator(async () => [{
      ...RecallItem,
      id: 'operational-memory',
      sourceTypes: ['workspace_event', 'execution_event'],
    }])

    await expect(
      coordinator.recallUserMessage({
        sessionId: 'operational-session',
        query: 'review project tool behavior',
      })
    ).resolves.toEqual({ summaries: [] })
  })

  test('does not inject raw conversation observations but keeps curated chat-backed claims eligible', async () => {
    const coordinator = createCoordinator(async () => [
      {
        ...RecallItem,
        id: 'conversation-observation',
        predicate: 'conversation_observation',
        sourceTypes: ['chat_message'],
      },
      {
        ...RecallItem,
        id: 'curated-preference',
        predicate: 'preference',
        sourceTypes: ['chat_message'],
      },
    ])

    const result = await coordinator.recallUserMessage({
      sessionId: 'conversation-session',
      query: 'remember my preferred workflow',
    })

    expect(result.summaries).toHaveLength(1)
    expect(result.summaries[0]).toContain('Keep the engine route fail closed.')
  })
})

describe('MemoryTurnRecallCoordinator in-flight latch watchdog (审计 U38)', () => {
  test('一次永不 settle 的召回不会永久关闭该会话的自动召回', () => {
    let recallCalls = 0
    const coordinator = createCoordinator(() => {
      recallCalls += 1
      // embedding 网关 TCP 挂起：既不 resolve 也不 reject，`.finally` 永不执行。
      return new Promise<MemoryRecallItem[]>(() => undefined)
    })
    const input = { sessionId: 'stuck-session', query: 'remember the deploy contract' }

    setSystemTime(new Date('2026-08-05T00:00:00.000Z'))
    coordinator.notifyUserMessage(input)
    expect(recallCalls).toBe(1)

    // 闩还新鲜时照旧节流（防连发堆积，这是闩的本职）。
    coordinator.notifyUserMessage(input)
    expect(recallCalls).toBe(1)

    // 过了硬预算：那次召回不会回来了，看门狗就地放行，会话恢复自动召回。
    setSystemTime(new Date('2026-08-05T00:01:00.000Z'))
    coordinator.notifyUserMessage(input)
    expect(recallCalls).toBe(2)
    setSystemTime()
  })
})

describe('independent task memory use policy', () => {
  test('a session recall pause gates both entry points without changing another session', async () => {
    let calls = 0
    const coordinator = new MemoryTurnRecallCoordinator({
      recall: async () => { calls += 1; return [RecallItem] },
      isSessionRecallAllowed: (id) => id !== 'paused',
      resolveScope: () => ({ scopeType: 'workspace', scopeId: 'workspace-1' as never }),
      turnContextScopes: ['project'],
    })
    coordinator.notifyUserMessage({ sessionId: 'paused', query: 'use prior memory' })
    expect(await coordinator.recallUserMessage({ sessionId: 'paused', query: 'use prior memory' })).toEqual({ summaries: [] })
    expect(calls).toBe(0)
    expect((await coordinator.recallUserMessage({ sessionId: 'other', query: 'use prior memory' })).summaries).toHaveLength(1)
  })

  test('turning memory use off while retrieval is pending prevents late injection and does not consume the memory', async () => {
    let enabled = true
    let finish: (items: MemoryRecallItem[]) => void = () => undefined
    let first = true
    const coordinator = new MemoryTurnRecallCoordinator({
      recall: async () => {
        if (!first) return [RecallItem]
        first = false
        return new Promise((resolve) => { finish = resolve })
      },
      isSessionRecallAllowed: () => enabled,
      resolveScope: () => ({ scopeType: 'workspace', scopeId: 'workspace-1' as never }),
      turnContextScopes: ['project'],
    })
    const pending = coordinator.recallUserMessage({ sessionId: 's', query: 'use prior memory' })
    enabled = false
    finish([RecallItem])
    expect(await pending).toEqual({ summaries: [] })
    enabled = true
    expect((await coordinator.recallUserMessage({ sessionId: 's', query: 'use prior memory' })).summaries).toHaveLength(1)
  })

  test('a pause also hides already queued recall from a later model turn', async () => {
    let enabled = true
    const coordinator = new MemoryTurnRecallCoordinator({
      recall: async () => [RecallItem],
      isSessionRecallAllowed: () => enabled,
      resolveScope: () => ({ scopeType: 'workspace', scopeId: 'workspace-1' as never }),
      turnContextScopes: ['project'],
    })
    coordinator.notifyUserMessage({ sessionId: 's', query: 'use prior memory' })
    await Promise.resolve()
    await Promise.resolve()
    const source = coordinator.createTurnContextSource()
    expect(source.peekCached({ sessionId: 's', afterSeq: 0, generation: null }).deltas).toHaveLength(1)
    enabled = false
    expect(source.peekCached({ sessionId: 's', afterSeq: 0, generation: null }).deltas).toHaveLength(0)
  })
})
