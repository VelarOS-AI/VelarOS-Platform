import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import {
  ContextLimits,
  createContextInvocationJournal,
  createContextRuntime,
  createContextView,
} from '../dist/index.js'
import { localContextStorage } from '../dist/node.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'act-storage-'))
  const path = join(dir, 'context.sqlite')
  const connections = []
  const databases = []
  t.after(async () => {
    for (const storage of connections) await storage.close()
    for (const database of databases) if (database.isOpen) database.close()
    await rm(dir, { recursive: true, force: true })
  })
  return {
    open() {
      const storage = localContextStorage({ path })
      connections.push(storage)
      return storage
    },
    openDatabase() {
      const database = new DatabaseSync(path)
      databases.push(database)
      return database
    },
  }
}
const empty = { version: 0, records: [], workingSet: { revision: 0, cursor: 0, items: [] } }

test('original input projection keeps its interpretation and tail when the read page is smaller than the caller budget', async (t) => {
  const files = await fixture(t)
  const storage = files.open()
  const context = createContextRuntime({ sessionId: 's', storage })
  const original = `FIRST_CONSTRAINT\n${'材料😀\n'.repeat(ContextLimits.readChars / 4)}\nLAST_CONSTRAINT`
  for (const withAttachment of [false, true]) {
    const file = withAttachment ? await context.append({ kind: 'audit', body: 'attachment' }) : null
    const input = await context.ingest({
      text: original,
      ...(file
        ? { files: [{ ref: file.ref, name: 'reference.txt', mediaType: 'text/plain' }] }
        : {}),
    })
    await context.summarizeInput({
      ref: input.ref,
      baseRevision: 0,
      summary: 'Keep the first and last constraints.',
      constraints: ['FIRST_CONSTRAINT', 'LAST_CONSTRAINT'],
      unresolved: [],
    })
    for (const budget of [
      original.length * 2,
      ContextLimits.readChars,
      Math.floor(original.length / 3),
    ]) {
      const projected = JSON.parse((await context.projectInput(input.ref, budget, true)).text)
      assert.equal(projected.representation, 'excerpt-with-summary')
      assert.equal(projected.partial, true)
      assert.equal(projected.totalChars, original.length)
      assert(projected.omittedChars > 0)
      assert.equal(projected.historicalInterpretation.origin, 'model-interpretation')
      assert.equal(projected.historicalInterpretation.revision, 1)
      for (const excerpt of projected.excerpts)
        assert.equal(
          excerpt.text,
          original.slice(excerpt.offset, excerpt.offset + excerpt.text.length)
        )
      assert(projected.excerpts[0].text.includes('FIRST_CONSTRAINT'))
      assert(projected.excerpts.at(-1).text.includes('LAST_CONSTRAINT'))
      assert.equal(projected.files.length, withAttachment ? 1 : 0)
    }
  }
})

test('task accounting avoids full history and task replacement archives atomically', async (t) => {
  const files = await fixture(t)
  const storage = files.open()
  const context = createContextRuntime({ sessionId: 's', storage })
  const goal = await context.append({ kind: 'user', body: 'goal' })
  const view = createContextView({ sessionId: 's', storage, context, sources: [] })
  await view.begin(goal.ref)
  const db = files.openDatabase()
  db.exec(
    "CREATE TRIGGER no_history_update BEFORE UPDATE ON context_records BEGIN SELECT RAISE(ABORT,'rewritten'); END; CREATE TRIGGER no_history_delete BEFORE DELETE ON context_records BEGIN SELECT RAISE(ABORT,'deleted'); END"
  )
  const load = t.mock.method(storage, 'load', () => {
    throw Error('full snapshot loaded')
  })
  await view.renew()
  await view.reserveModel('main', 10)
  await view.recordUsage(4, 2)
  assert.equal((await view.inspect()).usage.inputTokens, 4)
  assert.equal(load.mock.callCount(), 0)
  await view.end('completed')
  const prior = await view.inspect()
  const nextGoal = await context.append({ kind: 'user', body: 'new goal' })
  db.exec(
    "CREATE TRIGGER fail_archive BEFORE INSERT ON context_records WHEN NEW.title LIKE 'task:archive:%' BEGIN SELECT RAISE(ABORT,'archive failed'); END"
  )
  await assert.rejects(view.begin(nextGoal.ref, undefined, 'new'), /archive failed/)
  assert.deepEqual(await view.inspect(), prior)
  db.exec('DROP TRIGGER fail_archive')
  await view.begin(nextGoal.ref, undefined, 'new')
  const archive = (await storage.records('s', { title: `task:archive:${prior.id}` })).items
  assert.equal(archive.length, 1)
  assert.deepEqual(JSON.parse(await storage.get('s', archive[0].objectId)), prior)
  assert.notEqual((await view.inspect()).id, prior.id)
})

