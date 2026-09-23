import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextRuntime } from '../dist/index.js'
import { localContextStorage } from '../dist/node.js'

test('INV-1 工作集提交、原文召回、并发 CAS 和重启恢复共用一份状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'velaros-context-'))
  const path = join(dir, 'context.sqlite')
  let storage = localContextStorage({ path })
  const second = localContextStorage({ path })
  try {
    const a = createContextRuntime({ sessionId: 'session', storage })
    const b = createContextRuntime({ sessionId: 'session', storage: second })
    const input = await a.append({ kind: 'user', body: '原始目标' })
    const result = await a.append({ kind: 'tool', body: '需要保留的原始证据' })
    const before = await a.inspect()
    const note = await a.write({
      kind: 'checkpoint',
      title: '工作记录',
      body: '工作进度',
      sources: [result.ref],
    })
    const revisions = await Promise.allSettled([
      a.replace({ baseRevision: 0, baseCursor: before.cursor, items: [note.ref] }),
      b.replace({ baseRevision: 0, baseCursor: before.cursor, items: [] }),
    ])
    assert.equal(revisions.filter((x) => x.status === 'fulfilled').length, 1)
    assert.equal(
      revisions.filter((x) => x.status === 'rejected')[0].reason.code,
      'CONTEXT_CONFLICT'
    )
    assert.equal((await a.read(result.ref)).text, '需要保留的原始证据')
    const latest = await a.append({ kind: 'user', body: '新的补充要求' })
    const projected = await a.project(1000)
    assert(projected.records.some((x) => x.record.ref.id === latest.ref.id))
    assert(projected.records.some((x) => x.record.ref.id === note.ref.id))
    assert(!projected.records.some((x) => x.record.ref.id === result.ref.id))
    assert.equal(projected.revision, 1)
    await storage.close()
    storage = localContextStorage({ path })
    const recovered = createContextRuntime({ sessionId: 'session', storage })
    assert.deepEqual(await recovered.inspect(), await b.inspect())
    assert.equal((await recovered.read(input.ref)).text, '原始目标')
    assert.equal(
      (await recovered.search({ query: '证据', limit: 1 })).items[0].ref.id,
      result.ref.id
    )
  } finally {
    await storage.close()
    await second.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('INV-2 边界、预算、来源身份和超大原文必须明确处理', async () => {
  const storage = localContextStorage({ path: ':memory:' })
  try {
    const c = createContextRuntime({ sessionId: 'a', storage })
    const record = await c.append({ kind: 'user', body: 'abcdef' })
    await assert.rejects(c.project(2), { code: 'CONTEXT_BUDGET' })
    await assert.rejects(c.read({ ...record.ref, sessionId: 'b' }), { code: 'SCOPE_MISMATCH' })
    assert.equal((await c.read(record.ref, { offset: 1, limit: 2 })).text, 'bc')
    await assert.rejects(c.read(record.ref, { offset: -1 }), { code: 'INVALID_RANGE' })
    await assert.rejects(c.replace({ baseRevision: 0, baseCursor: 9, items: [] }), {
      code: 'INVALID_RANGE',
    })
    assert.throws(() => c.write({ kind: 'user', body: '伪造用户' }), { code: 'INVALID_NOTE_KIND' })
    await assert.rejects(
      c.replace({ baseRevision: 0, baseCursor: 1, items: [{ sessionId: 'a', id: 'absent' }] }),
      { code: 'REF_NOT_FOUND' }
    )
    await c.replace({ baseRevision: 0, baseCursor: 1, items: [] })
    assert.equal((await c.project(10)).records[0].text, 'abcdef')
  } finally {
    await storage.close()
  }
})

test('Kernel 调用意图先落盘，失败保留已提交效果，跨重启不会重复派发', async () => {
  const { createOperationRuntime } = await import('@velaros-ai/kernel')
  const { createContextInvocationJournal } = await import('../dist/index.js')
  const root = await mkdtemp(join(tmpdir(), 'velaros-invocations-'))
  const path = join(root, 'state.sqlite')
  let writes = 0
  let prepared = 0
  let activated = 0
  let disposed = 0
  const definition = {
    binding: { moduleId: 'example:counter', instanceId: 'one', generation: 1, schemaRevision: '1' },
    summary: '记录一次效果',
    activate: () => {
      activated++
    },
    dispose: () => {
      disposed++
    },
    operations: {
      write: {
        summary: '写入计数器',
        effects: 'write',
        input: {
          type: 'object',
          properties: { value: { type: 'integer' } },
          required: ['value'],
          additionalProperties: false,
        },
        output: { type: 'number' },
        prepare: (input) => {
          prepared++
          return input
        },
        run: (input, context) => {
          assert.equal(Object.isFrozen(input), true)
          writes += input.value
          context.recordEffect('committed')
          return '错误形状'
        },
      },
    },
  }
  const storage = localContextStorage({ path })
  const journal = createContextInvocationJournal(storage)
  const runtime = createOperationRuntime({ modules: [definition], journal })
  try {
    assert.match(runtime.describe('example:counter').declarations, /Promise<number>/)
    assert.equal(runtime.list({ query: '计数器' }).items.length, 0)
    const binding = runtime.bind('s', 'example:counter')
    const call = {
      id: 'call-1',
      sessionId: 's',
      executionId: 'run-1',
      binding,
      operation: 'write',
      input: { value: 2 },
    }
    const outcomes = await Promise.all([runtime.invoke(call), runtime.invoke(call)])
    assert.deepEqual(outcomes[0], outcomes[1])
    assert.equal(writes, 2)
    assert.equal(prepared, 1)
    assert.equal(outcomes[0].outcome, 'failed')
    assert.equal(outcomes[0].effect, 'committed')
    assert.equal(outcomes[0].error.code, 'OUTPUT_SCHEMA')
    assert.equal(outcomes[0].value, '错误形状')
    assert.equal((await journal.read('s', 'call-1')).receipt.effect, 'committed')
    await assert.rejects(runtime.invoke({ ...call, input: { value: 7 } }), {
      code: 'IDEMPOTENCY_CONFLICT',
    })
    await assert.rejects(runtime.invoke({ ...call, id: 'bad', input: { value: '2' } }), /schema/)
    await assert.rejects(
      runtime.invoke({ ...call, id: 'proto', operation: 'toString' }),
      /未知操作/
    )
    runtime.release('s', 'example:counter')
    await assert.rejects(runtime.invoke({ ...call, id: 'released' }), /失效/)
    await runtime.dispose()
    assert.equal(activated, 1)
    assert.equal(disposed, 1)
    await storage.close()
    const reopened = localContextStorage({ path })
    const restarted = createOperationRuntime({
      modules: [definition],
      journal: createContextInvocationJournal(reopened),
    })
    try {
      restarted.bind('s', 'example:counter')
      assert.equal((await restarted.invoke(call)).effect, 'committed')
      assert.equal(writes, 2)
      assert.equal(prepared, 1)
      const reliable = createContextInvocationJournal(reopened)
      const broken = createOperationRuntime({
        modules: [definition],
        journal: {
          claim: (value) => reliable.claim(value),
          prepare: (value) => reliable.prepare(value),
          read: (session, id) => reliable.read(session, id),
          settle: async () => {
            throw new Error('存储暂时离线')
          },
        },
      })
      try {
        broken.bind('s', 'example:counter')
        await assert.rejects(broken.invoke({ ...call, id: 'uncertain' }), /存储暂时离线/)
        assert.equal(writes, 4)
      } finally {
        await broken.dispose()
      }
      await assert.rejects(restarted.invoke({ ...call, id: 'uncertain' }), /不能自动重放/)
      assert.equal(writes, 4)
    } finally {
      await restarted.dispose()
      await reopened.close()
    }
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
