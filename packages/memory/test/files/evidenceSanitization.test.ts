/**
 * INV-2（不变量候选，方案 6.4）：**任何后端落盘前经同一道清洗：秘密打码、正文与标题截断、
 * 空内容拒收。**
 *
 * 回归的形状是明文落盘：文件后端是出厂默认的权威层，从前只有树档调清洗，于是用户在聊天里贴的
 * `sk-…`、`Bearer …`、私钥块原样写进 `<仓库>/.velaros/memory/entries/*.md`——那个目录按设计
 * 跟着 git 走，一次 push 就是一次泄漏。frontmatter 里的摘要、来源、标签同样来自聊天正文，
 * 因此一并打码。
 */

import { describe, expect, test } from 'bun:test'

import { InMemoryMemoryFilesIo } from '../../src/impl/files/InMemoryMemoryFilesIo'
import { createMemoryFilesBackend, type MemoryFilesScopeRoot } from '../../src/impl/files/MemoryFilesBackend'
import type { MemoryEvidenceInput } from '../../src/types/memory'
import { parseMemoryFileDocument } from '../../src/utils/files/frontmatter'

const ProjectRoot: MemoryFilesScopeRoot = {
  scopeType: 'workspace',
  scopeId: 'project:/repo',
  directory: '/repo/.velaros/memory',
}

// 运行时拼出来，避免仓库里出现整串像真密钥的字面量（check:public-readiness 会按形状拦）。
const ApiKey = `sk-${'abcdefghijklmnopqrstuvwx'}1234`

function createBackend() {
  const io = new InMemoryMemoryFilesIo()
  return { io, backend: createMemoryFilesBackend({ roots: [ProjectRoot], io, now: () => 1_700_000_000_000 }) }
}

function evidence(overrides: Partial<MemoryEvidenceInput> = {}): MemoryEvidenceInput {
  return {
    sourceType: 'chat_message',
    trustLevel: 'user_stated',
    scopeId: 'project:/repo',
    scopeType: 'workspace',
    content: '默认正文。',
    ...overrides,
  }
}

function onlyEntry(io: InMemoryMemoryFilesIoApi): string {
  const snapshot = io.snapshot()
  const path = Object.keys(snapshot).find((candidate) => candidate.includes('/entries/'))
  expect(path).toBeTruthy()
  return snapshot[path as string]
}

describe('文件后端落盘前清洗', () => {
  test('正文里的 API key 打码后才落盘', async () => {
    const { io, backend } = createBackend()
    await backend.capture(evidence({ sourceId: 'k1', title: '部署', content: `我的 key 是 ${ApiKey} 别外传` }))
    const raw = onlyEntry(io)
    expect(raw).not.toContain(ApiKey)
    expect(raw).toContain('[REDACTED_API_KEY]')
  })

  test('私钥块与 Bearer token 同样打码', async () => {
    const { io, backend } = createBackend()
    await backend.capture(
      evidence({
        sourceId: 'k2',
        title: '凭据',
        content:
          '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAfake\n-----END OPENSSH PRIVATE KEY-----\n'
          + 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n',
      }),
    )
    const raw = onlyEntry(io)
    expect(raw).toContain('[REDACTED_PRIVATE_KEY]')
    expect(raw).toContain('Bearer [REDACTED_TOKEN]')
    expect(raw).not.toContain('AAAAfake')
  })

  test('frontmatter 的摘要、来源、标签也清洗', async () => {
    const { io, backend } = createBackend()
    await backend.capture(
      evidence({
        sourceId: 'k3',
        title: `标题里的 ${ApiKey}`,
        content: '正文。',
        metadata: { summary: `摘要里的 ${ApiKey}`, source: `来源 ${ApiKey}`, tags: [`tag-${ApiKey}`] },
      }),
    )
    const document = parseMemoryFileDocument(onlyEntry(io))
    expect(document.name).not.toContain(ApiKey)
    expect(document.description).not.toContain(ApiKey)
    expect(document.attributes.source).not.toContain(ApiKey)
    expect(document.attributes.tags).not.toContain(ApiKey)
    expect(onlyEntry(io)).not.toContain(ApiKey)
  })

  test('正文超长截断到 24 000 字', async () => {
    const { io, backend } = createBackend()
    await backend.capture(evidence({ sourceId: 'k4', title: '长文', content: 'あ'.repeat(30_000) }))
    expect(parseMemoryFileDocument(onlyEntry(io)).body.length).toBe(24_000)
  })

  test('空内容拒收（不写出一个没有内容的条目）', () => {
    const { io, backend } = createBackend()
    expect(() => backend.capture(evidence({ sourceId: 'k5', title: '空', content: '   ' }))).toThrow(
      /内容不能为空/u,
    )
    expect(Object.keys(io.snapshot())).toEqual([])
  })
})