test('journal indexes use incremental transactions and simultaneous claims keep one owner', async (t) => {
  const files = await fixture(t)
  const a = files.open()
  const b = files.open()
  const key = JSON.stringify(['kernel-invocation-index', 's'])
  for (const storage of [a, b]) {
    const load = storage.load.bind(storage)
    t.mock.method(storage, 'load', (id) => {
      assert.notEqual(id, key)
      return load(id)
    })
  }
  const journals = [a, b].map(createContextInvocationJournal)
  const prepared = {
    id: 'same',
    sessionId: 's',
    executionId: 'execution',
    binding: { moduleId: 'test:read', instanceId: 'one', generation: 1, schemaRevision: '1' },
    operation: 'read',
    input: null,
    inputFingerprint: 'null',
    requestFingerprint: 'fingerprint',
  }
  const claims = await Promise.all(journals.map((journal) => journal.claim(prepared)))
  assert.equal(claims.filter((value) => value === null).length, 1)
  assert.equal((await a.records(key, {})).items.length, 1)
  assert.equal((await journals[0].list('s', 'execution')).length, 1)
})

test('atomic append rolls back the record when metadata publication fails', async (t) => {
  const files = await fixture(t)
  const storage = files.open()
  const context = createContextRuntime({ sessionId: 's', storage })
  await context.append({ kind: 'user', body: 'goal' })
  const before = await storage.load('s')
  const db = files.openDatabase()
  db.exec(
    "CREATE TRIGGER fail_publish BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'publish failed'); END"
  )
  await assert.rejects(context.append({ kind: 'event', body: 'unpublished' }), /publish failed/)
  assert.deepEqual(await storage.load('s'), before)
  db.exec('DROP TRIGGER fail_publish')
  assert.equal((await context.append({ kind: 'event', body: 'next' })).sequence, 2)
})

test('INV-7 索引记录保持原引用、分页和跨连接 CAS，元数据更新不重写历史', async (t) => {
  const files = await fixture(t)
  const a = files.open()
  const b = files.open()
  const context = createContextRuntime({ sessionId: 's', storage: a })
  const record = await context.append({ kind: 'user', title: 'goal', body: 'task' })
  const initial = await a.load('s')
  const state = {
    ...initial,
    version: initial.version + 1,
    workingSet: { ...initial.workingSet, revision: 1, items: [record.ref] },
  }
  const db = files.openDatabase()
  db.exec(
    "CREATE TRIGGER forbid_rewrite BEFORE UPDATE ON context_records BEGIN SELECT RAISE(ABORT,'history rewritten'); END"
  )
  const outcomes = await Promise.all([
    a.compareAndSwap('s', initial.version, state),
    b.compareAndSwap('s', initial.version, state),
  ])
  assert.equal(outcomes.filter(Boolean).length, 1)
  assert.deepEqual((await b.records('s', { title: 'goal' })).items, [record])
  assert.deepEqual(await b.load('s'), state)
  assert.equal(
    JSON.parse(db.prepare('SELECT state FROM sessions WHERE id=?').get('s').state).records,
    undefined
  )
  assert.equal((await context.read(record.ref)).text, 'task')
  db.close()
})

test('long directories keep the CAS state small and indexed pages cover every record exactly once', async (t) => {
  const files = await fixture(t)
  const storage = files.open()
  const objectId = await storage.put('s', 'immutable evidence')
  const records = Array.from({ length: 1200 }, (_, i) => ({
    ref: { sessionId: 's', id: `r${i}` },
    sequence: i + 1,
    kind: 'audit',
    title: i % 2 ? 'odd' : 'even',
    objectId,
    chars: 18,
    sources: [],
    createdAt: new Date().toISOString(),
  }))
  await storage.compareAndSwap('s', 0, { ...empty, version: 1, records })
  const ids = []
  let after = 0
  do {
    const page = await storage.records('s', { after, limit: 73, title: 'odd' })
    ids.push(...page.items.map((r) => r.ref.id))
    after = page.nextAfter
  } while (after !== null)
  assert.equal(ids.length, 600)
  assert.equal(new Set(ids).size, 600)
  for (let version = 1; version <= 10; version++)
    assert(
      await storage.compareAndSwap('s', version, {
        ...empty,
        version: version + 1,
        records,
        workingSet: { revision: version, cursor: version, items: [] },
      })
    )
  const db = files.openDatabase()
  const chars = Number(
    db.prepare('SELECT length(state) AS size FROM sessions WHERE id=?').get('s').size
  )
  assert(chars < 500)
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM context_records WHERE session=?').get('s').n,
    1200
  )
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  db.close()
  assert.equal((await storage.load('s')).records.length, 1200)
  t.diagnostic(
    JSON.stringify({ records: 1200, metadataChars: chars, pageSize: 73, filteredRecords: 600 })
  )
})

