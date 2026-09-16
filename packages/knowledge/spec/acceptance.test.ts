/**
 * 工作区知识库的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，只经根入口；实现细节的测试在 test/ 目录。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { KnowledgeToolContext } from '../src/contract/requires'
import {
  buildDocumentRevisionKey,
  buildEmbeddingProfileIdentity,
  buildIndexTextHash,
  canReuseReadyContentIndex,
  EmbeddingApi,
  Embeddings,
  knowledgeTools,
  KnowledgeWorkspace,
} from '../src/exports/index'
import type {
  KnowledgeSearchResult,
  KnowledgeWorkspaceSyncResult,
} from '../src/types/knowledge'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'knowledge-acceptance-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 在临时根里写一个文件，缺的目录补上。 */
async function write(relativePath: string, content = 'content'): Promise<string> {
  const absolute = join(root, relativePath)
  await mkdir(join(absolute, '..'), { recursive: true })
  await writeFile(absolute, content)
  return absolute
}

/** 一份同步回执的空壳，只有点名的字段有值。 */
function syncResult(patch: Partial<KnowledgeWorkspaceSyncResult> = {}): KnowledgeWorkspaceSyncResult {
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

/** 造一个工具上下文：搜索按 pages 逐次返回，同步与根解析可以按用例替换。 */
function toolContext(input: {
  pages?: KnowledgeSearchResult[][]
  projectRoot?: string | null
  counters?: { search: number; sync: number }
}): KnowledgeToolContext {
  const pages = [...(input.pages ?? [])]
  const counters = input.counters ?? { search: 0, sync: 0 }
  return {
    abortSignal: new AbortController().signal,
    sessionId: 'session-acceptance',
    hasProjectRoot: () => input.projectRoot != null,
    project: { getRootPath: () => input.projectRoot ?? '' },
    knowledge: {
      getDiagnostics: () => {
        throw new Error('本用例不读诊断')
      },
      reindexKnowledge: () => {
        throw new Error('本用例不重建')
      },
      ensureWorkspaceSynced: async () => {
        counters.sync += 1
        return syncResult()
      },
      searchKnowledge: async () => {
        counters.search += 1
        return pages.shift() ?? []
      },
    },
  } as unknown as KnowledgeToolContext
}

describe('检索', () => {
  test('INV-1 有命中就不写：搜索不触发同步，也不多搜一次', async () => {
    const counters = { search: 0, sync: 0 }
    const result = (await knowledgeTools['knowledge:search'].execute(
      { query: '认证流程' },
      toolContext({
        pages: [[{ id: 'doc-1' } as unknown as KnowledgeSearchResult]],
        projectRoot: '/repo',
        counters,
      })
    )) as Record<string, unknown>

    expect(result.count).toBe(1)
    expect(counters.sync).toBe(0)
    expect(counters.search).toBe(1)
  })

  test('INV-1 零命中时只补一次增量同步，并在回执里说明', async () => {
    const counters = { search: 0, sync: 0 }
    const result = (await knowledgeTools['knowledge:search'].execute(
      { query: '认证流程' },
      toolContext({ pages: [[], []], projectRoot: '/repo', counters })
    )) as Record<string, unknown>

    expect(counters.sync).toBe(1)
    expect(result.count).toBe(0)
    expect(result.autoSync).toBeDefined()
  })

  test('INV-2 没有绑定工作区根时报错，不猜一个根', async () => {
    await expect(
      knowledgeTools['knowledge:search'].execute(
        { query: '认证流程' },
        toolContext({ pages: [[]], projectRoot: null })
      )
    ).rejects.toThrow(/workspaceRoot/u)
  })

  test('INV-7 诊断只读：不同步、不搜索、不重建', async () => {
    const counters = { search: 0, sync: 0 }
    const context = toolContext({ projectRoot: '/repo', counters })
    let diagnosticsCalls = 0
    const readOnly = {
      ...context,
      knowledge: {
        ...context.knowledge,
        getDiagnostics: async () => {
          diagnosticsCalls += 1
          return { documents: 0 }
        },
      },
    } as unknown as KnowledgeToolContext

    const result = (await knowledgeTools['knowledge:diagnostics'].execute({}, readOnly)) as Record<string, unknown>

    expect(diagnosticsCalls).toBe(1)
    expect(result.diagnostics).toEqual({ documents: 0 })
    expect(counters).toEqual({ search: 0, sync: 0 })
  })
})

describe('工作区摄入', () => {
  test('INV-4 只列根内的文件', async () => {
    await write('public/readme.md')
    await write('docs/guide.md')
    const outside = await mkdtemp(join(tmpdir(), 'knowledge-outside-'))
    try {
      await writeFile(join(outside, 'secret.md'), 'secret')
      const workspace = new KnowledgeWorkspace()
      const files = await workspace.listDocumentFiles(root)
      expect(files.map((file) => file.path).sort()).toEqual(['docs/guide.md', 'public/readme.md'])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('INV-4 根外的候选路径提示一律丢弃', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'knowledge-outside-'))
    try {
      await writeFile(join(outside, 'secret.ts'), 'export const secret = true')
      const workspace = new KnowledgeWorkspace()
      const candidates = await workspace.listCodeCandidates({
        workspaceRoot: root,
        pathHints: [join(outside, 'secret.ts')],
        symbolHints: [],
        limit: 5,
      })
      expect(candidates).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('嵌入 profile', () => {
  test('INV-3 provider、model、维度任一不同就是另一个向量空间', () => {
    const base = buildEmbeddingProfileIdentity({ provider: 'openai', model: 'text-embedding-3-small' }, 1536)
    const otherModel = buildEmbeddingProfileIdentity({ provider: 'openai', model: 'text-embedding-3-large' }, 1536)
    const otherDimensions = buildEmbeddingProfileIdentity({ provider: 'openai', model: 'text-embedding-3-small' }, 3072)

    expect(base.profileKey).not.toBe(otherModel.profileKey)
    expect(base.profileKey).not.toBe(otherDimensions.profileKey)
    expect(base.vectorTable).not.toBe(otherModel.vectorTable)
    expect(base.vectorTable).not.toBe(otherDimensions.vectorTable)
  })

  test('INV-3 内容变了就换一份行身份，旧索引不再复用', () => {
    const before = buildIndexTextHash('第一版正文')
    const after = buildIndexTextHash('第二版正文')

    expect(buildDocumentRevisionKey('doc-1', before)).not.toBe(buildDocumentRevisionKey('doc-1', after))
    expect(
      canReuseReadyContentIndex(
        { indexStatus: 'ready', chunkCount: 3, indexTextHash: before },
        after
      )
    ).toBe(false)
    expect(
      canReuseReadyContentIndex(
        { indexStatus: 'ready', chunkCount: 3, indexTextHash: before },
        before
      )
    ).toBe(true)
  })
})

describe('嵌入配置', () => {
  test('INV-6 每次嵌入都向宿主端口要 provider 与 model，本包不挑也不读环境变量', async () => {
    const requests: Array<{ provider: string; model: string }> = []
    let current = { provider: 'host-first', model: 'model-a' }
    const embeddings = new Embeddings(
      new EmbeddingApi({
        createEmbeddingRequest(config, model, texts) {
          requests.push({ provider: String(config.provider), model })
          return {
            url: 'injected://embedding',
            headers: {},
            execute: async () => ({ embedding: texts.map(() => 0.5) }),
          }
        },
      }),
      {
        resolveEmbeddingRuntime: () => ({
          ...current,
          apiKey: 'opaque',
          baseURL: 'injected://provider',
          configured: true,
        }),
        isManualEmbeddingAllowed: () => true,
      },
      {
        postJson: async () => {
          throw new Error('注入的请求不该走 HTTP 兜底')
        },
      }
    )

    await embeddings.embedText('第一次')
    // 宿主换了模型：下一次嵌入必须用新答案，不许沿用上一次解析到的 profile。
    current = { provider: 'host-second', model: 'model-b' }
    await embeddings.embedText('第二次')

    expect(requests).toEqual([
      { provider: 'host-first', model: 'model-a' },
      { provider: 'host-second', model: 'model-b' },
    ])
  })
})
