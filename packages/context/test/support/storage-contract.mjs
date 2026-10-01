import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createContextRuntime } from '../../dist/index.js'

const empty = () => ({ version: 0, records: [], workingSet: { revision: 0, cursor: 0, items: [] } })

// 测试替身只验证端口可替换，不提供生产持久性；重开连接共享测试拥有的内存。
export function volatileStorageBackend() {
  const states = new Map()
  const objects = new Map()
  let next = 0
  let closes = 0
  return {
    get closes() {
      return closes
    },
    async open() {
      let closed = false
      const ready = async () => {
        await Promise.resolve()
        if (closed) throw Object.assign(Error('closed'), { code: 'STORAGE_CLOSED' })
      }
      return {
        async load(id) {
          await ready()
          return structuredClone(states.get(id) ?? null)
        },
        async compareAndSwap(id, version, state) {
          await ready()
          if (state.version !== version + 1)
            throw Object.assign(Error('version'), { code: 'INVALID_VERSION' })
          if ((states.get(id)?.version ?? 0) !== version) return false
          if (
            state.records.some(
              (record) => record.objectId && !objects.get(id)?.has(record.objectId)
            )
          )
            throw Object.assign(Error('missing body'), { code: 'OBJECT_MISSING' })
          states.set(id, structuredClone(state))
          return true
        },
        async put(id, text) {
          await ready()
          const key = `opaque-object:${++next}`
          if (!objects.has(id)) objects.set(id, new Map())
          objects.get(id).set(key, text)
          return key
        },
        async get(id, key) {
          await ready()
          return objects.get(id)?.get(key) ?? null
        },
        async close() {
          if (!closed) {
            closed = true
            closes++
          }
        },
      }
    },
  }
}

