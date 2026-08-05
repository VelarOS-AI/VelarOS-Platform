/**
 * `knowledge:search` 的 fail-open 锁（2026-08-05 裁决一①）。
 *
 * 零命中有两种原因（真没有 / 索引没建），对调用方长得一模一样。这里锁住「零命中就补一次
 * 增量同步再重搜，并在结果里说明」——删了它，整个知识栈在默认路径上会重新变成永远返回
 * `count: 0` 的空转通道。
 */

import { describe, expect, test } from 'bun:test'

import type { KnowledgeSearchResult, KnowledgeWorkspaceSyncResult } from '../../src/knowledge'
import { knowledgeTools } from '../../src/knowledge/tools/knowledge'
import type { KnowledgeToolContext } from '../../src/knowledge/Types'

function createSyncResult(patch: Partial<KnowledgeWorkspaceSyncResult> = {}): KnowledgeWorkspaceSyncResult {
  return {
    workspaceRoot: '/repo',
    scanned: 0,
    upserted: 0,
    reindexed: 0,
    reindexBlocked: 0,
    removed: 0,
    skipped: 0,
    forced: false,
    ...patch,
  }
}

function createContext(input: {
  pages: KnowledgeSearchResult[][]
  sync?: () => Promise<KnowledgeWorkspaceSyncResult>
  searchCalls?: { count: number }
  syncCalls?: { count: number }
}): KnowledgeToolContext {
  const pages = [...input.pages]
  return {
    abortSignal: new AbortController().signal,
    sessionId: 'session-1',
    hasProjectRoot: () => true,
    project: { getRootPath: () => '/repo' },
    knowledge: {
      getDiagnostics: () => {
        throw new Error('not used')
      },
      reindexKnowledge: () => {
        throw new Error('not used')
      },
      ensureWorkspaceSynced: async () => {
        if (input.syncCalls) input.syncCalls.count += 1
        return input.sync ? input.sync() : createSyncResult()
      },
      searchKnowledge: async () => {
        if (input.searchCalls) input.searchCalls.count += 1
        return pages.shift() ?? []
      },
    },
  } as unknown as KnowledgeToolContext
}

describe('knowledge:search fail-open', () => {
  test('有命中时不同步、不多搜一次', async () => {
    const searchCalls = { count: 0 }
    const syncCalls = { count: 0 }
    const result = (await knowledgeTools['knowledge:search'].execute(
      { query: 'auth token refresh' },
      createContext({
        pages: [[{ id: 'doc-1' } as unknown as KnowledgeSearchResult]],
        searchCalls,
        syncCalls,
      })
    )) as Record<string, unknown>

    expect(result.count).toBe(1)
    expect(syncCalls.count).toBe(0)
    expect(searchCalls.count).toBe(1)
    expect('autoSync' in result).toBe(false)
  })

  test('零命中 + 同步补进了内容 → 重搜并如实说明', async () => {
    const syncCalls = { count: 0 }
    const result = (await knowledgeTools['knowledge:search'].execute(
      { query: 'auth token refresh' },
      createContext({
        pages: [[], [{ id: 'doc-1' } as unknown as KnowledgeSearchResult]],
        sync: async () => createSyncResult({ scanned: 12, upserted: 12 }),
        syncCalls,
      })
    )) as Record<string, unknown>

    expect(syncCalls.count).toBe(1)
    expect(result.count).toBe(1)
    expect(result.autoSync).toMatchObject({ scanned: 12, indexed: 12 })
  })

  test('零命中 + 同步没补进任何内容 → 不再重搜，但仍如实说明同步跑过', async () => {
    const searchCalls = { count: 0 }
    const result = (await knowledgeTools['knowledge:search'].execute(
      { query: 'auth token refresh' },
      createContext({ pages: [[], []], searchCalls })
    )) as Record<string, unknown>

    expect(searchCalls.count).toBe(1)
    expect(result.count).toBe(0)
    expect(result.autoSync).toMatchObject({ scanned: 0, indexed: 0 })
  })

  test('同步失败不改写搜索的成败——搜索本身已经成功了', async () => {
    const result = (await knowledgeTools['knowledge:search'].execute(
      { query: 'auth token refresh' },
      createContext({
        pages: [[]],
        sync: async () => {
          throw new Error('embedding provider unavailable')
        },
      })
    )) as Record<string, unknown>

    expect(result.count).toBe(0)
    expect('autoSync' in result).toBe(false)
  })
})
