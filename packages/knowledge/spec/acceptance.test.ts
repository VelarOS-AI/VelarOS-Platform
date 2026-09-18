/**
 * 工作区知识库的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，只经根入口；实现细节的测试在 test/ 目录。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

// INV-3、INV-4、INV-6 盯的是嵌入 profile、工作区摄入与嵌入配置解析这三段包内行为，
// 0.6.0 之后它们不再出包（要它们的能力走 createKnowledgeRuntime），所以这里按相对路径直接引实现。
import { KnowledgeWorkspace } from '../src/impl/domain/KnowledgeWorkspace'
import { KnowledgeEmbeddingClient as EmbeddingApi } from '../src/impl/storage/KnowledgeEmbeddingClient'
import { KnowledgeEmbeddings as Embeddings } from '../src/impl/storage/KnowledgeEmbeddings'
import {
  buildDocumentRevisionKey,
  buildEmbeddingProfileIdentity,
  buildIndexTextHash,
  canReuseReadyContentIndex,
} from '../src/utils/indexing'

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