// 新适配器传入相同数据库的独立连接工厂，复用这些与 SQL 无关的验收。
export function storageContract(name, fixture) {
  test(`${name}: grouped snapshots return filtered title heads, literal suffixes and bounded tails`, async (t) => {
    const { open } = await fixture(t)
    const storage = await open()
    t.after(() => storage.close())
    if (!storage.selectSnapshot) {
      t.skip('optional selected snapshot')
      return
    }
    const context = createContextRuntime({ sessionId: 's', storage })
    const records = []
    for (const [title, kind] of [
      ['note:a', 'note'],
      ['note:b', 'note'],
      ['note:a', 'note'],
      ['note:a', 'event'],
      ['literal:_百分%', 'note'],
      ['literal:X百分Y', 'note'],
    ])
      records.push(await context.append({ kind, title, body: `v${records.length}` }))
    const select = async (selections) => (await storage.selectSnapshot('s', selections)).records
    assert.deepEqual(await select([{ after: 1, through: 4, first: 2 }]), records.slice(1, 3))
    assert.deepEqual(
      await select([{ after: 1, through: 4, kind: 'note', latestPerTitle: true }]),
      records.slice(1, 3)
    )
    assert.deepEqual(await select([{ after: 4, through: 2 }]), [])
    assert.deepEqual(await select([{ titlePrefix: 'note:', kind: 'note', latestPerTitle: true }]), [
      records[1],
      records[2],
    ])
    assert.deepEqual(await select([{ titlePrefix: 'note:', latestPerTitle: true }]), [
      records[1],
      records[3],
    ])
    assert.deepEqual(await select([{ titleSuffix: '_百分%' }]), [records[4]])
    assert.deepEqual(await select([{ titlePrefix: 'literal:', titleSuffix: '' }]), records.slice(4))
    assert.deepEqual(await select([{ kind: 'note', last: 2 }]), records.slice(4))
    assert.deepEqual(
      await select([{ sequence: records[0].sequence }, { title: 'note:a', latestPerTitle: true }]),
      [records[0], records[3]]
    )
    assert.deepEqual(await select([{ sequence: 999 }]), [])
    for (const input of [
      { sequence: 0 },
      { after: -1 },
      { through: 1.5 },
      { first: 0 },
      { first: 999999 },
      { first: 1, latest: true },
      { first: 1, last: 1 },
      { first: 1, latestPerTitle: true },
      { sequence: 1.5 },
      { last: 0 },
      { last: 1.5 },
      { last: 999999 },
      { last: 2, latest: true },
      { latestPerTitle: true, latest: true },
      { latestPerTitle: true, last: 2 },
    ])
      await assert.rejects(select([input]), { code: 'INVALID_RANGE' })
    assert.deepEqual((await storage.load('s')).records, records)
    const nul = await context.append({
      kind: 'note',
      title: 'literal:\u0000尾',
      body: 'nul suffix',
    })
    await context.append({ kind: 'note', title: 'literal:\u0000别', body: 'different suffix' })
    assert.deepEqual(await select([{ titleSuffix: '\u0000尾' }]), [nul])
    assert.deepEqual(await select([{ titlePrefix: 'literal:\u0000尾' }]), [nul])
  })
  test(`${name}: selected snapshots filter, deduplicate and detach records at one version`, async (t) => {
    const { open } = await fixture(t)
    const storage = await open()
    t.after(() => storage.close())
    if (!storage.selectSnapshot) {
      t.skip('optional selected snapshot')
      return
    }
    assert.equal(await storage.selectSnapshot('absent', []), null)
    const context = createContextRuntime({ sessionId: 's', storage })
    const first = await context.append({ kind: 'audit', title: 'literal_%:one', body: 'first' })
    const latest = await context.append({ kind: 'audit', title: 'literal_%:one', body: 'latest' })
    await context.append({ kind: 'event', title: 'literal_%:one', body: 'wrong kind' })
    await context.append({ kind: 'audit', title: 'literalXY:one', body: 'not a literal prefix' })
    const full = await storage.load('s')
    const selected = await storage.selectSnapshot('s', [
      { titlePrefix: 'literal_%:', kind: 'audit', latest: true },
      { refId: first.ref.id },
      { title: 'literal_%:one', kind: 'audit', latest: true },
    ])
    assert.deepEqual(selected.records, [first, latest])
    assert.equal(selected.metadata.version, full.version)
    assert.deepEqual((await storage.selectSnapshot('s', [])).records, [])
    assert.deepEqual((await storage.selectSnapshot('s', [{ title: 'absent' }])).records, [])
    selected.records[0].ref.id = 'mutated'
    selected.metadata.workingSet.revision = 99
    assert.deepEqual(await storage.load('s'), full)
  })
  test(`${name}: metadata CAS shares versions with full CAS and appends without replacing history`, async (t) => {
    const { open } = await fixture(t)
    const a = await open()
    const b = await open()
    t.after(async () => {
      await a.close()
      await b.close()
    })
    if (!a.loadMetadata || !a.compareAndSwapMetadata)
      return t.skip('adapter uses complete state CAS')
    assert.equal(await a.loadMetadata('s'), null)
    const c = createContextRuntime({ sessionId: 's', storage: a })
    const first = await c.append({ kind: 'user', body: 'goal' })
    const before = await a.load('s')
    const head = await b.loadMetadata('s')
    assert.equal(Object.hasOwn(head, 'records'), false)
    const objectId = await a.put('s', 'archive')
    const entry = { ...first, ref: { sessionId: 's', id: 'archive' }, objectId, title: 'archive' }
    delete entry.sequence
    const next = {
      ...head,
      version: head.version + 1,
      workingSet: { revision: 1, cursor: 1, items: [first.ref] },
    }
    const commits = await Promise.all([
      a.compareAndSwapMetadata('s', head.version, next, [entry]),
      b.compareAndSwap('s', head.version, { ...before, version: head.version + 1 }),
    ])
    assert.equal(commits.filter(Boolean).length, 1)
    assert.equal(commits[0], true)
    next.workingSet.cursor = 777
    head.workingSet.cursor = 888
    const saved = await a.load('s')
    assert.equal(saved.workingSet.cursor, 1)
    assert.equal(saved.records.length, 2)
    assert.deepEqual(saved.records[0], first)
    assert.equal(saved.records[1].sequence, 2)
    const latest = await a.loadMetadata('s')
    await c.append({ kind: 'event', body: 'concurrent' })
    assert.equal(
      await b.compareAndSwapMetadata('s', latest.version, {
        ...latest,
        version: latest.version + 1,
      }),
      false
    )
    const now = await a.loadMetadata('s')
    const intact = await b.load('s')
    await assert.rejects(
      a.compareAndSwapMetadata('s', now.version, { ...now, version: now.version + 1 }, [
        { ...entry, ref: { sessionId: 's', id: 'valid' } },
        { ...entry, ref: { sessionId: 's', id: 'missing' }, objectId: 'absent' },
      ]),
      { code: 'OBJECT_MISSING' }
    )
    await assert.rejects(
      a.compareAndSwapMetadata('s', now.version, { ...now, version: now.version + 1 }, [entry]),
      { code: 'INVALID_RECORDS' }
    )
    await assert.rejects(
      a.compareAndSwapMetadata('s', now.version, { ...now, version: now.version + 1, records: [] }),
      { code: 'INVALID_RECORDS' }
    )
    assert.deepEqual(await b.load('s'), intact)
    await a.close()
    const reopened = await open()
    t.after(() => reopened.close())
    assert.deepEqual(await reopened.loadMetadata('s'), now)
  })
  test(`${name}: optional atomic append preserves metadata, rejects bad sources and invalidates stale CAS`, async (t) => {
    const { open } = await fixture(t)
    const a = await open()
    const b = await open()
    t.after(async () => {
      await a.close()
      await b.close()
    })
    if (!a.appendRecord) return t.skip('adapter uses the complete CAS path')
    const c = createContextRuntime({ sessionId: 's', storage: a })
    const first = await c.append({ kind: 'user', body: 'goal' })
    const before = await a.load('s')
    const metadata = {
      ...before,
      version: before.version + 1,
      workingSet: { revision: 4, cursor: 1, items: [first.ref] },
    }
    assert(await a.compareAndSwap('s', before.version, metadata))
    const body = await a.put('s', 'evidence')
    const entry = {
      ...first,
      ref: { sessionId: 's', id: 'next' },
      objectId: body,
      sources: [first.ref],
    }
    delete entry.sequence
    const next = await b.appendRecord('s', entry)
    assert.equal(next.sequence, 2)
    assert.equal(
      await a.compareAndSwap('s', metadata.version, { ...metadata, version: metadata.version + 1 }),
      false
    )
    const saved = await a.load('s')
    assert.deepEqual(saved.workingSet, metadata.workingSet)
    entry.sources.length = 0
    next.ref.id = 'mutated'
    assert.equal((await b.load('s')).records[1].ref.id, 'next')
    assert.deepEqual((await b.load('s')).records[1].sources, [first.ref])
    for (const [change, code] of [
      [{ ref: { sessionId: 's', id: 'next' } }, 'INVALID_RECORDS'],
      [{ ref: { sessionId: 's', id: 'missing-body' }, objectId: 'absent' }, 'OBJECT_MISSING'],
      [
        {
          ref: { sessionId: 's', id: 'missing-source' },
          sources: [{ sessionId: 's', id: 'absent' }],
        },
        'REF_NOT_FOUND',
      ],
      [
        {
          ref: { sessionId: 's', id: 'cross-source' },
          sources: [{ sessionId: 'other', id: first.ref.id }],
        },
        'SCOPE_MISMATCH',
      ],
    ])
      await assert.rejects(a.appendRecord('s', { ...entry, ...change }), { code })
    assert.deepEqual(await a.load('s'), saved)
    const contexts = [a, b].map((storage) => createContextRuntime({ sessionId: 's', storage }))
    const appended = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        contexts[i % 2].append({ kind: 'event', body: String(i), sources: [first.ref] })
      )
    )
    assert.deepEqual(
      appended.map((record) => record.sequence).sort((x, y) => x - y),
      Array.from({ length: 20 }, (_, i) => i + 3)
    )
  })
  test(`${name}: bodies are immutable, scoped and survive reopening`, async (t) => {
    const { open } = await fixture(t)
    const a = await open()
    const b = await open()
    t.after(async () => {
      await a.close()
      await b.close()
    })
    const first = await a.put('s', 'first')
    const second = await a.put('s', 'second')
    assert.equal(await b.get('s', first), 'first')
    assert.equal(await b.get('s', second), 'second')
    assert.equal(await b.get('other', first), null)
    await a.close()
    const reopened = await open()
    t.after(() => reopened.close())
    assert.equal(await reopened.get('s', first), 'first')
  })
  test(`${name}: concurrent CAS publishes exactly one whole detached snapshot`, async (t) => {
    const { open } = await fixture(t)
    const a = await open()
    const b = await open()
    t.after(async () => {
      await a.close()
      await b.close()
    })
    assert.equal(await a.load('s'), null)
    const initial = { ...empty(), version: 1 }
    assert(await a.compareAndSwap('s', 0, initial))
    initial.workingSet.cursor = 999
    assert.equal((await b.load('s')).workingSet.cursor, 0)
    const left = { ...empty(), version: 2, workingSet: { revision: 1, cursor: 1, items: [] } }
    const right = { ...empty(), version: 2, workingSet: { revision: 2, cursor: 2, items: [] } }
    const results = await Promise.all([
      a.compareAndSwap('s', 1, left),
      b.compareAndSwap('s', 1, right),
    ])
    assert.equal(results.filter(Boolean).length, 1)
    const actual = await b.load('s')
    assert.deepEqual(actual, results[0] ? left : right)
    actual.workingSet.cursor = 777
    assert.notEqual((await a.load('s')).workingSet.cursor, 777)
    assert.equal(await b.compareAndSwap('s', 0, initial), false)
    assert.equal(await b.load('other'), null)
  })
  test(`${name}: missing bodies cannot publish metadata or replace valid state`, async (t) => {
    const { open } = await fixture(t)
    const a = await open()
    t.after(() => a.close())
    const c = createContextRuntime({ sessionId: 's', storage: a })
    const record = await c.append({ kind: 'user', body: 'original' })
    const before = await a.load('s')
    await assert.rejects(
      a.compareAndSwap('s', before.version, {
        ...before,
        version: before.version + 1,
        records: [{ ...record, objectId: 'absent' }],
      }),
      { code: 'OBJECT_MISSING' }
    )
    assert.deepEqual(await a.load('s'), before)
    assert.equal((await c.read(record.ref)).text, 'original')
  })
  test(`${name}: context uses opaque references with or without an index`, async (t) => {
    const { open } = await fixture(t)
    const a = await open()
    t.after(() => a.close())
    const c = createContextRuntime({ sessionId: 's', storage: a })
    const first = await c.append({ kind: 'user', title: 'goal', body: 'Keep this intent' })
    await c.append({ kind: 'tool', title: 'evidence', body: 'read version 2' })
    const note = await c.write({
      kind: 'checkpoint',
      title: 'progress',
      body: 'use version 2',
      sources: [first.ref],
    })
    assert.equal((await c.read(note.ref)).text, 'use version 2')
    if (a.records) {
      const page = await a.records('s', { limit: 1 })
      assert.equal(page.items[0].ref.id, first.ref.id)
      assert.equal(page.nextAfter, first.sequence)
      assert.deepEqual((await a.records('s', { title: 'progress' })).items, [note])
      assert.equal((await a.records('s', { after: note.sequence })).nextAfter, null)
    }
    await a.close()
    const reopened = await open()
    t.after(() => reopened.close())
    const restored = createContextRuntime({ sessionId: 's', storage: reopened })
    assert.equal((await restored.read(first.ref)).text, 'Keep this intent')
  })
  test(`${name}: closing one connection is idempotent and leaves other connections usable`, async (t) => {
    const { open } = await fixture(t)
    const a = await open()
    const b = await open()
    t.after(async () => {
      await a.close()
      await b.close()
    })
    await a.close()
    await a.close()
    await assert.rejects(a.load('s'))
    const id = await b.put('s', 'still open')
    assert.equal(await b.get('s', id), 'still open')
  })
}

