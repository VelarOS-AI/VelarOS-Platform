// 用途：独立验收完整本地备份产品的内容完整性、进程恢复、归档边界和持久服务合同。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { createRequire } from 'node:module'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import nodeTest from 'node:test'
import { pathToFileURL } from 'node:url'

const packageRoot = resolve('contrib/workspace-vault')
const cleanupStacks = new WeakMap()
const test = (name, body) =>
  nodeTest(name, { timeout: 45000 }, (t) => {
    const stack = []
    cleanupStacks.set(t, stack)
    // Node 的 after 按注册顺序执行；依赖目录的服务器和进程必须先关闭。
    t.after(async () => {
      const errors = []
      for (const cleanup of stack.reverse()) {
        try {
          await cleanup()
        } catch (error) {
          errors.push(error)
        }
      }
      cleanupStacks.delete(t)
      if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed')
    })
    return body(t)
  })
const after = (t, cleanup) => cleanupStacks.get(t).push(cleanup)
const entry = join(packageRoot, 'index.js')
const require = createRequire(pathToFileURL(join(process.cwd(), 'package.json')))
const digest = (value) => createHash('sha256').update(value).digest('hex')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
function feature() {
  assert(existsSync(entry), 'Workspace Vault public API must exist')
  const api = require(entry)
  assert.equal(typeof api.createVault, 'function')
  assert.equal(typeof api.createServer, 'function')
  return api
}
async function setup(t) {
  const api = feature()
  const root = await mkdtemp(join(tmpdir(), 'vault-accept-'))
  after(t, () => rm(root, { recursive: true, force: true }))
  const store = join(root, 'vault'),
    source = join(root, 'source'),
    destination = join(root, 'restored')
  await mkdir(source)
  await mkdir(join(source, 'empty'))
  await writeFile(join(source, 'hello.txt'), 'first version\n')
  await writeFile(join(source, 'binary'), Buffer.from([0, 255, 1, 128, 10]))
  const vault = await api.createVault(store)
  return { api, root, store, source, destination, vault }
}
async function tree(root) {
  const out = {}
  async function walk(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const full = join(directory, name),
        path = prefix + name,
        info = await lstat(full)
      if (info.isSymbolicLink()) out[path] = { type: 'symlink', target: await readlink(full) }
      else if (info.isDirectory()) {
        out[path] = { type: 'directory', mode: info.mode & 0o777 }
        await walk(full, path + '/')
      } else
        out[path] = {
          type: 'file',
          mode: info.mode & 0o777,
          data: (await readFile(full)).toString('base64'),
        }
    }
  }
  if (existsSync(root)) await walk(root)
  return out
}
const code =
  (...codes) =>
  (e) =>
    codes.includes(e.code)