test('object collection is opt-in, version-checked, grace-protected and keeps every archived body', async (t) => {
  const files = await fixture(t)
  const storage = files.open()
  const context = createContextRuntime({ sessionId: 's', storage })
  const record = await context.append({ kind: 'user', body: 'retained task' })
  const orphan = await storage.put('s', 'unpublished candidate')
  const staged = await storage.put('s', 'candidate reused before publishing')
  const db = files.openDatabase()
  db.prepare('UPDATE objects SET touched=1 WHERE session=?').run('s')
  db.close()
  await storage.put('s', 'candidate reused before publishing')
  const version = (await storage.load('s')).version
  const before = Date.now() - 7200000
  assert.deepEqual(await storage.collect('s', { expectedVersion: version, before }), {
    candidates: 1,
    deleted: 0,
  })
  assert.equal(await storage.get('s', orphan), 'unpublished candidate')
  await assert.rejects(
    storage.collect('s', { expectedVersion: version + 1, before, dryRun: false }),
    { code: 'CONTEXT_CONFLICT' }
  )
  await assert.rejects(
    storage.collect('s', { expectedVersion: version, before: Date.now(), dryRun: false }),
    { code: 'INVALID_RANGE' }
  )
  assert.deepEqual(
    await storage.collect('s', { expectedVersion: version, before, dryRun: false }),
    { candidates: 1, deleted: 1 }
  )
  assert.equal(await storage.get('s', orphan), null)
  assert.equal((await context.read(record.ref)).text, 'retained task')
  assert(await storage.get('s', staged))
})

test('journal execution lookup loads matching receipts rather than every session receipt', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  t.after(() => storage.close())
  let reads = 0
  const counted = {
    load: (id) => storage.load(id),
    compareAndSwap: (...args) => storage.compareAndSwap(...args),
    put: (...args) => storage.put(...args),
    get: (...args) => {
      reads++
      return storage.get(...args)
    },
    records: (...args) => storage.records(...args),
    close: async () => {},
  }
  const journal = createContextInvocationJournal(counted)
  for (let i = 0; i < 80; i++)
    await journal.claim({
      id: `i${i}`,
      sessionId: 's',
      executionId: i % 10 ? 'other' : 'wanted',
      binding: { moduleId: 'test:read', instanceId: 'one', generation: 1, schemaRevision: '1' },
      operation: 'read',
      input: null,
      inputFingerprint: 'null',
      requestFingerprint: String(i),
    })
  reads = 0
  assert.equal((await journal.list('s', 'wanted')).length, 8)
  assert.equal(reads, 8)
})

test('selected snapshots keep one version while another connection commits between queries', async (t) => {
  const files = await fixture(t)
  const a = files.open()
  const b = files.open()
  const context = createContextRuntime({ sessionId: 's', storage: a })
  const first = await context.append({ kind: 'audit', title: 'state', body: 'first' })
  const old = await a.loadMetadata('s')
  const objectId = await b.put('s', 'second')
  const prepare = DatabaseSync.prototype.prepare
  let committing
  let intercepted = false
  const hook = t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    if (!intercepted && sql.startsWith('SELECT body FROM context_records')) {
      intercepted = true
      committing = b.compareAndSwapMetadata(
        's',
        old.version,
        { ...old, version: old.version + 1 },
        [{ ...first, ref: { sessionId: 's', id: 'second' }, objectId }]
      )
    }
    return prepare.call(this, sql)
  })
  const snapshot = await a.selectSnapshot('s', [
    { title: 'state', latest: true },
    { refId: first.ref.id },
  ])
  hook.mock.restore()
  assert.equal(await committing, true)
  assert.equal(snapshot.metadata.version, old.version)
  assert.deepEqual(snapshot.records, [first])
  const current = await a.selectSnapshot('s', [{ title: 'state', latest: true }])
  assert.equal(current.metadata.version, old.version + 1)
  assert.equal(current.records[0].ref.id, 'second')
  assert.equal(
    await a.compareAndSwapMetadata('s', snapshot.metadata.version, {
      ...snapshot.metadata,
      version: snapshot.metadata.version + 1,
    }),
    false
  )
})

