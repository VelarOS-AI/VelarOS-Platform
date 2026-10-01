/**
 * @test-meta
 * title: Memory package consumer API
 * summary: 经构建产物的 `./memory` 入口验证记忆库：类不出单元，只有记忆库的工厂与三个操作的实例，照着就能读写一个作用域。
 * area: package
 */
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { test } from 'bun:test'

import {
  createMemoryStore,
  MemoryLimits,
  memoryOperations,
  MemoryTypes,
  VelarMemoryModule,
} from '../../dist/memory/index.js'

test('package root exposes the store factory and the three operations', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'velaros-memory-consumer-')))
  assert.ok(basename(root).startsWith('velaros-memory-consumer-'))
  try {
    const scope = createMemoryStore({ root }).scope('project:/srv/consumer')
    const context = { abortSignal: new AbortController().signal, memory: scope }
    const saved = await memoryOperations.save(
      {
        id: 'consumer',
        type: 'reference',
        title: '构建产物',
        description: '入口照样能用',
        content: '',
      },
      context
    )
    assert.equal(saved.id, 'consumer')
    assert.equal(saved.created, true)
    assert.match(saved.revision, /^[a-f0-9]{64}$/)
    const [existing] = await memoryOperations.list(context)
    assert.equal(existing.revision, saved.revision)
    const updated = await memoryOperations.save(
      { ...existing, content: 'updated', expectedRevision: saved.revision },
      context
    )
    assert.equal(updated.created, false)
    assert.match(updated.revision, /^[a-f0-9]{64}$/)
    assert.notEqual(updated.revision, saved.revision)
    await assert.rejects(
      memoryOperations.save(
        { ...existing, content: 'stale', expectedRevision: saved.revision },
        context
      ),
      { code: 'CONFLICT' }
    )
    assert.equal((await memoryOperations.list(context))[0].content, 'updated')
    assert.deepEqual(
      (await memoryOperations.list(context)).map((entry) => entry.id),
      ['consumer']
    )
    assert.match(await scope.renderIndex(), /\[构建产物\]\(consumer\)/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  assert.deepEqual([...VelarMemoryModule.methods].sort(), ['list', 'remove', 'save'])
  assert.deepEqual([...MemoryTypes], ['user', 'feedback', 'work', 'reference'])
  assert.equal(MemoryLimits.idChars, 64)
})
