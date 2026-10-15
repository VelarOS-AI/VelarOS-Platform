// 用途：以真实文件、网络与进程核验离线协作服务；每份夹具按资源依赖逆序回收。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer as httpServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import nodeTest from 'node:test'
import { pathToFileURL } from 'node:url'

import { safePackPackage } from '../../release/safe-package-pack.mjs'
import { runCapturedCommand } from './command-output.mjs'
import { readRoomDocument, roomJsonEditor } from './roomsync-ui-check.mjs'

const packageRoot = resolve('contrib/roomsync')
const entry = join(packageRoot, 'index.js')
const require = createRequire(pathToFileURL(join(process.cwd(), 'package.json')))
const stacks = new WeakMap()
const test = (name, body, timeout = 20000) =>
  nodeTest(name, { timeout }, async (t) => {
    const stack = []
    stacks.set(t, stack)
    t.after(async () => {
      const errors = []
      for (const cleanup of stack.reverse()) {
        try {
          await cleanup()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed')
    })
    return body(t)
  })
const after = (t, cleanup) => stacks.get(t).push(cleanup)
const code =
  (...codes) =>
  (error) =>
    codes.includes(error?.code)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function mutateCopy(action) {
  try {
    action()
  } catch (error) {
    assert(error instanceof TypeError, 'A frozen isolated value may reject caller mutation')
  }
}
async function until(predicate, message, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (!(await predicate())) {
    assert(Date.now() < deadline, message)
    await pause(10)
  }
}
function feature() {
  assert(existsSync(entry), 'RoomSync public API must exist')
  const api = require(entry)
  for (const key of ['openStore', 'createServer', 'RoomClient'])
    assert.equal(typeof api[key], 'function', key)
  return api
}
async function setup(t, options) {
  const api = feature()
  const root = await mkdtemp(join(tmpdir(), 'roomsync-accept-'))
  after(t, () => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'store')
  const f = { api, root, directory, store: await api.openStore(directory, options) }
  after(t, () => f.store.close())
  return f
}
const put = (key, value) => ({ op: 'put', key, value })
const transaction = (
  revision,
  operations,
  id = `request-${revision}`,
  clientId = 'test-client'
) => ({
  clientId,
  requestId: id,
  expectedRevision: revision,
  operations,
})
const commit = (f, revision, operations, id, room = 'main') =>
  f.store.transact(room, transaction(revision, operations, id))
const documents = (snapshot) =>
  Object.fromEntries(snapshot.documents.map((item) => [item.key, item.value]))
async function reopen(f) {
  await f.store.close()
  f.store = await f.api.openStore(f.directory)
}

test('companion public API preserves the frozen ws production files and metadata', async () => {
  feature()
  const contract = JSON.parse(
    await readFile(new URL('./roomsync-ws-contract.json', import.meta.url))
  )
  for (const [path, hash] of Object.entries(contract.files))
    assert.equal(
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
      hash,
      path
    )
})

test('snapshots preserve JSON values, Unicode and special keys without shared references', async (t) => {
  const f = await setup(t)
  assert.deepEqual(await f.store.snapshot('main'), {
    room: 'main',
    revision: 0,
    minimumRevision: 0,
    documents: [],
  })
  const value = JSON.parse('{"__proto__":{"safe":true},"nested":[null,"中文🙂",3]}')
  await commit(f, 0, [put('__proto__', value), put('constructor', false), put('prototype', null)])
  value.nested.push('changed by caller')
  const first = await f.store.snapshot('main')
  assert.equal(first.revision, 1)
  assert.deepEqual(
    first.documents.map((d) => d.key),
    ['__proto__', 'constructor', 'prototype']
  )
  assert.equal(first.documents[0].value.nested.length, 3)
  mutateCopy(() => first.documents[0].value.nested.push('changed snapshot'))
  assert.equal((await f.store.snapshot('main')).documents[0].value.nested.length, 3)
  assert.equal({}.safe, undefined)
  assert.equal((await f.store.snapshot('separate')).revision, 0)
})

test('invalid identities and non-JSON data reject without reserving IDs or revisions', async (t) => {
  const f = await setup(t)
  for (const room of ['../outside', '', 'Uppercase', 'a/b', 'a\0b'])
    await assert.rejects(f.store.snapshot(room), code('INVALID'))
  const cycle = {}
  cycle.self = cycle
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => 1,
    Symbol('x'),
    new Date(),
    new Array(2),
    cycle,
  ])
    await assert.rejects(commit(f, 0, [put('bad', value)], 'reusable'), code('INVALID'))
  for (const key of ['', 'bad\0key', 'x'.repeat(257)])
    await assert.rejects(commit(f, 0, [put(key, 1)], 'reusable'), code('INVALID'))
  assert.equal((await commit(f, 0, [put('valid', 1)], 'reusable')).revision, 1)
})

test('invalid store and transaction options reject before acquiring effects', async (t) => {
  const f = await setup(t)
  for (const options of [{ maxDocumentBytes: 0 }, { maxTransactionBytes: 1.5 }, { unknown: true }])
    await assert.rejects(f.api.openStore(join(f.root, 'invalid-options'), options), code('INVALID'))
  await assert.rejects(
    f.store.transact('main', transaction(0, [put('x', 1)]), { unknown: true }),
    code('INVALID')
  )
  assert.equal((await f.store.snapshot('main')).revision, 0)
})

test('failed operations roll back the whole cross-document transaction', async (t) => {
  const f = await setup(t)
  await commit(f, 0, [put('a', { count: 1 }), put('b', [1, 2])])
  const before = await f.store.snapshot('main')
  await assert.rejects(
    commit(f, 1, [put('a', 'changed'), { op: 'delete', key: 'missing' }], 'atomic'),
    code('NOT_FOUND')
  )
  await assert.rejects(
    commit(
      f,
      1,
      [
        { op: 'delete', key: 'b' },
        { op: 'patch', key: 'a', patch: [{ op: 'test', path: '/count', value: 2 }] },
      ],
      'atomic'
    ),
    code('CONFLICT')
  )
  assert.deepEqual(await f.store.snapshot('main'), before)
  assert.equal((await f.store.history('main')).length, 1)
  assert.equal((await commit(f, 1, [put('a', 2)], 'atomic')).revision, 2)
})

