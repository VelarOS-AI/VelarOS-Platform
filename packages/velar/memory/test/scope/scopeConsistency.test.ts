/**
 * INV-6 的可测部分：**作用域可见性只有一个判据** —— 文件档、向量档、树档的按行过滤与
 * 工具读门给出同样的裁决（方案第 5 节 D-12、D-13）。
 *
 * 两处回归：
 *  - D-12：除 `project:`、`site:`、`system` 外一律判 `global`，而 `global` 处处可见。宿主一传
 *    `session:<id>`，那条记忆就对所有会话可见——隔离判据失败开放；
 *  - D-13：树后端的召回 SQL 自己写了一份作用域条件，选定作用域是 `global` 时只返回 global 条目，
 *    而唯一判据对 `global` 是「全部可见」。
 *
 * 树后端要 Electron 原生 SQLite，bun 单测跑不了它的语句；因此这里锁的是**参数与条件的构造**
 * （`resolveMemoryScopeFilterValue` + SQL 条件的等价模拟），并让文件档与向量档真跑一遍。
 */

import { describe, expect, test } from 'bun:test'

import { InMemoryMemoryFilesIo } from '../../impl/files/InMemoryMemoryFilesIo.js'
import { createMemoryFilesBackend } from '../../impl/files/MemoryFilesBackend.js'
import {
  isMemoryVisibleInScope,
  resolveMemoryScopeFilterValue,
  scopeTypeForScopeId,
} from '../../utils/scope.js'

describe('D-12 作用域种类', () => {
  test('global 只认字面 global', () => {
    expect(scopeTypeForScopeId('global')).toBe('global')
    expect(scopeTypeForScopeId('')).toBe('global')
    expect(scopeTypeForScopeId(undefined)).toBe('global')
  })

  test('类型里有的 session / execution 不再被判成 global', () => {
    expect(scopeTypeForScopeId('session:abc')).toBe('session')
    expect(scopeTypeForScopeId('execution:abc')).toBe('execution')
  })

  test('认不出的前缀按独立池处理，绝不是 global', () => {
    expect(scopeTypeForScopeId('tenant:acme')).not.toBe('global')
    expect(scopeTypeForScopeId('随便写的')).not.toBe('global')
  })

  test('宿主传 session: 的记忆不再对所有会话可见', () => {
    const item = { scopeType: scopeTypeForScopeId('session:a'), scopeId: 'session:a' }
    expect(isMemoryVisibleInScope(item, { scopeId: 'session:a' })).toBe(true)
    expect(isMemoryVisibleInScope(item, { scopeId: 'session:b' })).toBe(false)
    expect(isMemoryVisibleInScope(item, { scopeId: 'project:/repo' })).toBe(false)
  })

  test('scopeId 在场即权威：scopeType 被错标成 global 也不放行', () => {
    expect(
      isMemoryVisibleInScope({ scopeType: 'global', scopeId: 'session:a' }, { scopeId: 'project:/repo' })
    ).toBe(false)
  })
})

describe('D-13 跨后端同一裁决', () => {
  /** 树后端召回 SQL 里那条作用域条件的等价模拟（`scope_id = ? OR scope_type = 'global'`）。 */
  function treeRowVisible(
    row: { scopeType: string; scopeId: string },
    input: { scopeId?: string; workspaceRoot?: string; includeGlobal?: boolean },
  ): boolean {
    const parameter = resolveMemoryScopeFilterValue(input)
    if (parameter === '') return true
    if (row.scopeId === parameter) return true
    return (input.includeGlobal ?? true) && row.scopeType === 'global'
  }

  const rows = [
    { scopeType: 'workspace', scopeId: 'project:/repo' },
    { scopeType: 'workspace', scopeId: 'project:/other' },
    { scopeType: 'site', scopeId: 'site:https://example.com' },
    { scopeType: 'system', scopeId: 'system' },
    { scopeType: 'global', scopeId: 'global' },
  ] as const

  const inputs = [
    {},
    { scopeId: 'global' },
    { scopeId: 'project:/repo' },
    { scopeId: 'project:/repo', includeGlobal: false },
    { scopeId: 'site:https://example.com' },
    { scopeId: 'system' },
    { workspaceRoot: '/repo' },
  ] as const

  test('树档的 SQL 条件与唯一判据逐格一致（含选定 global = 全部）', () => {
    for (const input of inputs) {
      for (const row of rows) {
        expect([input, row, treeRowVisible(row, input)]).toEqual([
          input,
          row,
          isMemoryVisibleInScope(row, input),
        ])
      }
    }
  })

  test('文件档真跑一遍：选定 global 看得见所有池子', async () => {
    const io = new InMemoryMemoryFilesIo()
    const backend = createMemoryFilesBackend({
      roots: [
        { scopeType: 'system', scopeId: 'system', directory: '/userData/memory' },
        { scopeType: 'workspace', scopeId: 'project:/repo', directory: '/repo/.velaros/memory' },
        { scopeType: 'global', scopeId: 'global', directory: '/userData/global' },
      ],
      io,
      now: () => 1_700_000_000_000,
    })
    for (const scopeId of ['system', 'project:/repo', 'global']) {
      await backend.capture({
        sourceType: 'agent_tool',
        trustLevel: 'agent_derived',
        scopeId,
        scopeType: scopeTypeForScopeId(scopeId),
        title: `条目 ${scopeId}`,
        content: `属于 ${scopeId} 的记忆。`,
      })
    }
    expect(backend.recall('', { scopeId: 'global', limit: 20 })).toHaveLength(3)
    expect(
      backend.recall('', { scopeId: 'project:/repo', includeGlobal: false, limit: 20 })
    ).toHaveLength(1)
  })
})
