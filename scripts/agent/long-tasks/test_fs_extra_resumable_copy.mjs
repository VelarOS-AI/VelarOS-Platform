// 用途：冻结验收真实文件迁移中的计划校验、持久断点、进程退出、取消和双入口交付。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { createRequire } from 'node:module'
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  readlink,
  symlink,
  rm,
  stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const require = createRequire(pathToFileURL(join(process.cwd(), 'package.json')))
const api = require(resolve('lib/index.js'))
const requireFeature = () =>
  assert(api.planCopy && api.applyCopyPlan, 'planCopy and applyCopyPlan must be public')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function bounded(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Operation did not settle after cancellation')),
          1500
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function setup(t) {
  requireFeature()
  const root = await mkdtemp(join(tmpdir(), 'copy-plan-accept-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'),
    destination = join(root, 'destination'),
    journalPath = join(root, 'journal.json')
  await mkdir(source)
  await mkdir(destination)
  await writeFile(join(source, 'a.txt'), 'first')
  await mkdir(join(source, 'nested'))
  await writeFile(join(source, 'nested/b.txt'), 'second')
  return { root, source, destination, journalPath }
}
async function tree(root) {
  const result = {}
  async function walk(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name),
        rel = prefix + name,
        item = await lstat(path)
      if (item.isSymbolicLink()) result[rel] = { link: await readlink(path) }
      else if (item.isDirectory()) {
        result[rel + '/'] = 'directory'
        await walk(path, rel + '/')
      } else result[rel] = (await readFile(path)).toString('base64')
    }
  }
  await walk(root)
  return result
}
const code = (expected) => (error) => error.code === expected
const clone = (value) => JSON.parse(JSON.stringify(value))