test('concurrent compare-and-swap commits have exactly one winner', async (t) => {
  const f = await setup(t)
  const attempts = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) => commit(f, 0, [put('winner', i)], `race-${i}`))
  )
  assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 1)
  for (const result of attempts.filter((x) => x.status === 'rejected')) {
    assert.equal(result.reason.code, 'CONFLICT')
    assert.equal(result.reason.currentRevision, 1)
  }
  assert.equal((await f.store.snapshot('main')).revision, 1)
})

test('idempotency precedes revision checking and compares semantic payloads', async (t) => {
  const f = await setup(t)
  const request = transaction(0, [put('one', { x: 1, y: 2 })], 'retry')
  const original = await f.store.transact('main', request)
  await commit(f, 1, [put('two', true)])
  const retry = {
    operations: [put('one', { y: 2, x: 1 })],
    expectedRevision: 0,
    requestId: 'retry',
    clientId: 'test-client',
  }
  assert.deepEqual(await f.store.transact('main', retry), { ...original, duplicate: true })
  await assert.rejects(
    f.store.transact('main', { ...request, operations: [put('one', 3)] }),
    code('ID_REUSE')
  )
  assert.equal((await f.store.snapshot('main')).revision, 2)
  assert.equal((await f.store.history('main')).length, 2)
})

test('subscribers receive isolated durable events once and unsubscribe cleanly', async (t) => {
  const f = await setup(t)
  const received = []
  const stopBad = f.store.subscribe('main', (event) => {
    event.operations[0].value = 'mutated'
    throw new Error('listener failure')
  })
  const stop = f.store.subscribe('main', (event) => received.push(event))
  await commit(f, 0, [put('one', 'original')], 'same')
  await commit(f, 0, [put('one', 'original')], 'same')
  await until(() => received.length === 1, 'subscriber did not receive the durable commit')
  assert.equal(received[0].operations[0].value, 'original')
  assert.equal(documents(await f.store.snapshot('main')).one, 'original')
  stop()
  stopBad()
  await commit(f, 1, [put('two', 2)])
  await pause(20)
  assert.equal(received.length, 1)
})

test('UTF-8 byte limits apply to resulting documents and cannot partially commit', async (t) => {
  const f = await setup(t, { maxDocumentBytes: 6, maxTransactionBytes: 4096 })
  await commit(f, 0, [put('emoji', '🙂')])
  await assert.rejects(commit(f, 1, [put('good', 1), put('large', '🙂x')]), code('LIMIT'))
  assert.deepEqual(documents(await f.store.snapshot('main')), { emoji: '🙂' })
  await assert.rejects(
    f.api.openStore(join(f.root, 'invalid'), { maxDocumentBytes: 0 }),
    code('INVALID')
  )
  await assert.rejects(f.api.openStore(join(f.root, 'unknown'), { surprise: 1 }), code('INVALID'))
})

test('JSON Patch supports escaped pointers, array edits, copy, move and structural tests', async (t) => {
  const f = await setup(t)
  await commit(f, 0, [put('doc', { 'a/b': { '~key': [1, 2] }, obj: { a: 1, b: 2 } })])
  await commit(f, 1, [
    {
      op: 'patch',
      key: 'doc',
      patch: [
        { op: 'test', path: '/obj', value: { b: 2, a: 1 } },
        { op: 'add', path: '/a~1b/~0key/-', value: 3 },
        { op: 'replace', path: '/a~1b/~0key/0', value: 9 },
        { op: 'copy', from: '/obj', path: '/copied' },
        { op: 'move', from: '/a~1b/~0key/2', path: '/a~1b/~0key/0' },
        { op: 'remove', path: '/obj/a' },
      ],
    },
  ])
  assert.deepEqual(documents(await f.store.snapshot('main')).doc, {
    'a/b': { '~key': [3, 9, 2] },
    obj: { b: 2 },
    copied: { a: 1, b: 2 },
  })
  await commit(f, 2, [
    { op: 'patch', key: 'doc', patch: [{ op: 'replace', path: '', value: [null, 'root'] }] },
  ])
  assert.deepEqual(documents(await f.store.snapshot('main')).doc, [null, 'root'])
})

test('invalid patch paths and descendant moves are atomic and safe for special properties', async (t) => {
  const f = await setup(t)
  await commit(f, 0, [put('doc', { a: { b: 1 }, list: [1] })])
  const before = await f.store.snapshot('main')
  for (const patch of [
    [{ op: 'replace', path: '/list/01', value: 2 }],
    [{ op: 'add', path: '/missing/child', value: 2 }],
    [{ op: 'replace', path: '/a~2b', value: 2 }],
    [{ op: 'move', from: '/a', path: '/a/child' }],
    [{ op: 'remove', path: '' }],
    [{ op: 'replace', path: '/a', value: 2, surprise: true }],
  ])
    await assert.rejects(
      commit(f, 1, [put('extra', true), { op: 'patch', key: 'doc', patch }]),
      code('INVALID')
    )
  assert.deepEqual(await f.store.snapshot('main'), before)
  await commit(f, 1, [
    {
      op: 'patch',
      key: 'doc',
      patch: [{ op: 'add', path: '/__proto__', value: { injected: true } }],
    },
  ])
  const doc = documents(await f.store.snapshot('main')).doc
  assert(Object.hasOwn(doc, '__proto__'))
  assert.equal(doc.__proto__.injected, true)
  assert.equal({}.injected, undefined)
})

test('history pagination and compaction preserve newer events and successful request IDs', async (t) => {
  const f = await setup(t)
  for (let i = 0; i < 5; i++) await commit(f, i, [put('counter', i)], `r${i}`)
  assert.deepEqual(
    (await f.store.history('main', { after: 1, limit: 2 })).map((e) => e.revision),
    [2, 3]
  )
  await f.store.compact('main', { through: 3 })
  await reopen(f)
  assert.equal((await f.store.snapshot('main')).minimumRevision, 3)
  await assert.rejects(
    f.store.history('main', { after: 2 }),
    (error) =>
      error.code === 'HISTORY_GONE' && error.minimumRevision === 3 && error.currentRevision === 5
  )
  assert.deepEqual(
    (await f.store.history('main', { after: 3 })).map((e) => e.revision),
    [4, 5]
  )
  assert.equal((await commit(f, 0, [put('counter', 0)], 'r0')).duplicate, true)
  assert.equal((await f.store.snapshot('main')).revision, 5)
})