test('input recall retains compatibility with archived fixed-width chunks', async (t) => {
  const files = await fixture(t)
  const storage = files.open()
  const context = createContextRuntime({ sessionId: 'legacy', storage })
  const a = await context.append({
    kind: 'audit',
    title: 'user:text-chunk',
    body: 'x'.repeat(8000000),
  })
  const b = await context.append({ kind: 'audit', title: 'user:text-chunk', body: '旧😀尾' })
  const chunks = [a.ref, b.ref]
  const input = await context.append({
    kind: 'user',
    title: 'user:manifest',
    body: JSON.stringify({ chars: a.chars + b.chars, chunks, files: [] }),
    sources: chunks,
  })
  assert.equal(
    (await context.readInput(input.ref, { offset: 7999998, limit: 30 })).text,
    'xx旧😀尾'
  )
})

for (const mode of ['indexed', 'selection-only', 'fallback'])
  test(`${mode}: input recall preserves attachment membership and chunk boundaries without unrelated bodies`, async (t) => {
    const files = await fixture(t)
    const storage = files.open()
    const port =
      mode === 'indexed'
        ? storage
        : {
            load: (...args) => storage.load(...args),
            compareAndSwap: (...args) => storage.compareAndSwap(...args),
            put: (...args) => storage.put(...args),
            get: (...args) => storage.get(...args),
            close: () => storage.close(),
            ...(mode === 'selection-only'
              ? { selectSnapshot: (...args) => storage.selectSnapshot(...args) }
              : {}),
          }
    const context = createContextRuntime({ sessionId: 's', storage: port })
    const file = await context.append({ kind: 'audit', body: 'attachment text' })
    const unrelated = await context.append({ kind: 'audit', body: 'private audit' })
    const otherInput = await context.ingest({
      files: [{ ref: unrelated.ref, name: 'other', mediaType: 'text/plain' }],
    })
    const text = `${'a'.repeat(7999999)}😀中😀文`
    const input = await context.ingest({
      text,
      files: [{ ref: file.ref, name: 'file', mediaType: 'text/plain' }],
    })
    await context.summarizeInput({
      ref: input.ref,
      baseRevision: 0,
      summary: 'preserved intent',
      constraints: ['keep original'],
      unresolved: [],
    })
    const manifest = JSON.parse(await storage.get('s', input.objectId))
    const forbidden = new Set([otherInput.objectId])
    const get = storage.get.bind(storage)
    t.mock.method(storage, 'get', (...args) => {
      assert(!forbidden.has(args[1]), 'unrelated manifest loaded')
      return get(...args)
    })
    if (mode !== 'fallback')
      t.mock.method(storage, 'load', () => {
        throw Error('full input history loaded')
      })
    assert.equal((await context.readInput(file.ref, { offset: 3, limit: 7 })).text, 'achment')
    const restored = await context.readInput(input.ref, { offset: 7999996, limit: 32 })
    assert.equal(restored.text, text.slice(7999996))
    for (const offset of [7999998, 7999999, 8000000, 8000001, text.length]) {
      const page = await context.readInput(input.ref, { offset, limit: 2 })
      assert.equal(page.text, text.slice(offset, offset + 2))
      assert.equal(page.totalChars, text.length)
    }
    const projected = JSON.parse((await context.projectInput(input.ref, 100)).text)
    assert.equal(projected.intent.summary, 'preserved intent')
    assert.equal(projected.summaryRevision, 1)
    assert.equal(projected.files[0].ref.id, file.ref.id)
    await assert.rejects(context.readInput(manifest.chunks[0]), { code: 'INPUT_REF' })
    await assert.rejects(context.readInput({ ...file.ref, sessionId: 'other' }), {
      code: 'SCOPE_MISMATCH',
    })
    await assert.rejects(context.readInput({ sessionId: 's', id: 'missing' }), {
      code: 'REF_NOT_FOUND',
    })
    if (mode === 'indexed')
      await context.ingest({ files: [{ ref: file.ref, name: 'again', mediaType: 'text/plain' }] })
    forbidden.clear()
    const missing = t.mock.method(storage, 'get', (...args) =>
      args[1] === input.objectId ? null : get(...args)
    )
    await assert.rejects(context.readInput(input.ref), { code: 'OBJECT_MISSING' })
    missing.mock.restore()
    const chunk = (await storage.records('s', { refId: manifest.chunks[1].id })).items[0]
    t.mock.method(storage, 'get', (...args) => (args[1] === chunk.objectId ? null : get(...args)))
    await assert.rejects(context.readInput(input.ref, { offset: 8000000, limit: 32 }), {
      code: 'OBJECT_MISSING',
    })
  })
