/**
 * 知识检索的不变量验收：`spec/invariants.md` 里每一条「测试」档的检验器。
 * 用例名以 INV-<编号> 开头，`check:module-ownership` 按这个前缀核对登记表与实现对得上。
 * 操作一律经代码面的能力端口调（和模型的程序是同一条路），断言程序看得到的 code、message 与返回值。
 */
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

// INV-3、INV-4、INV-6 盯的是嵌入 profile、工作区摄入与嵌入配置解析这三段单元内的行为，
// 它们不出单元（要它们的能力走 createKnowledgeRuntime），所以这里按相对路径直接引实现。
import { KnowledgeWorkspace } from '../impl/domain/KnowledgeWorkspace'
import { KnowledgeEmbeddingClient as EmbeddingApi } from '../impl/storage/KnowledgeEmbeddingClient'
import { KnowledgeEmbeddings as Embeddings } from '../impl/storage/KnowledgeEmbeddings'
import { KnowledgeSearchLimits, KnowledgeSourceKinds, VelarKnowledgeModule } from '../index'
import {
  buildDocumentRevisionKey,
  buildEmbeddingProfileIdentity,
  buildIndexTextHash,
  canReuseReadyContentIndex,
} from '../utils/indexing'

import { checkModelProgram, Diagnostics, failureOf, KnowledgeDeclarations, knowledgeDesk, record, runModelProgram, synced, WorkspaceRoot } from './support'

describe('检索', () => {
  test('INV-1 有命中就不写：检索不触发同步，也不多搜一次', async () => {
    const desk = knowledgeDesk({ pages: [[record('doc-1')]] })
    const found = await desk.call('search', { query: '认证流程' })
    expect(found.count).toBe(1)
    expect('autoSync' in found).toBe(false)
    expect(desk.searches).toHaveLength(1)
    expect(desk.syncs).toEqual([])
  })

  test('INV-1 零命中时只补一次增量同步：补进了内容才重搜，并如实说明；什么都没补进就不重搜', async () => {
    const filled = knowledgeDesk({ pages: [[], [record('doc-1')]], sync: async () => synced({ scanned: 12, upserted: 12 }) })
    const found = await filled.call('search', { query: '认证流程' })
    expect(filled.syncs).toHaveLength(1)
    expect(filled.searches).toHaveLength(2)
    expect(found.count).toBe(1)
    expect(found.autoSync).toEqual({ scanned: 12, indexed: 12 })

    const empty = knowledgeDesk({ pages: [[], []] })
    const nothing = await empty.call('search', { query: '认证流程' })
    expect(empty.syncs).toHaveLength(1)
    expect(empty.searches).toHaveLength(1)
    expect(nothing.count).toBe(0)
    expect(nothing.autoSync).toEqual({ scanned: 0, indexed: 0 })
  })

  test('INV-1 补的那次同步失败不改写检索的成败：检索照常交回，只是没有 autoSync', async () => {
    const desk = knowledgeDesk({ pages: [[]], sync: async () => { throw new Error('embedding provider unavailable') } })
    const found = await desk.call('search', { query: '认证流程' })
    expect(found.count).toBe(0)
    expect('autoSync' in found).toBe(false)
  })

  test('INV-2 工作区只认调用方给的或空间自己的：两样都没有就报错，不猜一个根', async () => {
    const homeless = knowledgeDesk({ defaultWorkspace: null })
    const failure = await failureOf(homeless.call('search', { query: '认证流程' }))
    expect(failure.code).toBe('VALIDATION')
    expect(failure.message).toContain('workspaceRoot')
    expect(homeless.searches).toEqual([])

    // 给了就按给的；检索、零命中补的那次同步都落在同一个根上。
    const desk = knowledgeDesk({ pages: [[], []] })
    const found = await desk.call('search', { query: '认证流程', workspaceRoot: '/other' })
    expect(desk.resolved).toEqual(['/other'])
    expect(found.workspaceRoot).toBe('/other')
    expect(desk.searches.map((search) => search.options.workspaceRoot)).toEqual(['/other'])
    expect(desk.syncs.map((sync) => sync.workspaceRoot)).toEqual(['/other'])
    // 没给就用空间自己的。
    const own = knowledgeDesk({ pages: [[record('doc-1')]] })
    expect((await own.call('search', { query: '认证流程' })).workspaceRoot).toBe(WorkspaceRoot)
    expect(own.resolved).toEqual([undefined])
  })

  test('INV-7 诊断只读：不同步、不检索', async () => {
    const desk = knowledgeDesk()
    const health = await desk.call('diagnostics')
    expect(desk.diagnosticsCalls()).toBe(1)
    expect(desk.syncs).toEqual([])
    expect(desk.searches).toEqual([])
    expect(health.totalDocuments).toBe(Diagnostics.totalDocuments)
  })
})