test('an already-aborted transaction has no effects and close rejects new work', async (t) => {
  const f = await setup(t)
  const reason = new Error('cancel before commit')
  await assert.rejects(
    f.store.transact('main', transaction(0, [put('a', 1)]), { signal: AbortSignal.abort(reason) }),
    (error) => error === reason
  )
  assert.equal((await f.store.snapshot('main')).revision, 0)
  await f.store.close()
  await f.store.close()
  await assert.rejects(f.store.snapshot('main'), code('CLOSED'))
  await assert.rejects(commit(f, 0, [put('a', 1)]), code('CLOSED'))
})

test('a live owner excludes competing opens and symlink stores cannot escape the root', async (t) => {
  const f = await setup(t)
  await assert.rejects(f.api.openStore(f.directory), code('LOCKED'))
  const outside = join(f.root, 'outside')
  await mkdir(outside)
  const link = join(f.root, 'linked-store')
  await symlink(outside, link)
  await assert.rejects(f.api.openStore(link))
  await writeFile(join(outside, 'sentinel'), 'keep')
  await f.store.close()
  await mkdir(join(f.directory, 'rooms'), { recursive: true })
  await symlink(outside, join(f.directory, 'rooms', 'escape'))
  const opened = await f.api.openStore(f.directory).then(
    (store) => ({ store }),
    (error) => ({ error })
  )
  if (opened.store) {
    f.store = opened.store
    await assert.rejects(commit(f, 0, [put('bad', true)], 'escape', 'escape'))
  } else assert(opened.error)
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep')
})

test('journal recovery discards only an unterminated tail and rejects corrupted complete records', async (t) => {
  const f = await setup(t)
  await commit(f, 0, [put('a', 1)])
  await f.store.close()
  const journal = join(f.directory, 'rooms/main/events.ndjson')
  const original = await readFile(journal, 'utf8')
  assert(original.endsWith('\n'))
  await appendFile(journal, '{"uncommitted":')
  f.store = await f.api.openStore(f.directory)
  assert.equal((await f.store.snapshot('main')).revision, 1)
  await commit(f, 1, [put('b', 2)])
  await f.store.close()
  const lines = (await readFile(journal, 'utf8')).trimEnd().split('\n')
  const record = JSON.parse(lines[0])
  assert.equal(typeof record.sha256, 'string')
  record.sha256 = '0'.repeat(64)
  lines[0] = JSON.stringify(record)
  await writeFile(journal, lines.join('\n') + '\n')
  await assert.rejects(f.api.openStore(f.directory), code('CORRUPT'))
})

test('room archives are deterministic, integrity checked and preserve deduplication under rename', async (t) => {
  const f = await setup(t)
  await commit(f, 0, [put('__proto__', ['中文🙂', null])], 'archived')
  await commit(f, 1, [put('second', { nested: true })])
  await f.store.compact('main', { through: 1 })
  const bytes = await f.store.exportRoom('main')
  assert(Buffer.isBuffer(bytes))
  assert.deepEqual(await f.store.exportRoom('main'), bytes)
  await f.store.importRoom('copy', bytes)
  const copied = await f.store.snapshot('copy')
  assert.equal(copied.room, 'copy')
  assert.equal(copied.revision, 2)
  assert.equal(copied.minimumRevision, 1)
  assert.deepEqual(copied.documents, (await f.store.snapshot('main')).documents)
  assert.equal(
    (await commit(f, 0, [put('__proto__', ['中文🙂', null])], 'archived', 'copy')).duplicate,
    true
  )
  assert((await f.store.history('copy', { after: 1 })).every((event) => event.room === 'copy'))
  await assert.rejects(f.store.importRoom('copy', bytes), code('CONFLICT'))
  const bad = Buffer.from(bytes)
  bad[Math.floor(bad.length / 2)] ^= 1
  await assert.rejects(f.store.importRoom('invalid', bad), code('CORRUPT'))
  assert.equal((await f.store.snapshot('invalid')).revision, 0)
})

function worker(t, directory, body) {
  const source = `import {createRequire} from 'node:module';const {openStore}=createRequire(import.meta.url)(${JSON.stringify(entry)});const store=await openStore(process.argv[1]);${body}`
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory], {
    cwd: packageRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (bytes) => {
    stdout += bytes
  })
  child.stderr.on('data', (bytes) => {
    stderr += bytes
  })
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  // 启动错误由等待者读取；提前安装处理器，回收阶段仍保留真实终态。
  void finished.catch(() => {})
  const kill = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  after(t, async () => {
    kill()
    await finished
  })
  return { child, finished, kill, output: () => stdout, errors: () => stderr }
}

test('real SIGKILL during ongoing writes and compaction preserves acknowledged commits', async (t) => {
  const f = await setup(t)
  await f.store.close()
  const child = worker(
    t,
    f.directory,
    `
for(let i=0;i<100000;i++){
  const receipt=await store.transact('main',{clientId:'crash-client',requestId:'crash-'+i,expectedRevision:i,operations:[{op:'put',key:'counter',value:i}]});
  console.log(JSON.stringify({acknowledged:receipt.revision}));
  if(i%8===7)await store.compact('main',{through:receipt.revision-4});
}`
  )
  await until(
    () => child.output().trim().split('\n').length >= 8 || child.child.exitCode !== null,
    'child did not acknowledge commits'
  )
  assert.equal(child.child.exitCode, null, child.errors())
  await assert.rejects(f.api.openStore(f.directory), code('LOCKED'))
  child.kill()
  assert.equal((await child.finished).signal, 'SIGKILL')
  const acknowledgements = child
    .output()
    .split('\n')
    .slice(0, -1)
    .filter(Boolean)
    .map((line) => JSON.parse(line).acknowledged)
  assert(acknowledgements.length >= 8)
  const acknowledged = Math.max(...acknowledgements)
  f.store = await f.api.openStore(f.directory)
  const recovered = await f.store.snapshot('main')
  assert(recovered.revision >= acknowledged, `Lost acknowledged revision ${acknowledged}`)
  assert.equal(documents(recovered).counter, recovered.revision - 1)
  assert.equal(
    (await f.store.transact('main', transaction(0, [put('counter', 0)], 'crash-0', 'crash-client')))
      .duplicate,
    true
  )
  assert.deepEqual(
    (await f.store.history('main', { after: recovered.minimumRevision })).map(
      (event) => event.revision
    ),
    Array.from(
      { length: recovered.revision - recovered.minimumRevision },
      (_, i) => recovered.minimumRevision + i + 1
    )
  )
})

