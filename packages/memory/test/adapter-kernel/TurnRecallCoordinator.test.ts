import { describe, expect, test } from 'bun:test'

import type { MemoryRecallItem } from '../../src'
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
    const coordinator = createCoordinator(async () => [RecallItem])
    const result = await coordinator.recallUserMessage({
      sessionId: 'engine-session',
      query: 'remember engine contract',
      workspaceRoot: '/workspace',
    })

    expect(result.summaries).toHaveLength(1)
    expect(result.summaries[0]).toContain('Keep the engine route fail closed.')
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
})
