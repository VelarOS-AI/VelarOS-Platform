/**
 * 三个操作的实现细节：交给端口的检索请求长什么样、索引问题怎么合并、取消的调用不碰端口。
 * 对外承诺在 spec/acceptance.test.ts；这里钉的是承诺之下的具体写法。
 */
import { describe, expect, test } from 'bun:test'

import { knowledgeOperations } from '../index'
import { failureOf, knowledgeDesk, record, WorkspaceRoot } from '../spec/support'

describe('检索请求', () => {
  test('来源类型、提示、文档 id 与 limit 原样交给端口，没给的不出现', async () => {
    const desk = knowledgeDesk({ pages: [[record('doc-1')]] })
    await desk.call('search', { query: 'token', sourceKinds: ['code', 'markdown'], pathHints: ['src/auth'], symbolHints: ['refreshToken'], documentIds: ['doc-1'], limit: 3 })
    expect(desk.searches).toEqual([{
      query: 'token',
      options: { workspaceRoot: WorkspaceRoot, limit: 3, sourceKinds: ['code', 'markdown'], pathHints: ['src/auth'], symbolHints: ['refreshToken'], documentIds: ['doc-1'] },
    }])
  })

  test('sync 的 force 原样交给端口，结果只带同步的计数', async () => {
    const desk = knowledgeDesk()
    const result = await desk.call('sync', { force: true })
    expect(desk.syncs).toEqual([{ workspaceRoot: WorkspaceRoot, options: { force: true } }])
    expect(Object.keys(result).sort()).toEqual(['forced', 'reindexBlocked', 'reindexed', 'removed', 'scanned', 'skipped', 'upserted', 'workspaceRoot'])
  })
})

describe('索引问题', () => {
  test('同一类错误合并成一条，计数与受影响的文档都记全；没有错误的命中不出现 indexError', async () => {
    const desk = knowledgeDesk({
      pages: [[
        record('doc-1', { indexError: 'Authorization header missing' }),
        record('doc-2', { indexError: 'api_key rejected' }),
        record('doc-3', { indexError: 'chunk failed: disk full' }),
        record('doc-4'),
      ]],
    })
    const found = await desk.call('search', { query: 'x' })
    expect(found.indexIssues).toEqual([
      expect.objectContaining({ kind: 'embedding-auth', count: 2, sample: 'Authorization header missing', affectedDocumentIds: ['doc-1', 'doc-2'] }),
      expect.objectContaining({ kind: 'index-error', count: 1, actionable: false, affectedDocumentIds: ['doc-3'] }),
    ])
    expect('indexError' in found.results[3]).toBe(false)
  })
})

describe('取消', () => {
  test('已经取消的调用不碰端口', async () => {
    const desk = knowledgeDesk({ pages: [[record('doc-1')]] })
    const controller = new AbortController()
    controller.abort()
    const context = { ...desk.context, abortSignal: controller.signal }
    await failureOf(knowledgeOperations.search({ query: 'x' }, context))
    await failureOf(knowledgeOperations.sync({}, context))
    await failureOf(knowledgeOperations.diagnostics(context))
    expect(desk.resolved).toEqual([])
    expect(desk.searches).toEqual([])
    expect(desk.diagnosticsCalls()).toBe(0)
  })
})