const tokens = {
  read: 'roomsync-read-fixture-42',
  write: 'roomsync-write-fixture-42',
  admin: 'roomsync-admin-fixture-42',
}
async function server(t, options = {}) {
  const f = await setup(t, options.storeOptions)
  const handle = await f.api.createServer({
    store: f.store,
    host: '127.0.0.1',
    port: 0,
    tokens,
    ...options.serverOptions,
  })
  let closing
  const close = () => (closing ??= Promise.resolve().then(() => handle.close()))
  after(t, close)
  return { ...f, handle, close, url: new URL(handle.url).origin }
}
async function request(f, method, path, role, body) {
  const response = await fetch(new URL(path, f.url), {
    method,
    headers: {
      ...(role ? { Authorization: `Bearer ${tokens[role] ?? role}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: JSON.parse(text), text }
}

test('HTTP health is public while data APIs require bearer authentication', async (t) => {
  const f = await server(t)
  assert.deepEqual((await request(f, 'GET', '/health')).body, { ok: true })
  for (const token of [undefined, 'invalid']) {
    const result = await request(f, 'GET', '/api/rooms/main', token)
    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'AUTH')
    for (const value of Object.values(tokens)) assert(!result.text.includes(value))
    assert(!result.text.includes(f.directory))
  }
  assert.equal((await request(f, 'GET', '/api/rooms/main', 'read')).body.revision, 0)
})

test('HTTP roles enforce write and admin boundaries without partial effects', async (t) => {
  const f = await server(t)
  const tx = transaction(0, [put('one', 1)])
  const denied = await request(f, 'POST', '/api/rooms/main/transactions', 'read', tx)
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error.code, 'PERMISSION')
  assert.equal(
    (await request(f, 'POST', '/api/rooms/main/transactions', 'write', tx)).body.revision,
    1
  )
  assert.equal(
    (await request(f, 'POST', '/api/rooms/main/compact', 'write', { through: 1 })).status,
    403
  )
  assert.equal(
    (await request(f, 'POST', '/api/rooms/main/compact', 'admin', { through: 1 })).status,
    200
  )
  assert.equal((await request(f, 'GET', '/api/rooms/main/events?after=0', 'read')).status, 410)
  assert.deepEqual(
    (await request(f, 'GET', '/api/rooms/main/events?after=1', 'read')).body.events,
    []
  )
})

test('HTTP malformed inputs, conflicts and byte limits have structured statuses', async (t) => {
  const f = await server(t, { storeOptions: { maxTransactionBytes: 256 } })
  assert.equal((await request(f, 'POST', '/api/rooms/main/transactions', 'write', '{')).status, 400)
  assert.equal(
    (await request(f, 'GET', '/api/rooms/main/events?after=not-a-number', 'read')).status,
    400
  )
  assert.equal(
    (
      await request(
        f,
        'POST',
        '/api/rooms/main/transactions',
        'write',
        transaction(0, [put('large', 'x'.repeat(1000))])
      )
    ).status,
    413
  )
  assert.equal((await f.store.snapshot('main')).revision, 0)
  await commit(f, 0, [put('first', 1)])
  const conflict = await request(
    f,
    'POST',
    '/api/rooms/main/transactions',
    'write',
    transaction(0, [put('other', 2)], 'other')
  )
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'CONFLICT')
  assert.equal(conflict.body.error.currentRevision, 1)
})

test('HTTP archive transfer preserves room state and validates imports before writing', async (t) => {
  const f = await server(t)
  await commit(f, 0, [put('document', { unicode: '中文🙂' })])
  const response = await fetch(f.url + '/api/rooms/main/archive', {
    headers: { Authorization: `Bearer ${tokens.read}` },
  })
  assert.equal(response.status, 200)
  const bytes = await response.arrayBuffer()
  const send = (room, role, body) =>
    fetch(f.url + `/api/rooms/${room}/archive`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens[role]}`,
        'Content-Type': 'application/octet-stream',
      },
      body,
    })
  assert.equal((await send('copy', 'write', bytes)).status, 403)
  const imported = await send('copy', 'admin', bytes)
  assert.equal(imported.status, 200)
  assert.equal((await imported.json()).room, 'copy')
  assert.deepEqual(
    (await f.store.snapshot('copy')).documents,
    (await f.store.snapshot('main')).documents
  )
  assert.equal((await send('invalid', 'admin', Buffer.from('corrupt archive'))).status, 400)
  assert.equal((await f.store.snapshot('invalid')).revision, 0)
})

async function socket(t, f, role = 'write', afterRevision = 0) {
  const WebSocket = require('./index.js')
  const connection = new WebSocket(f.url.replace(/^http/u, 'ws') + '/sync')
  const messages = []
  let closed
  connection.on('message', (data) => messages.push(JSON.parse(data.toString())))
  connection.on('close', (code) => {
    closed = code
  })
  const opened = new Promise((resolve, reject) => {
    connection.once('open', resolve)
    connection.once('error', reject)
  })
  after(t, async () => {
    connection.terminate()
    await until(() => closed !== undefined, 'socket failed to close')
  })
  await opened
  connection.send(
    JSON.stringify({
      type: 'hello',
      token: tokens[role] ?? role,
      room: 'main',
      after: afterRevision,
    })
  )
  const next = async (predicate) => {
    await until(
      () => messages.some(predicate) || closed !== undefined,
      'WebSocket response was not delivered'
    )
    const found = messages.find(predicate)
    assert(found, `Connection closed with ${closed} before expected frame`)
    return found
  }
  return {
    connection,
    messages,
    next,
    send: (value) => connection.send(JSON.stringify(value)),
    closed: () => closed,
  }
}

test('WebSocket welcome and live commits expose each revision once', async (t) => {
  const f = await server(t)
  await commit(f, 0, [put('before', 1)])
  const client = await socket(t, f)
  const welcome = await client.next((message) => message.type === 'welcome')
  assert.equal(welcome.snapshot.revision, 1)
  assert.equal(welcome.reset, false)
  assert.deepEqual(
    welcome.events.map((event) => event.revision),
    [1]
  )
  client.send({ type: 'transaction', id: 'wire-1', transaction: transaction(1, [put('after', 2)]) })
  assert.equal(
    (await client.next((message) => message.type === 'ack' && message.id === 'wire-1')).receipt
      .revision,
    2
  )
  assert.equal((await client.next((message) => message.type === 'event')).event.revision, 2)
  assert.equal(client.messages.filter((message) => message.type === 'event').length, 1)
})

test('WebSocket reconnect resets stale cursors and replays retained history', async (t) => {
  const f = await server(t)
  for (let i = 0; i < 3; i++) await commit(f, i, [put('counter', i)])
  await f.store.compact('main', { through: 2 })
  const stale = await socket(t, f, 'read', 0)
  const reset = await stale.next((message) => message.type === 'welcome')
  assert.equal(reset.reset, true)
  assert.equal(reset.snapshot.revision, 3)
  assert.deepEqual(reset.events, [])
  const current = await socket(t, f, 'read', 2)
  const replay = await current.next((message) => message.type === 'welcome')
  assert.equal(replay.reset, false)
  assert.deepEqual(
    replay.events.map((event) => event.revision),
    [3]
  )
})

test('WebSocket read-only requests and duplicate writes cannot change state twice', async (t) => {
  const f = await server(t)
  const read = await socket(t, f, 'read')
  await read.next((message) => message.type === 'welcome')
  read.send({ type: 'transaction', id: 'denied', transaction: transaction(0, [put('x', 1)]) })
  assert.equal(
    (await read.next((message) => message.type === 'error' && message.id === 'denied')).code,
    'PERMISSION'
  )
  const write = await socket(t, f)
  await write.next((message) => message.type === 'welcome')
  const tx = transaction(0, [put('x', 1)], 'deduplicated')
  write.send({ type: 'transaction', id: 'first', transaction: tx })
  await write.next((message) => message.type === 'ack' && message.id === 'first')
  write.send({ type: 'transaction', id: 'retry', transaction: tx })
  assert.equal(
    (await write.next((message) => message.type === 'ack' && message.id === 'retry')).receipt
      .duplicate,
    true
  )
  assert.equal((await f.store.snapshot('main')).revision, 1)
})

test('server close releases connected clients while leaving its caller-owned store usable', async (t) => {
  const f = await server(t)
  const client = await socket(t, f)
  await client.next((message) => message.type === 'welcome')
  await f.close()
  await until(() => client.closed() !== undefined, 'server left an active client')
  assert.equal((await commit(f, 0, [put('still-owned', true)])).revision, 1)
})

test('a commit racing WebSocket hello is represented exactly once across replay and live events', async (t) => {
  const f = await server(t)
  for (let i = 0; i < 8; i++) {
    const [client] = await Promise.all([
      socket(t, f, 'read', i),
      commit(f, i, [put('counter', i)], `handoff-${i}`),
    ])
    const welcome = await client.next((message) => message.type === 'welcome')
    await until(
      () =>
        [
          ...welcome.events,
          ...client.messages.filter((m) => m.type === 'event').map((m) => m.event),
        ].some((event) => event.revision === i + 1),
      'racing revision was omitted'
    )
    await pause(20)
    const revisions = [
      ...welcome.events,
      ...client.messages.filter((m) => m.type === 'event').map((m) => m.event),
    ].map((event) => event.revision)
    assert.equal(revisions.filter((revision) => revision === i + 1).length, 1)
    assert(welcome.snapshot.revision >= i && welcome.snapshot.revision <= i + 1)
    client.connection.terminate()
    await until(() => client.closed() !== undefined, 'race fixture socket still open')
  }
})

test('WebSocket authentication and binary frame rejection leave durable state unchanged', async (t) => {
  const f = await server(t)
  const denied = await socket(t, f, 'wrong-token')
  await until(
    () => denied.closed() !== undefined || denied.messages.some((m) => m.type === 'error'),
    'unauthorized socket was neither rejected nor closed'
  )
  assert(!denied.messages.some((m) => m.type === 'welcome' || m.type === 'event'))
  const writer = await socket(t, f)
  await writer.next((m) => m.type === 'welcome')
  writer.connection.send(
    Buffer.from(
      JSON.stringify({
        type: 'transaction',
        id: 'binary',
        transaction: transaction(0, [put('binary', true)]),
      })
    )
  )
  await until(
    () => writer.closed() !== undefined || writer.messages.some((m) => m.type === 'error'),
    'binary frame was not rejected'
  )
  assert.equal((await f.store.snapshot('main')).revision, 0)
})

test('WebSocket rejects an unapproved browser origin before returning room data', async (t) => {
  const f = await server(t)
  const WebSocket = require('./index.js')
  const connection = new WebSocket(f.url.replace(/^http/u, 'ws') + '/sync', {
    origin: 'https://untrusted.invalid',
  })
  const messages = []
  let closed = false,
    error
  connection.on('error', (value) => {
    error = value
  })
  connection.on('close', () => {
    closed = true
  })
  connection.on('message', (bytes) => messages.push(JSON.parse(bytes.toString())))
  connection.on('open', () =>
    connection.send(JSON.stringify({ type: 'hello', token: tokens.read, room: 'main', after: 0 }))
  )
  after(t, async () => {
    connection.terminate()
    await until(() => closed, 'origin fixture did not close')
  })
  await until(
    () => closed || error || messages.some((m) => m.type === 'error'),
    'unapproved origin was not rejected'
  )
  assert(!messages.some((m) => m.type === 'welcome' || m.type === 'event'))
})

test('a paused slow WebSocket consumer is disconnected without blocking durable writes', async (t) => {
  const f = await server(t, { serverOptions: { maxPendingBytes: 1024 } })
  const client = await socket(t, f, 'read')
  await client.next((m) => m.type === 'welcome')
  client.connection._socket.pause()
  try {
    const body = 'x'.repeat(400000)
    for (let i = 0; i < 64; i++) await commit(f, i, [put('large', { i, body })], `slow-${i}`)
  } finally {
    client.connection._socket?.resume()
  }
  await until(
    () => client.closed() !== undefined,
    'slow consumer retained an unbounded outgoing queue',
    8000
  )
  assert.equal((await f.store.snapshot('main')).revision, 64)
})

function storage() {
  const values = new Map()
  return {
    values,
    getItem: (key) => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  }
}
function roomClient(t, f, options = {}) {
  const changes = []
  const client = new f.api.RoomClient({
    url: f.url,
    token: tokens.write,
    room: 'main',
    clientId: 'client-fixture',
    WebSocket: require('./index.js'),
    onChange: (value) => changes.push(value),
    ...options,
  })
  after(t, () => client.close())
  return { client, changes }
}

test('RoomClient queues offline, serializes default revisions and applies live events once', async (t) => {
  const f = await server(t)
  const { client } = roomClient(t, f)
  const first = client.submit([put('a', { value: 1 })], { requestId: 'offline-a' })
  const second = client.submit([put('b', [2])], { requestId: 'offline-b' })
  void first.catch(() => {})
  void second.catch(() => {})
  await until(() => client.pending().length === 2, 'offline edits were not queued')
  assert.equal((await f.store.snapshot('main')).revision, 0)
  assert.deepEqual(
    client.pending().map((p) => p.transaction.expectedRevision),
    [0, 1]
  )
  await client.connect()
  assert.deepEqual(
    (await Promise.all([first, second])).map((receipt) => receipt.revision),
    [1, 2]
  )
  await until(
    () => client.pending().length === 0 && client.snapshot().revision === 2,
    'client did not settle its queue'
  )
  await commit(f, 2, [put('remote', true)], 'external')
  await until(() => client.snapshot().revision === 3, 'live commit did not reach client')
  const snapshot = client.snapshot()
  mutateCopy(() => {
    snapshot.documents[0].value.value = 99
  })
  assert.equal(documents(client.snapshot()).a.value, 1)
})

test('RoomClient persists pending edits across close, with scoped storage and no saved token', async (t) => {
  const f = await server(t)
  const saved = storage()
  const { client } = roomClient(t, f, { storage: saved })
  const pending = client.submit([put('durable-queue', '中文🙂')], { requestId: 'persisted' })
  const settled = pending.then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  await until(
    () => client.pending().length === 1 && saved.values.size > 0,
    'queue was not persisted'
  )
  await client.close()
  assert.equal((await settled).error?.code, 'CLOSED')
  assert(
    !JSON.stringify([...saved.values]).includes(tokens.write),
    'token leaked to persistent storage'
  )
  const other = roomClient(t, f, { storage: saved, clientId: 'different-client' }).client
  assert.deepEqual(other.pending(), [])
  const restored = roomClient(t, f, { storage: saved }).client
  assert.equal(restored.pending()[0].requestId, 'persisted')
  await restored.connect()
  await until(
    () => restored.pending().length === 0 && restored.snapshot().revision === 1,
    'restored outbox did not replay'
  )
  assert.equal(documents(await f.store.snapshot('main'))['durable-queue'], '中文🙂')
  assert.equal((await f.store.history('main')).length, 1)
})

test('RoomClient exposes conflicts and requires explicit retry with a fresh request ID', async (t) => {
  const f = await server(t)
  const { client, changes } = roomClient(t, f)
  const attempted = client.submit([put('local', 'mine')], {
    requestId: 'conflicting',
    expectedRevision: 0,
  })
  const settled = attempted.then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  await commit(f, 0, [put('remote', 'theirs')], 'remote-writer')
  await client.connect()
  assert.equal((await settled).error?.code, 'CONFLICT')
  await until(() => client.pending()[0]?.status === 'conflict', 'conflict was not visible')
  const original = client.pending()[0]
  assert.equal(original.requestId, 'conflicting')
  mutateCopy(() => {
    original.transaction.operations[0].value = 'mutated copy'
  })
  assert.equal((await f.store.snapshot('main')).revision, 1)
  assert(changes.length > 0, 'onChange never reported any state')
  await client.resolve('conflicting', { action: 'retry', expectedRevision: 1 })
  await until(
    () => client.pending().length === 0 && client.snapshot().revision === 2,
    'explicit retry did not settle'
  )
  const history = await f.store.history('main')
  assert.notEqual(history[1].requestId, 'conflicting')
  assert.deepEqual(documents(await f.store.snapshot('main')), { local: 'mine', remote: 'theirs' })
})

test('RoomClient can discard a conflict without overwriting another writer', async (t) => {
  const f = await server(t)
  const { client } = roomClient(t, f)
  const pending = client.submit([put('document', 'stale')], {
    requestId: 'discard-me',
    expectedRevision: 0,
  })
  void pending.catch(() => {})
  await commit(f, 0, [put('document', 'current')])
  await client.connect()
  await until(() => client.pending()[0]?.status === 'conflict', 'conflict missing')
  await client.resolve('discard-me', { action: 'discard' })
  assert.deepEqual(client.pending(), [])
  assert.equal(documents(await f.store.snapshot('main')).document, 'current')
  await assert.rejects(client.resolve('missing', { action: 'discard' }), code('INVALID'))
})

test('RoomClient reconnects after a real lost acknowledgement without duplicating a commit', async (t) => {
  const f = await server(t)
  const WebSocket = require('./index.js')
  let dropped = false
  class AckDropSocket extends WebSocket {
    emit(name, ...args) {
      if (name === 'message' && !dropped) {
        const message = JSON.parse(args[0].toString())
        if (message.type === 'ack') {
          dropped = true
          this.terminate()
          return true
        }
      }
      return super.emit(name, ...args)
    }
  }
  const { client } = roomClient(t, f, { WebSocket: AckDropSocket, storage: storage() })
  await client.connect()
  const pending = client.submit([put('one-write', true)], { requestId: 'lost-ack' })
  void pending.catch(() => {})
  await until(() => dropped, 'server never sent acknowledgement')
  const receipt = await pending
  assert.equal(receipt.revision, 1)
  assert.equal(receipt.duplicate, true)
  await until(() => client.pending().length === 0, 'acknowledged replay still pending', 8000)
  assert.equal((await f.store.snapshot('main')).revision, 1)
  assert.equal((await f.store.history('main')).length, 1)
})

test('browser ESM client works in real Chromium with CSP, offline replay and conflicts', async (t) => {
  feature()
  const assetServer = httpServer((request, response) => {
    void (async () => {
      const path = decodeURIComponent(new URL(request.url, 'http://local').pathname)
      if (path === '/') {
        response.setHeader('Content-Type', 'text/html')
        response.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*"
        )
        response.end('<!doctype html><title>RoomSync browser acceptance</title>')
      } else {
        const file = resolve(packageRoot, '.' + path)
        assert(file.startsWith(packageRoot + '/'))
        response.setHeader('Content-Type', 'text/javascript')
        response.end(await readFile(file))
      }
    })().catch(() => {
      response.statusCode = 404
      response.end()
    })
  })
  await new Promise((resolve, reject) => {
    assetServer.once('error', reject)
    assetServer.listen(0, '127.0.0.1', resolve)
  })
  after(
    t,
    () =>
      new Promise((resolve, reject) =>
        assetServer.close((error) => (error ? reject(error) : resolve()))
      )
  )
  const origin = `http://127.0.0.1:${assetServer.address().port}`
  const f = await server(t, { serverOptions: { allowedOrigins: [origin] } })
  const browser = await require('@playwright/test').chromium.launch({ headless: true })
  after(t, () => browser.close())
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(origin)
  const result = await page.evaluate(
    async ({ url, token }) => {
      const { RoomClient } = await import('/browser.mjs')
      const changes = []
      const a = new RoomClient({
        url,
        token,
        room: 'main',
        clientId: 'browser-a',
        storage: localStorage,
        onChange: (event) => changes.push(event),
      })
      const b = new RoomClient({
        url,
        token,
        room: 'main',
        clientId: 'browser-b',
        storage: localStorage,
      })
      const wait = async (predicate) => {
        const end = Date.now() + 6000
        while (!predicate()) {
          if (Date.now() > end) throw Error('browser state did not settle')
          await new Promise((r) => setTimeout(r, 10))
        }
      }
      try {
        const pending = b.submit([{ op: 'put', key: 'local', value: 'queued' }], {
          requestId: 'browser-conflict',
          expectedRevision: 0,
        })
        const rejected = pending.then(
          () => null,
          (error) => error.code
        )
        await a.connect()
        const receipt = await a.submit(
          [
            {
              op: 'put',
              key: '<img src=x onerror=alert(1)>',
              value: { text: '<script>bad()</script>' },
            },
          ],
          { requestId: 'browser-first' }
        )
        await b.connect()
        const conflict = await rejected
        await wait(() => b.pending()[0]?.status === 'conflict')
        await b.resolve('browser-conflict', { action: 'retry', expectedRevision: 1 })
        await wait(() => b.pending().length === 0 && a.snapshot().revision === 2)
        return {
          receipt,
          conflict,
          snapshot: b.snapshot(),
          stored: Object.keys(localStorage).map((key) => localStorage.getItem(key)),
          nodeGlobals: typeof process,
          changes: changes.length,
        }
      } finally {
        await a.close()
        await b.close()
      }
    },
    { url: f.url, token: tokens.write }
  )
  assert.equal(result.receipt.revision, 1)
  assert.equal(result.conflict, 'CONFLICT')
  assert.equal(result.snapshot.revision, 2)
  assert.equal(result.nodeGlobals, 'undefined')
  assert(result.changes > 0)
  assert(!JSON.stringify(result.stored).includes(tokens.write))
  assert.deepEqual(errors, [])
  assert.equal((await f.store.history('main')).length, 2)
})