async function bounded(value, milliseconds = 2500) {
  let timer
  try {
    return await Promise.race([
      value,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Operation did not settle within its bound')),
          milliseconds
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
function child(t, source, args = []) {
  const processHandle = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let stdout = '',
    stderr = ''
  processHandle.stdout.on('data', (data) => {
    stdout += data
  })
  processHandle.stderr.on('data', (data) => {
    stderr += data
  })
  const done = new Promise((res, rej) => {
    processHandle.once('error', rej)
    processHandle.once('close', (status, signal) => res({ status, signal, stdout, stderr }))
  })
  // 在注册清理前挂上拒绝处理，启动失败不能成为未处理拒绝。
  done.catch(() => {})
  const kill = () => {
    try {
      process.kill(-processHandle.pid, 'SIGKILL')
    } catch (e) {
      if (e.code !== 'ESRCH') throw e
    }
  }
  after(t, async () => {
    kill()
    await bounded(done, 3000).catch(() => {})
  })
  return { process: processHandle, done, kill, output: () => stdout }
}
const workerPrefix = `import {createRequire} from 'node:module';const {createVault}=createRequire(import.meta.url)(${JSON.stringify(entry)});`
async function ready(worker) {
  const end = Date.now() + 10000
  while (!worker.output().includes('\n')) {
    if (worker.process.exitCode !== null)
      throw new Error('Worker exited before progress: ' + JSON.stringify(await worker.done))
    if (Date.now() > end) throw new Error('Worker did not report progress')
    await sleep(15)
  }
  return JSON.parse(worker.output().split('\n')[0])
}
async function server(t, f) {
  const token = 'vault-test-token-with-special-42'
  const handle = await f.api.createServer({
    vault: f.vault,
    host: '127.0.0.1',
    port: 0,
    token,
    allowedRoots: [f.root],
  })
  let closed
  const close = () => (closed ??= Promise.resolve().then(() => handle.close()))
  after(t, close)
  const request = async (path, body, extra = {}) =>
    fetch(handle.url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8000),
    })
  return { ...handle, close, request, token }
}
async function waitJob(s, id) {
  for (let i = 0; i < 100; i++) {
    const res = await s.request('/api/jobs/' + id)
    assert.equal(res.status, 200)
    const job = await res.json()
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job
    await sleep(25)
  }
  throw new Error('Local job did not finish')
}
async function bundle(f) {
  const snapshot = await f.vault.snapshot(f.source)
  const path = join(f.root, 'export.ndjson')
  await f.vault.exportSnapshot(snapshot.id, path)
  return {
    snapshot,
    path,
    records: (await readFile(path, 'utf8')).trimEnd().split('\n').map(JSON.parse),
  }
}
async function badImport(f, records) {
  const path = join(f.root, 'malformed.ndjson')
  await writeFile(path, records.map((x) => JSON.stringify(x)).join('\n') + '\n')
  const before = await tree(f.store)
  await assert.rejects(f.vault.importSnapshot(path), code('ERR_VAULT_CORRUPT', 'ERR_VAULT_INVALID'))
  assert.deepEqual(await tree(f.store), before, 'Failed import must not alter existing stored data')
}

test('Workspace Vault public API must exist', feature)
test('package exports, canonical manifests, hash identity and deduplication', async (t) => {
  const f = await setup(t),
    before = await tree(f.source)
  const a = await f.vault.snapshot(f.source, { label: 'first' }),
    b = await f.vault.snapshot(f.source, { label: 'latest' })
  assert.equal(a.version, 1)
  assert.equal(a.id, b.id)
  assert.equal(a.id, digest(JSON.stringify(a.entries)))
  assert.deepEqual(
    a.entries.map((x) => x.path),
    a.entries.map((x) => x.path).sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)))
  )
  assert.equal(
    a.entries.find((x) => x.path === 'binary').hash,
    digest(Buffer.from([0, 255, 1, 128, 10]))
  )
  assert.deepEqual(await tree(f.source), before)
  const list = await f.vault.listSnapshots()
  assert.equal(list.length, 1)
  assert.equal(list[0].label, 'latest')
  assert.equal((await f.vault.getSnapshot(a.id)).id, a.id)
  const esm = await import(pathToFileURL(join(packageRoot, 'index.mjs')))
  assert.equal(esm.createVault, f.api.createVault)
  assert.equal(esm.createServer, f.api.createServer)
  const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(metadata.name, 'workspace-vault')
  assert.equal(metadata.version, '1.0.0')
  assert.deepEqual(metadata.dependencies ?? {}, {})
})
test('binary, empty directory, permissions and unusual names restore exactly', async (t) => {
  const f = await setup(t)
  await writeFile(join(f.source, '引号 "\n executable'), '#!/bin/sh\nexit 0\n')
  await chmod(join(f.source, '引号 "\n executable'), 0o751)
  await symlink('hello.txt', join(f.source, 'relative'))
  await symlink('missing-target', join(f.source, 'dangling'))
  const a = await f.vault.snapshot(f.source)
  const result = await f.vault.restore(a.id, f.destination)
  assert.equal(result.status, 'completed')
  assert.equal(result.snapshotId, a.id)
  assert.equal(result.completedOperations, result.totalOperations)
  assert.deepEqual(await tree(f.destination), await tree(f.source))
})
test('exclude prefixes do not accidentally exclude similarly named entries', async (t) => {
  const f = await setup(t)
  await mkdir(join(f.source, 'cache'))
  await writeFile(join(f.source, 'cache/private'), 'private')
  await writeFile(join(f.source, 'cache-file'), 'keep')
  const a = await f.vault.snapshot(f.source, { exclude: ['cache', 'binary'] })
  assert(
    !a.entries.some((x) => x.path === 'cache' || x.path.startsWith('cache/') || x.path === 'binary')
  )
  assert(a.entries.some((x) => x.path === 'cache-file'))
})
test('root aliases and store overlap are rejected before writes', async (t) => {
  const f = await setup(t)
  await symlink(f.store, join(f.root, 'alias'))
  await assert.rejects(f.vault.snapshot(f.root), code('ERR_VAULT_INVALID'))
  await assert.rejects(f.vault.snapshot(join(f.root, 'alias')), code('ERR_VAULT_INVALID'))
  const a = await f.vault.snapshot(f.source)
  await assert.rejects(f.vault.restore(a.id, join(f.store, 'inside')), code('ERR_VAULT_INVALID'))
})
test('dry run predicts operations while preserving destination and journal', async (t) => {
  const f = await setup(t),
    a = await f.vault.snapshot(f.source),
    journalPath = join(f.root, 'journal.json')
  const before = await tree(f.root)
  const result = await f.vault.restore(a.id, f.destination, { dryRun: true, journalPath })
  assert.equal(result.status, 'planned')
  assert.equal(result.completedOperations, 0)
  assert(result.operations.some((x) => x.path === 'hello.txt' && x.action === 'copy'))
  assert.deepEqual(await tree(f.root), before)
})
test('mirror, no-op timestamps and file-directory replacement', async (t) => {
  const f = await setup(t),
    a = await f.vault.snapshot(f.source)
  await f.vault.restore(a.id, f.destination)
  const before = (await stat(join(f.destination, 'hello.txt'))).mtimeMs
  const noOp = await f.vault.restore(a.id, f.destination)
  assert.equal(noOp.totalOperations, 0)
  assert.equal((await stat(join(f.destination, 'hello.txt'))).mtimeMs, before)
  await writeFile(join(f.destination, 'extra'), 'keep')
  await rm(join(f.destination, 'empty'), { recursive: true })
  await writeFile(join(f.destination, 'empty'), 'old')
  await f.vault.restore(a.id, f.destination)
  assert.equal(await readFile(join(f.destination, 'extra'), 'utf8'), 'keep')
  await f.vault.restore(a.id, f.destination, { mirror: true })
  assert.deepEqual(await tree(f.destination), await tree(f.source))
})
test('error and skip conflict policies preserve user changes', async (t) => {
  const f = await setup(t),
    a = await f.vault.snapshot(f.source)
  await mkdir(f.destination)
  await writeFile(join(f.destination, 'hello.txt'), 'local')
  const before = await tree(f.destination)
  await assert.rejects(
    f.vault.restore(a.id, f.destination, { conflict: 'error' }),
    code('ERR_VAULT_CONFLICT')
  )
  assert.deepEqual(await tree(f.destination), before)
  await f.vault.restore(a.id, f.destination, { conflict: 'skip' })
  assert.equal(await readFile(join(f.destination, 'hello.txt'), 'utf8'), 'local')
  assert.deepEqual(await readFile(join(f.destination, 'binary')), Buffer.from([0, 255, 1, 128, 10]))
})
test('destination ancestor symlinks never redirect writes', async (t) => {
  const f = await setup(t),
    outside = join(f.root, 'outside'),
    a = await f.vault.snapshot(f.source)
  await mkdir(outside)
  await writeFile(join(outside, 'sentinel'), 'protected')
  await mkdir(f.destination)
  await symlink(outside, join(f.destination, 'empty'))
  const before = await tree(outside)
  try {
    await f.vault.restore(a.id, f.destination)
  } catch (error) {
    assert(code('ERR_VAULT_INVALID', 'ERR_VAULT_CONFLICT')(error))
  }
  assert.deepEqual(await tree(outside), before)
})
test('diff tracks content, membership and executable mode changes', async (t) => {
  const f = await setup(t),
    a = await f.vault.snapshot(f.source)
  await writeFile(join(f.source, 'hello.txt'), 'next')
  await rm(join(f.source, 'binary'))
  await writeFile(join(f.source, 'new'), 'new')
  await chmod(join(f.source, 'empty'), 0o700)
  const b = await f.vault.snapshot(f.source),
    changes = await f.vault.diff(a.id, b.id)
  assert.deepEqual(changes.added, ['new'])
  assert.deepEqual(changes.removed, ['binary'])
  assert.deepEqual(changes.modified, ['empty', 'hello.txt'])
})
test('corrupt object verification and whole-plan preflight prevent partial writes', async (t) => {
  const f = await setup(t),
    a = await f.vault.snapshot(f.source),
    file = a.entries.find((x) => x.path === 'hello.txt')
  await writeFile(join(f.store, 'objects', file.hash), 'corrupted')
  const verification = await f.vault.verify(a.id)
  assert.equal(verification.ok, false)
  assert(verification.errors.some((x) => x.hash === file.hash || x.path === 'hello.txt'))
  await mkdir(f.destination)
  await writeFile(join(f.destination, 'sentinel'), 'stay')
  const before = await tree(f.destination)
  await assert.rejects(f.vault.restore(a.id, f.destination), code('ERR_VAULT_CORRUPT'))
  assert.deepEqual(await tree(f.destination), before)
})
test('missing blobs and missing snapshots produce useful errors', async (t) => {
  const f = await setup(t),
    a = await f.vault.snapshot(f.source),
    file = a.entries.find((x) => x.type === 'file')
  await rm(join(f.store, 'objects', file.hash))
  assert.equal((await f.vault.verify(a.id)).ok, false)
  await assert.rejects(f.vault.getSnapshot('f'.repeat(64)), code('ERR_VAULT_NOT_FOUND'))
  await assert.rejects(f.vault.getSnapshot('../outside'), code('ERR_VAULT_INVALID'))
})
test('pre-aborted operations preserve reason and make no filesystem changes', async (t) => {
  const f = await setup(t),
    a = await f.vault.snapshot(f.source),
    abort = new AbortController(),
    reason = { stop: 'exact' }
  abort.abort(reason)
  const before = await tree(f.root)
  await assert.rejects(f.vault.snapshot(f.source, { signal: abort.signal }), (e) => e === reason)
  await assert.rejects(
    f.vault.restore(a.id, f.destination, { signal: abort.signal }),
    (e) => e === reason
  )
  assert.deepEqual(await tree(f.root), before)
})
test('progress errors commit only the reported boundary and resume without replay', async (t) => {
  const f = await setup(t),
    a = await f.vault.snapshot(f.source),
    journalPath = join(f.root, 'journal.json'),
    reason = { stop: 1 }
  const first = []
  await assert.rejects(
    f.vault.restore(a.id, f.destination, {
      journalPath,
      onProgress(e) {
        first.push(e)
        throw reason
      },
    }),
    (e) => e === reason
  )
  assert.equal(first.length, 1)
  const record = JSON.parse(await readFile(journalPath, 'utf8'))
  assert.equal(record.snapshotId, a.id)
  assert(record.completed.includes(first[0].operationIndex))
  const later = []
  const done = await f.vault.restore(a.id, f.destination, {
    journalPath,
    onProgress: (e) => later.push(e),
  })
  assert.equal(done.status, 'completed')
  assert.equal(later.length, done.totalOperations - 1)
  assert(!later.some((x) => x.operationIndex === first[0].operationIndex))
  assert.deepEqual(await tree(f.destination), await tree(f.source))
})
test('pending progress cancellation settles and consumes late rejection', async (t) => {
  const f = await setup(t),
    a = await f.vault.snapshot(f.source),
    controller = new AbortController(),
    reason = { abort: 42 }
  let lateReject,
    callbacks = 0
  const promise = f.vault.restore(a.id, f.destination, {
    signal: controller.signal,
    onProgress() {
      callbacks++
      controller.abort(reason)
      return new Promise((_, reject) => {
        lateReject = reject
      })
    },
  })
  await assert.rejects(bounded(promise), (e) => e === reason)
  assert.equal(callbacks, 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  const after = await tree(f.destination)
  lateReject?.(new Error('late callback rejection'))
  await sleep(25)
  assert.deepEqual(await tree(f.destination), after)
})
test('completed journal is idempotent and rejects modified committed outputs', async (t) => {
  const f = await setup(t),
    a = await f.vault.snapshot(f.source),
    journalPath = join(f.root, 'journal.json')
  await f.vault.restore(a.id, f.destination, { journalPath })
  const before = (await stat(join(f.destination, 'hello.txt'))).mtimeMs
  await f.vault.restore(a.id, f.destination, {
    journalPath,
    onProgress() {
      assert.fail('No progress replay')
    },
  })
  assert.equal((await stat(join(f.destination, 'hello.txt'))).mtimeMs, before)
  await writeFile(join(f.destination, 'hello.txt'), 'user edit')
  await assert.rejects(
    f.vault.restore(a.id, f.destination, { journalPath }),
    code('ERR_VAULT_CONFLICT')
  )
  assert.equal(await readFile(join(f.destination, 'hello.txt'), 'utf8'), 'user edit')
})
test('journal overlap, symlink files and unrelated data fail before restore', async (t) => {
  const f = await setup(t),
    a = await f.vault.snapshot(f.source),
    target = join(f.root, 'other.json')
  await writeFile(target, '{"unrelated":true}')
  const journalPath = join(f.root, 'linked-journal')
  await symlink(target, journalPath)
  for (const path of [
    journalPath,
    target,
    join(f.store, 'journal'),
    join(f.destination, 'journal'),
  ]) {
    await assert.rejects(f.vault.restore(a.id, f.destination, { journalPath: path }))
    assert(!existsSync(f.destination))
  }
  assert.equal(await readFile(target, 'utf8'), '{"unrelated":true}')
})
test('real SIGKILL at a durable boundary resumes from a new process', async (t) => {
  const f = await setup(t),
    a = await f.vault.snapshot(f.source),
    journalPath = join(f.root, 'journal.json')
  const w = child(
    t,
    workerPrefix +
      `const v=await createVault(process.argv[1]);await v.restore(process.argv[2],process.argv[3],{journalPath:process.argv[4],onProgress(e){console.log(JSON.stringify(e));return new Promise(()=>{setInterval(()=>{},1000)})}});`,
    [f.store, a.id, f.destination, journalPath]
  )
  const event = await ready(w)
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  assert(journal.completed.includes(event.operationIndex))
  w.kill()
  assert.equal((await bounded(w.done)).signal, 'SIGKILL')
  const next = child(
    t,
    workerPrefix +
      `const v=await createVault(process.argv[1]);console.log(JSON.stringify(await v.restore(process.argv[2],process.argv[3],{journalPath:process.argv[4]})));`,
    [f.store, a.id, f.destination, journalPath]
  )
  const result = await bounded(next.done, 12000)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await tree(f.destination), await tree(f.source))
})
test('bundle chunks, duplicate objects, empty files and binary data round-trip', async (t) => {
  const f = await setup(t),
    bytes = Buffer.alloc(196615)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 251
  await writeFile(join(f.source, 'large'), bytes)
  await writeFile(join(f.source, 'duplicate'), bytes)
  await writeFile(join(f.source, 'zero'), '')
  const b = await bundle(f)
  assert.equal(b.records[0].type, 'header')
  assert.equal(b.records[0].format, 'workspace-vault')
  assert.equal(b.records.at(-1).type, 'end')
  for (const row of b.records.slice(1, -1)) {
    assert.equal(row.type, 'chunk')
    assert(Buffer.from(row.data, 'base64').length <= 65536)
  }
  const v = await f.api.createVault(join(f.root, 'other-vault')),
    imported = await v.importSnapshot(b.path)
  assert.equal(imported.id, b.snapshot.id)
  await v.restore(imported.id, f.destination)
  assert.deepEqual(await tree(f.destination), await tree(f.source))
})
test('truncated and unsupported bundles leave the target vault unchanged', async (t) => {
  const f = await setup(t),
    b = await bundle(f)
  await badImport(f, b.records.slice(0, -1))
  const copy = structuredClone(b.records)
  copy[0].version = 99
  await badImport(f, copy)
  await badImport(f, [...b.records, { type: 'chunk', hash: 'a'.repeat(64), offset: 0, data: '' }])
})
test('bundle corruption, offset mismatch and unsafe paths are rejected', async (t) => {
  const f = await setup(t),
    b = await bundle(f)
  for (const mutation of [
    (records) => {
      records.find((x) => x.type === 'chunk').data = '!!!not base64'
    },
    (records) => {
      records.find((x) => x.type === 'chunk').offset = 9
    },
    (records) => {
      const m = records[0].snapshot
      m.entries[0].path = '../escape'
      m.id = digest(JSON.stringify(m.entries))
    },
  ]) {
    const copy = structuredClone(b.records)
    mutation(copy)
    await badImport(f, copy)
  }
  assert(!existsSync(join(f.root, 'escape')))
})
test('prune keeps shared blobs and dry-run is read-only', async (t) => {
  const f = await setup(t),
    a = await f.vault.snapshot(f.source)
  await writeFile(join(f.source, 'hello.txt'), 'second')
  const b = await f.vault.snapshot(f.source)
  const before = await tree(f.store),
    plan = await f.vault.prune({ keep: [b.id], dryRun: true })
  assert.deepEqual(plan.removedSnapshots, [a.id])
  assert.deepEqual(await tree(f.store), before)
  const result = await f.vault.prune({ keep: [b.id] })
  assert.deepEqual(result, plan)
  assert.deepEqual(
    (await f.vault.listSnapshots()).map((x) => x.id),
    [b.id]
  )
  assert.equal((await f.vault.verify()).ok, true)
  await assert.rejects(
    f.vault.prune({ keep: ['f'.repeat(64)] }),
    code('ERR_VAULT_NOT_FOUND', 'ERR_VAULT_INVALID')
  )
})
test('parallel processes retain both snapshots and leave no corrupt objects', async (t) => {
  const f = await setup(t),
    other = join(f.root, 'other-source')
  await mkdir(other)
  await writeFile(join(other, 'different'), 'second process')
  const source =
    workerPrefix +
    `const v=await createVault(process.argv[1]);for(let i=0;i<30;i++){try{console.log(JSON.stringify(await v.snapshot(process.argv[2])));break}catch(e){if(e.code!=='ERR_VAULT_BUSY'||i===29)throw e;await new Promise(r=>setTimeout(r,20))}}`
  const workers = [child(t, source, [f.store, f.source]), child(t, source, [f.store, other])]
  const results = await bounded(Promise.all(workers.map((x) => x.done)), 15000)
  for (const result of results) assert.equal(result.status, 0, result.stderr)
  const reopened = await f.api.createVault(f.store)
  assert.equal((await reopened.listSnapshots()).length, 2)
  assert.equal((await reopened.verify()).ok, true)
})
test('CLI JSON, external cwd, failures and ESM consumption', async (t) => {
  const f = await setup(t),
    cli = join(packageRoot, 'bin/workspace-vault.js')
  const command = async (args) => {
    const w = child(
      t,
      `import {spawnSync} from 'node:child_process';const r=spawnSync(process.execPath,process.argv.slice(1),{cwd:${JSON.stringify(f.root)},encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1);`,
      [cli, '--store', f.store, ...args]
    )
    return bounded(w.done, 10000)
  }
  const made = await command(['snapshot', f.source, '--label', 'CLI label'])
  assert.equal(made.status, 0, made.stderr)
  const snapshot = JSON.parse(made.stdout)
  const listed = await command(['list'])
  assert.equal(listed.status, 0, listed.stderr)
  assert(JSON.parse(listed.stdout).some((x) => x.id === snapshot.id))
  const invalid = await command(['get', '../invalid'])
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /ERR_VAULT_/u)
})
test('server loopback policy, authentication and path admission', async (t) => {
  const f = await setup(t)
  await assert.rejects(
    f.api.createServer({
      vault: f.vault,
      host: '0.0.0.0',
      port: 0,
      token: 'x',
      allowedRoots: [f.root],
    })
  )
  const s = await server(t, f)
  assert.equal((await fetch(s.url + '/health')).status, 200)
  assert.equal((await fetch(s.url + '/api/snapshots?token=' + s.token)).status, 401)
  assert.equal((await s.request('/api/jobs', { type: 'snapshot', source: '/' })).status, 400)
  assert.equal((await s.request('/api/jobs/not-found')).status, 404)
  assert.equal(
    (await s.request('/api/snapshots', undefined, { authorization: 'Bearer wrong' })).status,
    401
  )
})
test('durable jobs, equivalent idempotency replay and conflicting keys', async (t) => {
  const f = await setup(t),
    s = await server(t, f),
    body = { type: 'snapshot', source: f.source, label: 'HTTP label' }
  const response = await s.request('/api/jobs', body, { 'idempotency-key': 'stable-operation' })
  assert.equal(response.status, 202)
  const submitted = await response.json()
  assert.equal(typeof submitted.id, 'string')
  const replay = await s.request(
    '/api/jobs',
    { label: 'HTTP label', source: f.source, type: 'snapshot' },
    { 'idempotency-key': 'stable-operation' }
  )
  assert([200, 202].includes(replay.status))
  assert.equal((await replay.json()).id, submitted.id)
  assert.equal(
    (
      await s.request(
        '/api/jobs',
        { ...body, label: 'different' },
        { 'idempotency-key': 'stable-operation' }
      )
    ).status,
    409
  )
  const completed = await waitJob(s, submitted.id)
  assert.equal(completed.status, 'completed', JSON.stringify(completed))
  const snapshots = await (await s.request('/api/snapshots')).json()
  assert(snapshots.some((x) => x.label === 'HTTP label'))
})
test('SSE terminal replay respects event cursors and closes', async (t) => {
  const f = await setup(t),
    s = await server(t, f)
  const job = await (await s.request('/api/jobs', { type: 'snapshot', source: f.source })).json()
  assert.equal((await waitJob(s, job.id)).status, 'completed')
  const res = await s.request('/api/jobs/' + job.id + '/events?after=0')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/u)
  const text = await bounded(res.text(), 4000)
  const ids = [...text.matchAll(/^id:\s*(\d+)\s*$/gm)].map((x) => Number(x[1]))
  assert(ids.length > 0)
  assert(ids.every((x, i) => x > 0 && (i === 0 || x > ids[i - 1])))
  for (const line of text.split('\n').filter((x) => x.startsWith('data:')))
    JSON.parse(line.slice(5).trim())
  const replay = await (
    await s.request('/api/jobs/' + job.id + '/events?after=' + ids.at(-1))
  ).text()
  assert(!/^id:/mu.test(replay))
})
test('server reopen retains completed job history and idempotency keys', async (t) => {
  const f = await setup(t),
    s = await server(t, f),
    body = { type: 'snapshot', source: f.source }
  const submitted = await (
    await s.request('/api/jobs', body, { 'idempotency-key': 'restart-key' })
  ).json()
  assert.equal((await waitJob(s, submitted.id)).status, 'completed')
  await s.close()
  f.vault = await f.api.createVault(f.store)
  const reopened = await server(t, f)
  assert.equal(
    (await (await reopened.request('/api/jobs/' + submitted.id)).json()).status,
    'completed'
  )
  const replay = await reopened.request('/api/jobs', body, { 'idempotency-key': 'restart-key' })
  assert([200, 202].includes(replay.status))
  assert.equal((await replay.json()).id, submitted.id)
  await reopened.request('/api/jobs/' + submitted.id + '/cancel', {})
  assert.equal(
    (await (await reopened.request('/api/jobs/' + submitted.id)).json()).status,
    'completed'
  )
})
test('offline dashboard, release documentation and maintained tests are present', async (t) => {
  const f = await setup(t),
    s = await server(t, f)
  const response = await fetch(s.url + '/'),
    html = await response.text()
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/html/u)
  assert.match(html, /<(?:input|button|form)\b/iu)
  assert(!/<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//iu.test(html))
  for (const name of ['README.md', 'DESIGN.md', 'CHANGELOG.md', 'VALIDATION.md']) {
    const text = await readFile(join(packageRoot, name), 'utf8')
    assert(text.trim().length > 100, name)
  }
  assert((await readdir(join(packageRoot, 'test'))).some((x) => /\.(?:js|mjs|cjs)$/u.test(x)))
  const w = child(
    t,
    `await import(${JSON.stringify(pathToFileURL(join(packageRoot, 'examples/backup-and-recover.js')).href)});`
  )
  const result = await bounded(w.done, 20000)
  assert.equal(result.status, 0, result.stderr)
})