// 完整 Runtime 适配器还应运行共享对象/事件合同；不支持 stores 时不会注册这一组。
export function storeContract(name, fixture) {
  test(`${name}: atomic object plus event is idempotent and CAS conflict has no effects`, async (t) => {
    const { open } = await fixture(t)
    const a = await open()
    const b = await open()
    t.after(async () => {
      await a.close()
      await b.close()
    })
    const created = { scope: 'project', owner: 'main', name: 'shared', operationId: 'create' }
    const descriptor = await a.stores.create(created)
    assert.deepEqual(await b.stores.create(created), descriptor)
    const id = descriptor.id
    await b.stores.subscribe(id, 'reader', [''], 'subscribe', 0)
    await b.stores.watch(id, 'reader', [], [''], 'watch')
    const input = {
      store: id,
      key: 'result',
      baseRevision: 0,
      value: { value: 2 },
      actor: 'main',
      operationId: 'write',
      event: { topic: 'ready', value: { ref: 'result' } },
    }
    const saved = await a.stores.commit(input)
    assert.deepEqual(await b.stores.commit(input), saved)
    assert.deepEqual(await b.stores.receipt(id, 'write'), saved)
    saved.value.value = 999
    assert.equal((await b.stores.get(id, 'result')).value.value, 2)
    await assert.rejects(b.stores.commit({ ...input, operationId: 'conflict', value: 3 }), {
      code: 'STORE_CONFLICT',
    })
    assert.equal(await a.stores.receipt(id, 'conflict'), null)
    assert.equal((await b.stores.messages(id, 'reader', [''])).events.length, 1)
    assert.equal((await b.stores.changes(id, 'reader', [''])).head, 1)
  })
  test(`${name}: receipt and delivery/processing cursors recover on a fresh connection`, async (t) => {
    const { open } = await fixture(t)
    const a = await open()
    t.after(() => a.close())
    const id = (
      await a.stores.create({ scope: 'p', owner: 'main', name: 's', operationId: 'create' })
    ).id
    const sub = await a.stores.subscribe(id, 'reader', ['ok/'], 'sub', 0)
    const event = await a.stores.publish({
      store: id,
      topic: 'ok/done',
      value: 'done',
      actor: 'main',
      operationId: 'publish',
    })
    await a.stores.publish({
      store: id,
      topic: 'private',
      value: 'hidden',
      actor: 'main',
      operationId: 'private',
    })
    await a.stores.delivered(id, 'reader', sub.revision, event.sequence)
    await a.close()
    const b = await open()
    t.after(() => b.close())
    assert.deepEqual(await b.stores.receipt(id, 'publish'), event)
    const pending = await b.stores.messages(id, 'reader', ['ok/'])
    assert.deepEqual(pending.events, [event])
    assert.equal(pending.pending, 1)
    assert.equal(
      (await b.stores.messages(id, 'reader', ['ok/'], { delivery: true })).events.length,
      0
    )
    await b.stores.acknowledgeEvents(id, 'reader', ['ok/'], [event.id], 'ack')
    assert.equal((await b.stores.messages(id, 'reader', ['ok/'])).pending, 0)
  })
  test(`${name}: cancelling or closing releases object and message waiters`, async (t) => {
    const { open } = await fixture(t)
    const a = await open()
    t.after(() => a.close())
    const id = (
      await a.stores.create({ scope: 'p', owner: 'main', name: 's', operationId: 'create' })
    ).id
    const cancelled = new AbortController()
    const reason = Error('cancel')
    const cancelledWait = assert.rejects(
      a.stores.waitEvents(id, 0, cancelled.signal),
      (error) => error === reason
    )
    cancelled.abort(reason)
    await cancelledWait
    const waiting = [
      a.stores.wait(id, 0, new AbortController().signal),
      a.stores.waitEvents(id, 0, new AbortController().signal),
    ].map((promise) => assert.rejects(promise, { code: 'STORAGE_CLOSED' }))
    await a.close()
    await Promise.all(waiting)
    await assert.rejects(a.stores.waitEvents(id, 0, new AbortController().signal), {
      code: 'STORAGE_CLOSED',
    })
  })
}