test('offline UI supports a real labeled document edit and renders hostile text safely', async (t) => {
  const f = await server(t)
  const browser = await require('@playwright/test').chromium.launch({ headless: true })
  after(t, () => browser.close())
  const page = await browser.newPage()
  const external = [],
    errors = [],
    dialogs = []
  const watch = (current) => {
    current.on('request', (request) => {
      if (
        /^https?:/u.test(request.url()) &&
        new URL(request.url()).origin !== new URL(f.url).origin
      )
        external.push(request.url())
    })
    current.on('pageerror', (error) => errors.push(error.message))
    current.on('dialog', (dialog) => {
      dialogs.push(dialog.message())
      void dialog.dismiss()
    })
  }
  watch(page)
  await page.goto(f.url)
  await page.getByLabel('Token', { exact: true }).fill(tokens.admin)
  await page.getByLabel('Room', { exact: true }).fill('main')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByLabel('Document key', { exact: true }).fill('<img src=x onerror=alert(42)>')
  await roomJsonEditor(page).fill(JSON.stringify({ text: '<script>alert(43)</script>' }))
  await page.getByRole('button', { name: 'Save document', exact: true }).click()
  await until(
    async () => (await f.store.snapshot('main')).revision === 1,
    'UI did not commit document'
  )
  const viewer = await browser.newPage()
  watch(viewer)
  await viewer.goto(f.url)
  await viewer.getByLabel('Token', { exact: true }).fill(tokens.admin)
  await viewer.getByLabel('Room', { exact: true }).fill('main')
  await viewer.getByRole('button', { name: 'Connect', exact: true }).click()
  await readRoomDocument(viewer, '<img src=x onerror=alert(42)>', '<script>alert(43)</script>')
  assert.equal(await page.locator('img[onerror]').count(), 0)
  assert.equal(await viewer.locator('img[onerror]').count(), 0)
  assert.deepEqual(dialogs, [])
  assert.deepEqual(external, [])
  assert.deepEqual(errors, [])
})