test('planCopy and applyCopyPlan must be public', requireFeature)
test('plan is deterministic, serializable and read-only; exports preserve identity', async (t) => {
  const f = await setup(t),
    before = await tree(f.root)
  const first = await api.planCopy(f.source, f.destination),
    second = await api.planCopy(f.source, f.destination)
  assert.equal(first.version, 1)
  assert.match(first.id, /^[a-f0-9]{64}$/u)
  assert.equal(first.source, f.source)
  assert.equal(first.destination, f.destination)
  assert.deepEqual(first, second)
  assert.deepEqual(await tree(f.root), before)
  assert(
    first.operations.some((operation) => operation.path === 'a.txt' && operation.action === 'copy')
  )
  const esm = await import(pathToFileURL(resolve('lib/esm.mjs')))
  for (const name of ['planCopy', 'applyCopyPlan']) {
    assert.equal(esm[name], api[name])
    assert.equal(esm.default[name], api[name])
  }
  const result = await api.applyCopyPlan(clone(first))
  assert.equal(result.planId, first.id)
  assert.equal(result.status, 'completed')
  assert.equal(result.completedOperations, first.operations.length)
  assert.equal(result.totalOperations, first.operations.length)
  assert.deepEqual(await tree(f.source), await tree(f.destination))
})
test('default preserves extras; mirror removes them and supports file-directory replacements', async (t) => {
  const f = await setup(t)
  await writeFile(join(f.destination, 'extra'), 'keep')
  await writeFile(join(f.destination, 'nested'), 'old-file')
  await mkdir(join(f.destination, 'a.txt'))
  await writeFile(join(f.destination, 'a.txt/old'), 'old-child')
  await api.applyCopyPlan(await api.planCopy(f.source, f.destination))
  assert.equal(await readFile(join(f.destination, 'extra'), 'utf8'), 'keep')
  assert.equal(await readFile(join(f.destination, 'a.txt'), 'utf8'), 'first')
  assert.equal(await readFile(join(f.destination, 'nested/b.txt'), 'utf8'), 'second')
  await api.applyCopyPlan(await api.planCopy(f.source, f.destination, { mirror: true }))
  assert.deepEqual(await tree(f.source), await tree(f.destination))
})
test('an absent destination and unusual path names are copied correctly', async (t) => {
  const f = await setup(t)
  await rm(f.destination, { recursive: true })
  await writeFile(join(f.source, '中文 \'quoted\"\nfile.txt'), 'verbatim\u0000bytes')
  await api.applyCopyPlan(await api.planCopy(f.source, f.destination))
  assert.deepEqual(await tree(f.source), await tree(f.destination))
})
test('matching content is left untouched and the source stays unchanged', async (t) => {
  const f = await setup(t)
  await api.applyCopyPlan(await api.planCopy(f.source, f.destination))
  const before = (await stat(join(f.destination, 'a.txt'))).mtimeMs,
    original = await tree(f.source)
  const plan = await api.planCopy(f.source, f.destination)
  assert.equal(plan.operations.length, 0)
  await api.applyCopyPlan(plan)
  assert.equal((await stat(join(f.destination, 'a.txt'))).mtimeMs, before)
  assert.deepEqual(await tree(f.source), original)
})
for (const changed of ['source', 'destination']) {
  test(`stale ${changed} rejects before the first write`, async (t) => {
    const f = await setup(t),
      plan = await api.planCopy(f.source, f.destination)
    await writeFile(join(f[changed], 'a.txt'), 'intervening edit')
    const before = await tree(f.destination)
    await assert.rejects(
      api.applyCopyPlan(plan, { journalPath: f.journalPath }),
      code('ERR_COPY_PLAN_STALE')
    )
    assert.deepEqual(await tree(f.destination), before)
  })
}
test('tampered ids and path traversal reject without modifying either tree', async (t) => {
  const f = await setup(t),
    plan = await api.planCopy(f.source, f.destination)
  const original = await tree(f.root)
  const bad = [
    { ...clone(plan), id: '0'.repeat(64) },
    ...['../escape', '/tmp/escape', 'nested/../../escape'].map((path) => {
      const value = clone(plan)
      value.operations[0].path = path
      return value
    }),
  ]
  for (const value of bad)
    await assert.rejects(api.applyCopyPlan(value), code('ERR_COPY_PLAN_INVALID'))
  assert.deepEqual(await tree(f.root), original)
})
test('overlapping roots and realpath aliases reject', async (t) => {
  const f = await setup(t)
  await symlink(f.source, join(f.root, 'alias'))
  for (const [source, destination] of [
    [f.source, f.source],
    [f.source, join(f.source, 'child')],
    [f.source, join(f.root, 'alias')],
    [f.source, f.root],
  ]) {
    await assert.rejects(api.planCopy(source, destination), code('ERR_COPY_PLAN_INVALID'))
  }
})
test('relative and dangling links stay links; destination redirection cannot escape', async (t) => {
  const f = await setup(t)
  await symlink('a.txt', join(f.source, 'relative'))
  await symlink('../missing', join(f.source, 'dangling'))
  await api.applyCopyPlan(await api.planCopy(f.source, f.destination))
  assert.equal(await readlink(join(f.destination, 'relative')), 'a.txt')
  assert.equal(await readlink(join(f.destination, 'dangling')), '../missing')
  const second = await setup(t),
    outside = join(second.root, 'outside')
  await mkdir(outside)
  const plan = await api.planCopy(second.source, second.destination)
  await symlink(outside, join(second.destination, 'nested'))
  await assert.rejects(api.applyCopyPlan(plan), code('ERR_COPY_PLAN_STALE'))
  assert.deepEqual(await readdir(outside), [])
})
test('callback API matches Promise forms', async (t) => {
  const f = await setup(t)
  const plan = await new Promise((done, fail) =>
    api.planCopy(f.source, f.destination, (error, result) => (error ? fail(error) : done(result)))
  )
  const result = await new Promise((done, fail) =>
    api.applyCopyPlan(plan, { journalPath: f.journalPath }, (error, result) =>
      error ? fail(error) : done(result)
    )
  )
  assert.equal(result.status, 'completed')
  assert.deepEqual(await tree(f.source), await tree(f.destination))
})
test('journal is committed before progress; interruption resumes without duplicate notifications', async (t) => {
  const f = await setup(t),
    plan = await api.planCopy(f.source, f.destination)
  const stop = new Error('operator interrupted'),
    indexes = []
  await assert.rejects(
    api.applyCopyPlan(plan, {
      journalPath: f.journalPath,
      onProgress: async (event) => {
        const journal = JSON.parse(await readFile(f.journalPath, 'utf8'))
        assert.equal(journal.version, 1)
        assert.equal(journal.planId, plan.id)
        assert(journal.completed.includes(event.operationIndex))
        assert.equal(event.completedOperations, 1)
        assert.equal(event.totalOperations, plan.operations.length)
        assert.equal(event.planId, plan.id)
        assert.deepEqual(event.operation, plan.operations[event.operationIndex])
        indexes.push(event.operationIndex)
        throw stop
      },
    }),
    (error) => error === stop
  )
  await api.applyCopyPlan(clone(plan), {
    journalPath: f.journalPath,
    onProgress: (event) => indexes.push(event.operationIndex),
  })
  assert.equal(new Set(indexes).size, plan.operations.length)
  assert.equal(indexes.length, plan.operations.length)
  assert.deepEqual(await tree(f.source), await tree(f.destination))
  const before = (await stat(join(f.destination, 'a.txt'))).mtimeMs
  await api.applyCopyPlan(plan, {
    journalPath: f.journalPath,
    onProgress: () => assert.fail('completed journal must not replay progress'),
  })
  assert.equal((await stat(join(f.destination, 'a.txt'))).mtimeMs, before)
  assert.equal(JSON.parse(await readFile(f.journalPath, 'utf8')).status, 'completed')
})
test('changed committed output and corrupted journal cannot silently resume', async (t) => {
  const f = await setup(t),
    plan = await api.planCopy(f.source, f.destination)
  await api.applyCopyPlan(plan, { journalPath: f.journalPath })
  await writeFile(join(f.destination, 'a.txt'), 'user update')
  await assert.rejects(api.applyCopyPlan(plan, { journalPath: f.journalPath }))
  assert.equal(await readFile(join(f.destination, 'a.txt'), 'utf8'), 'user update')
  await writeFile(f.journalPath, '{broken')
  await assert.rejects(api.applyCopyPlan(plan, { journalPath: f.journalPath }))
  assert.equal(await readFile(f.journalPath, 'utf8'), '{broken')
})
test('journal placement and symlink boundaries are checked before writes', async (t) => {
  const f = await setup(t),
    plan = await api.planCopy(f.source, f.destination),
    original = await tree(f.destination)
  await writeFile(join(f.root, 'unrelated'), 'keep')
  await symlink(join(f.root, 'unrelated'), f.journalPath)
  await symlink(f.root, join(f.root, 'directory-alias'))
  for (const journalPath of [
    join(f.source, 'journal'),
    join(f.destination, 'journal'),
    f.journalPath,
    join(f.root, 'directory-alias/new-journal'),
  ]) {
    await assert.rejects(api.applyCopyPlan(plan, { journalPath }))
  }
  assert.deepEqual(await tree(f.destination), original)
  assert.equal(await readFile(join(f.root, 'unrelated'), 'utf8'), 'keep')
})
test('pre-abort and cancellation during progress preserve exact reasons and resume', async (t) => {
  const f = await setup(t),
    controller = new AbortController(),
    reason = { user: 'cancel' }
  controller.abort(reason)
  await assert.rejects(
    api.planCopy(f.source, f.destination, { signal: controller.signal }),
    (error) => error === reason
  )
  const plan = await api.planCopy(f.source, f.destination)
  await assert.rejects(
    api.applyCopyPlan(plan, { signal: controller.signal }),
    (error) => error === reason
  )
  assert.deepEqual(await readdir(f.destination), [])
  const active = new AbortController()
  let progress = 0
  await assert.rejects(
    api.applyCopyPlan(plan, {
      journalPath: f.journalPath,
      signal: active.signal,
      onProgress: () => {
        progress++
        active.abort(reason)
      },
    }),
    (error) => error === reason
  )
  assert.equal(progress, 1)
  await api.applyCopyPlan(plan, { journalPath: f.journalPath })
  assert.deepEqual(await tree(f.source), await tree(f.destination))
})
test('a process killed after durable progress is resumed by a new process', async (t) => {
  const f = await setup(t),
    plan = await api.planCopy(f.source, f.destination),
    planPath = join(f.root, 'plan.json')
  await writeFile(planPath, JSON.stringify(plan))
  const modulePath = resolve('lib/index.js')
  const script = `const fs=require('node:fs');const api=require(${JSON.stringify(modulePath)});const plan=JSON.parse(fs.readFileSync(${JSON.stringify(planPath)},'utf8'));api.applyCopyPlan(plan,{journalPath:${JSON.stringify(f.journalPath)},onProgress(){process.stdout.write('COMMITTED\\n');return new Promise(()=>{})}}).catch(e=>{console.error(e);process.exitCode=1});setInterval(()=>{},1000);`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise((done) =>
    child.once('exit', (status, signal) => done({ status, signal }))
  )
  let diagnostic = ''
  child.stderr.on('data', (chunk) => {
    diagnostic += chunk
  })
  try {
    await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('No committed progress: ' + diagnostic)), 10000)
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (output.includes('COMMITTED\n')) {
          clearTimeout(timer)
          done()
        }
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        fail(error)
      })
      child.once('exit', () => {
        clearTimeout(timer)
        fail(new Error('Exited before progress: ' + diagnostic))
      })
    })
    child.kill('SIGKILL')
    assert.equal((await exited).signal, 'SIGKILL')
    const before = JSON.parse(await readFile(f.journalPath, 'utf8'))
    assert.equal(before.completed.length, 1)
    const resume = spawnSync(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');require(${JSON.stringify(modulePath)}).applyCopyPlan(JSON.parse(fs.readFileSync(${JSON.stringify(planPath)},'utf8')),{journalPath:${JSON.stringify(f.journalPath)}}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1})`,
      ],
      { encoding: 'utf8', timeout: 15000 }
    )
    assert.equal(resume.status, 0, resume.stdout + resume.stderr)
    assert.equal(JSON.parse(resume.stdout).status, 'completed')
    assert.deepEqual(await tree(f.source), await tree(f.destination))
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited
    }
  }
})
test('aborting a pending async progress callback settles promptly and observes late rejection', async (t) => {
  const f = await setup(t),
    controller = new AbortController(),
    reason = { cancel: 'pending callback' }
  const plan = await api.planCopy(f.source, f.destination, { signal: controller.signal })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  let rejectLate,
    began,
    notifications = 0
  const started = new Promise((done) => {
    began = done
  })
  const applying = api.applyCopyPlan(plan, {
    journalPath: f.journalPath,
    signal: controller.signal,
    onProgress: () => {
      notifications++
      began()
      return new Promise((_, reject) => {
        rejectLate = reject
      })
    },
  })
  const observed = bounded(assert.rejects(applying, (error) => error === reason))
  await bounded(started)
  controller.abort(reason)
  await observed
  const partial = await tree(f.destination)
  rejectLate(new Error('late callback rejection'))
  await delay(10)
  assert.equal(notifications, 1)
  assert.deepEqual(await tree(f.destination), partial)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  await api.applyCopyPlan(plan, { journalPath: f.journalPath })
  assert.deepEqual(await tree(f.source), await tree(f.destination))
})
test('documented offline demonstration runs successfully', async () => {
  requireFeature()
  const example = spawnSync(process.execPath, ['examples/resumable-copy.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 20000,
  })
  assert.equal(example.status, 0, example.stdout + example.stderr)
  const readme = await readFile(resolve('README.md'), 'utf8')
  assert.match(readme, /planCopy/u)
  assert.match(readme, /applyCopyPlan/u)
})
