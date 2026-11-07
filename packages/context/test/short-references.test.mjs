import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextReference, createContextRuntime } from '../dist/index.js'
import { localContextStorage } from '../dist/node.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'context-short-refs-'))
  const connections = []
  // Node 按登记顺序执行 after；Windows 要先关闭全部 SQLite 连接再删目录。
  t.after(async () => {
    for (const storage of connections) await storage.close()
    await rm(root, { recursive: true, force: true })
  })
  return () => {
    const storage = localContextStorage({ path: join(root, 'context.sqlite') })
    connections.push(storage)
    return storage
  }
}

test('短引用跨连接唯一，碰撞重试与墓碑经过重启仍生效', async (t) => {
  const open = await fixture(t)
  const first = open()
  const second = open()
  const ids = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      createContextReference(index % 2 ? first : second, 'paired')
    )
  )
  assert.equal(new Set(ids.map((ref) => ref.id)).size, ids.length)
  for (const ref of ids) assert.match(ref.id, /^[a-f0-9]{8}$/)
  await first.close()
  await second.close()
  const reopened = open()
  const collision = ids[0].id
  const mock = t.mock.method(crypto, 'randomUUID', () => `${collision}-0000-4000-8000-000000000000`)
  await assert.rejects(createContextReference(reopened, 'paired'), { code: 'CONFLICT' })
  assert.equal(mock.mock.callCount(), 64)
  mock.mock.restore()
  const next = await createContextReference(reopened, 'paired')
  assert.ok(!ids.some((ref) => ref.id === next.id))
})

test('当前上下文原文精确召回，跨会话拒绝，签发不改变上下文 CAS 版本', async (t) => {
  const open = await fixture(t)
  const storage = open()
  const context = createContextRuntime({ storage, sessionId: 's' })
  const input = await context.ingest({ text: 'original goal' })
  assert.match(input.ref.id, /^[a-f0-9]{8}$/)
  const before = await storage.load('s')
  await createContextReference(storage, 's')
  assert.equal((await storage.load('s')).version, before.version)
  assert.equal((await context.read(input.ref)).text, 'original goal')
  await assert.rejects(context.read({ ...input.ref, sessionId: 'other' }), {
    code: 'SCOPE_MISMATCH',
  })
})

test('共享空间与消息短身份跨重启防碰撞，调用幂等保持原身份', async (t) => {
  const open = await fixture(t)
  const first = open()
  const creation = { scope: 'shared', owner: 'owner', operationId: 'create-one', name: 'one' }
  const store = await first.stores.create(creation)
  assert.match(store.id, /^[a-f0-9]{8}$/)
  assert.equal((await first.stores.create(creation)).id, store.id)
  const event = await first.stores.publish({
    store: store.id,
    operationId: 'event-one',
    topic: 'work',
    value: 'original',
    actor: 'owner',
  })
  assert.match(event.id, /^[a-f0-9]{8}$/)
  await first.close()
  const reopened = open()
  const mock = t.mock.method(crypto, 'randomUUID', () => `${store.id}-0000-4000-8000-000000000000`)
  await assert.rejects(reopened.stores.create({ ...creation, operationId: 'create-two' }), {
    code: 'CONFLICT',
  })
  mock.mock.restore()
  const eventMock = t.mock.method(
    crypto,
    'randomUUID',
    () => `${event.id}-0000-4000-8000-000000000000`
  )
  await assert.rejects(
    reopened.stores.publish({
      store: store.id,
      operationId: 'event-two',
      topic: 'work',
      value: 'next',
      actor: 'owner',
    }),
    { code: 'CONFLICT' }
  )
  eventMock.mock.restore()
  assert.equal(
    (
      await reopened.stores.publish({
        store: store.id,
        operationId: 'event-one',
        topic: 'work',
        value: 'original',
        actor: 'owner',
      })
    ).id,
    event.id
  )
})