function command(t, args, cwd) {
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  void done.catch(() => {})
  const signal = (name) => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, name)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
  }
  after(t, async () => {
    signal('SIGKILL')
    await done
  })
  return { child, done, signal, output: () => stdout, errors: () => stderr }
}

test('CLI serves from an external cwd and gracefully drains before lock reuse', async (t) => {
  const f = await setup(t)
  await f.store.close()
  const tokensPath = join(f.root, 'tokens.json')
  await writeFile(tokensPath, JSON.stringify(tokens))
  const cli = join(packageRoot, 'bin/roomsync.js')
  const help = await runCapturedCommand(process.execPath, [cli, '--help'], {
    cwd: f.root,
    timeout: 5000,
  })
  assert.equal(help.exitCode, 0, help.stderr)
  assert.match(help.stdout, /serve/u)
  const child = command(
    t,
    [cli, 'serve', '--directory', f.directory, '--tokens-file', tokensPath, '--port', '0'],
    f.root
  )
  await until(
    () => child.output().includes('\n') || child.child.exitCode !== null,
    'CLI did not become ready'
  )
  const ready = JSON.parse(child.output().split('\n')[0])
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+\/?$/u)
  const receipt = await request(
    { url: ready.url },
    'POST',
    '/api/rooms/main/transactions',
    'write',
    transaction(0, [put('cli', 'acknowledged')])
  )
  assert.equal(receipt.status, 200)
  child.signal('SIGTERM')
  const result = await child.done
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout.trim().split('\n').length, 1)
  assert(!result.stdout.includes(tokens.admin) && !result.stderr.includes(tokens.admin))
  f.store = await f.api.openStore(f.directory)
  assert.equal(documents(await f.store.snapshot('main')).cli, 'acknowledged')
})