describe('入参与结果', () => {
  test('INV-8 入参在做事之前核对：不合法当场 VALIDATION，端口一次都不调', async () => {
    const desk = knowledgeDesk()
    for (const input of [
      {},
      { query: '   ' },
      { query: 'x', sourceKinds: ['pdf'] },
      { query: 'x', pathHints: Array.from({ length: KnowledgeSearchLimits.pathHints + 1 }, (_, index) => `p${index}`) },
      { query: 'x', symbolHints: [''] },
      { query: 'x', documentIds: Array.from({ length: KnowledgeSearchLimits.documentIds + 1 }, (_, index) => `d${index}`) },
      { query: 'x', limit: 0 },
      { query: 'x', limit: KnowledgeSearchLimits.results + 1 },
      { query: 'x', limit: 2.5 },
      { query: 'x', workspaceRoot: '' },
    ]) {
      expect((await failureOf(desk.call('search', input))).code, JSON.stringify(input).slice(0, 80)).toBe('VALIDATION')
    }
    expect((await failureOf(desk.call('sync', { force: 'yes' }))).code).toBe('VALIDATION')
    expect(desk.resolved).toEqual([])
    expect(desk.searches).toEqual([])
    expect(desk.syncs).toEqual([])
    // 没给 limit 就用缺省；sync 可以不给入参。
    const plain = knowledgeDesk({ pages: [[record('doc-1')]] })
    await plain.call('search', { query: ' 认证流程 ' })
    expect(plain.searches).toEqual([{ query: '认证流程', options: { workspaceRoot: WorkspaceRoot, limit: KnowledgeSearchLimits.defaultResults } }])
    expect(await plain.call('sync')).toMatchObject({ workspaceRoot: WorkspaceRoot, forced: false })
  })

  test('INV-9 交给模型的只有声明里的字段：引擎的行身份、索引哈希、嵌入模型、向量库路径都不往外带', async () => {
    const desk = knowledgeDesk({ pages: [[record('doc-1'), record('doc-2', { indexError: '401 Unauthorized: invalid_issuer' })]] })
    const found = await desk.call('search', { query: '认证流程' })
    expect(Object.keys(found.results[0]).sort()).toEqual(['content', 'id', 'indexStatus', 'matchType', 'path', 'score', 'snippet', 'sourceKind', 'summary', 'tags', 'title', 'updatedAt'])
    expect(found.results[1].indexError).toBe('401 Unauthorized: invalid_issuer')
    expect(found.indexIssues).toEqual([expect.objectContaining({ kind: 'embedding-auth-invalid-issuer', count: 1, actionable: true, affectedDocumentIds: ['doc-2'] })])
    const health = await desk.call('diagnostics')
    expect(JSON.stringify(health)).not.toContain(Diagnostics.vectorStore.path)
    expect(JSON.stringify(health)).not.toContain(Diagnostics.runtime.indexRuntimeKey)
    expect(health).toMatchObject({ trackedFiles: 30, vectorRows: 36, embedding: { provider: 'openai', model: 'text-embedding-3-small' } })
  })
})

describe('模型面', () => {
  test('INV-11 声明从源码生成、只放出三个操作；随包发布的与生成物同一份；模型写的程序照声明调到真实操作', async () => {
    expect(VelarKnowledgeModule.specifier).toBe('velar:knowledge')
    expect(VelarKnowledgeModule.declarations).toBe(KnowledgeDeclarations)
    expect([...VelarKnowledgeModule.methods].sort()).toEqual(['diagnostics', 'search', 'sync'])
    expect([...VelarKnowledgeModule.methods].sort()).toEqual([...(knowledgeDesk().capabilities.listOperations().knowledge ?? [])].sort())
    // 空间端口与调用上下文不进模型面。
    expect(KnowledgeDeclarations).not.toContain('KnowledgeSpacePort')
    expect(KnowledgeDeclarations).not.toContain('KnowledgeOperationContext')
    expect(KnowledgeDeclarations).not.toContain('KnowledgeSearchResult')
    const desk = knowledgeDesk({ pages: [[record('doc-1')]] })
    const result = await runModelProgram(desk, `import { search, sync } from 'velar:knowledge'
const found = await search({ query: '认证流程', limit: 3 })
export const paths = found.results.map((hit) => hit.path)
export const synced = await sync({ force: true })`)
    expect(result.failed).toBeUndefined()
    expect(result.value).toMatchObject({ paths: ['docs/doc-1.md'], synced: { workspaceRoot: WorkspaceRoot, forced: true } })
  }, 60_000)

  test('INV-12 声明里写给模型的数字与取值就是常量表里的', () => {
    for (const phrase of [
      `默认 ${KnowledgeSearchLimits.defaultResults}，最多 ${KnowledgeSearchLimits.results}`,
      `各最多 ${KnowledgeSearchLimits.pathHints} 条`,
      `最多 ${KnowledgeSearchLimits.documentIds} 个`,
    ]) expect(KnowledgeDeclarations, phrase).toContain(phrase)
    expect(KnowledgeSearchLimits.symbolHints).toBe(KnowledgeSearchLimits.pathHints)
    expect(KnowledgeDeclarations).toContain(`type KnowledgeSourceKind = ${KnowledgeSourceKinds.map((kind) => `'${kind}'`).join(' | ')}`)
  })

  test('INV-13 代码模版整份照生成的声明过类型检查，import 只写一次；它不嵌进声明，随模型面发布的就是这份文件', () => {
    const template = readFileSync(resolve(import.meta.dir, '../template.js'), 'utf8')
    expect(checkModelProgram(template)).toEqual([])
    expect(template.match(/^import /gmu)).toHaveLength(1)
    expect(VelarKnowledgeModule.template).toBe(template.trim())
    expect(KnowledgeDeclarations).not.toContain('的代码模版')
  })
})

describe('工作区摄入', () => {
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
  test('INV-6 每次嵌入都向宿主端口要 provider 与 model，本单元不挑也不读环境变量', async () => {
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
