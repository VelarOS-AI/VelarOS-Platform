/**
 * D-9：**frontmatter 的引号往返保真**。
 *
 * 回归的形状是标题越写越长：按 YAML 把单引号写成 `''` 而读回时不还原，于是标题 `#tag it's`
 * 读回来是 `#tag it''s`，每重写一次（归档、再采集）撇号再翻一倍；首尾是双引号的值裸着写出去，
 * 读回来被当成引号包裹剥掉一层。
 */

import { describe, expect, test } from 'bun:test'

import { createInMemoryMemoryFilesIo } from '../../src/impl/files/InMemoryMemoryFilesIo'
import { createMemoryFilesBackend, type MemoryFilesScopeRoot } from '../../src/impl/files/MemoryFilesBackend'
import { parseMemoryFileDocument, serializeMemoryFileDocument } from '../../src/utils/files/frontmatter'

const Root: MemoryFilesScopeRoot = {
  scopeType: 'global',
  scopeId: 'global',
  directory: '/userData/memory',
}

function roundTrip(name: string): string {
  return parseMemoryFileDocument(
    serializeMemoryFileDocument({ name, description: '描述', type: 'fact', body: '正文' }),
    'fallback',
  ).name
}

describe('引号往返', () => {
  for (const name of [
    "#tag it's",
    "it's",
    "''",
    '"重要"',
    "'单引号包着的'",
    '# 以井号开头',
    '带 : 冒号 的名字',
  ]) {
    test(`保真：${name}`, () => {
      expect(roundTrip(name)).toBe(name)
    })
  }

  test('写两遍也不会越写越长', () => {
    const once = serializeMemoryFileDocument({
      name: "#tag it's",
      description: '描述',
      type: 'fact',
      body: '正文',
    })
    const parsed = parseMemoryFileDocument(once, 'fallback')
    const twice = serializeMemoryFileDocument({
      name: parsed.name,
      description: parsed.description,
      type: parsed.type,
      body: parsed.body,
    })
    expect(twice).toBe(once)
  })
})

describe('经后端归档一轮之后标题不变', () => {
  test('归档会重写文件，撇号不该翻倍', async () => {
    const io = createInMemoryMemoryFilesIo()
    const backend = createMemoryFilesBackend({ roots: [Root], io, now: () => 1_700_000_000_000 })
    const captured = backend.capture({
      sourceType: 'agent_tool',
      trustLevel: 'agent_derived',
      scopeId: 'global',
      title: "#tag it's",
      content: '正文。',
    })
    await backend.archive?.(captured.evidence.id)
    expect(backend.getItem(captured.evidence.id)?.title).toBe("#tag it's")
  })
})