test('packed CJS, ESM and TypeScript consumers run outside the checkout with real ws', async (t) => {
  const f = await setup(t)
  const consumer = join(f.root, 'consumer'),
    packs = join(f.root, 'packs')
  await mkdir(consumer)
  await mkdir(packs)
  await safePackPackage({
    packageDirectory: process.cwd(),
    filename: join(packs, 'ws.tgz'),
    timeoutMs: 15000,
  })
  await safePackPackage({
    packageDirectory: packageRoot,
    filename: join(packs, 'roomsync.tgz'),
    timeoutMs: 15000,
  })
  const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(typeof metadata.name, 'string')
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: { ws: 'file:../packs/ws.tgz', [metadata.name]: 'file:../packs/roomsync.tgz' },
    })
  )
  const install = await runCapturedCommand(
    'npm',
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'],
    { cwd: consumer, timeout: 20000 }
  )
  assert.equal(install.exitCode, 0, install.stderr)
  const script = `import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';const require=createRequire(import.meta.url);const cjs=require(${JSON.stringify(metadata.name)});const esm=await import(${JSON.stringify(metadata.name)});for(const key of ['openStore','createServer','RoomClient']){assert.equal(typeof cjs[key],'function');assert.equal(typeof esm[key],'function')}const root=await mkdtemp(join(tmpdir(),'consumer-store-'));let store,server,client;try{store=await esm.openStore(root);server=await esm.createServer({store,tokens:{read:'read',write:'write',admin:'admin'}});client=new esm.RoomClient({url:server.url,token:'write',room:'main',clientId:'consumer',WebSocket:require('ws')});await client.connect();const receipt=await client.submit([{op:'put',key:'packed',value:true}]);assert.equal(receipt.revision,1);console.log('external-consumer-passed')}finally{await client?.close();await server?.close();await store?.close();await rm(root,{recursive:true,force:true})}`
  await writeFile(join(consumer, 'consumer.mjs'), script)
  const result = await runCapturedCommand(process.execPath, ['consumer.mjs'], {
    cwd: consumer,
    timeout: 10000,
  })
  assert.equal(result.exitCode, 0, result.stderr)
  assert.match(result.stdout, /external-consumer-passed/u)
  await writeFile(
    join(consumer, 'consumer.mts'),
    `import {openStore,createServer,RoomClient} from ${JSON.stringify(metadata.name)};const store=await openStore('./state',{maxDocumentBytes:1024});const snapshot=await store.snapshot('main');const revision:number=snapshot.revision;await store.transact('main',{clientId:'types',requestId:'one',expectedRevision:revision,operations:[{op:'put',key:'a',value:1}]});const server=await createServer({store,tokens:{read:'r',write:'w',admin:'a'}});const client=new RoomClient({url:server.url,token:'w',room:'main',clientId:'types'});await client.connect();await client.close();await server.close();await store.close();`
  )
  const typecheck = await runCapturedCommand(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--lib',
      'ES2022,DOM',
      '--typeRoots',
      resolve('node_modules/@types'),
      join(consumer, 'consumer.mts'),
    ],
    { cwd: consumer, timeout: 10000 }
  )
  assert.equal(typecheck.exitCode, 0, typecheck.stdout + typecheck.stderr)
}, 60000)

test('delivery contains maintained tests, operational documentation and a runnable offline example', async (t) => {
  const f = await setup(t)
  const readme = await readFile(join(packageRoot, 'README.md'), 'utf8')
  const documentation = [readme]
  for (const file of await readdir(packageRoot, { withFileTypes: true }))
    if (file.isFile() && /\.md$/iu.test(file.name) && file.name !== 'README.md')
      documentation.push(await readFile(join(packageRoot, file.name), 'utf8'))
  if (existsSync(join(packageRoot, 'docs'))) {
    for (const path of await readdir(join(packageRoot, 'docs'), { recursive: true }))
      if (/\.md$/iu.test(path))
        documentation.push(await readFile(join(packageRoot, 'docs', path), 'utf8'))
  }
  for (const term of ['openStore', 'RoomClient', 'archive', 'conflict'])
    assert(
      documentation.join('\n').toLowerCase().includes(term.toLowerCase()),
      `Documentation missing ${term}`
    )
  assert.match(documentation.join('\n'), /SIGKILL|kill\s+-9|crash|recover/iu)
  assert(
    (await readdir(join(packageRoot, 'test'), { recursive: true })).some((name) =>
      /\.(?:[cm]?js|ts)$/u.test(name)
    ),
    'maintained tests missing'
  )
  const result = await runCapturedCommand(
    process.execPath,
    [join(packageRoot, 'examples/offline-demo.js')],
    { cwd: f.root, timeout: 10000 }
  )
  assert.equal(result.exitCode, 0, result.stderr)
})
