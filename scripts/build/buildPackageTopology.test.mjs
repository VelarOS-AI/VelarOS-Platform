import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

function diagnostic(result) {
  return [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n')
}

function succeeded(result) {
  assert.equal(result.error, undefined, diagnostic(result))
  assert.equal(result.status, 0, diagnostic(result))
  return result.stdout
}

async function fixture(t, { build = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'build-proof-'))
  const workers = []
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.terminate()))
    await rm(root, { recursive: true, force: true })
  })
  const runner = join(root, 'scripts/build/buildPackageTopology.mjs')
  await mkdir(dirname(runner), { recursive: true })
  await copyFile(new URL('./buildPackageTopology.mjs', import.meta.url), runner)
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  for (const name of ['core', 'app']) {
    const directory = join(root, 'packages', name)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: `@velaros-ai/${name}`,
        scripts: { build: 'node build.mjs' },
        dependencies: name === 'app' ? { '@velaros-ai/core': 'workspace:*' } : {},
      })
    )
    await writeFile(join(directory, 'source.js'), `export const name = '${name}'`)
    await writeFile(
      join(directory, 'build.mjs'),
      `import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
copyFileSync('source.js', 'dist/index.js');
appendFileSync('../../order.log', ${JSON.stringify(`${name}\n`)});
`
    )
  }
  const run = (...args) =>
    spawnSync(process.execPath, [runner, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
  if (build) succeeded(run())
  const { withVerifiedPackageBuilds } = await import(pathToFileURL(runner).href)
  return {
    root,
    runner,
    workers,
    run,
    lock: join(root, '.velaros-workspace/package-build.lock'),
    cache: join(root, '.velaros-workspace/package-build-cache-v1.json'),
    order: async () => (await readFile(join(root, 'order.log'), 'utf8')).trim().split('\n'),
    verify: (consume = async (proof) => proof) => withVerifiedPackageBuilds(['app'], consume),
  }
}

async function resourceFixture(t) {
  const f = await fixture(t, { build: false })
  const directory = join(f.root, 'packages/resources')
  await mkdir(directory)
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: '@velaros-ai/resources',
      files: ['SKILL.md'],
      dependencies: { '@velaros-ai/core': 'workspace:*' },
    })
  )
  await writeFile(join(directory, 'SKILL.md'), '# Source-only resource')
  const appManifest = join(f.root, 'packages/app/package.json')
  const manifest = JSON.parse(await readFile(appManifest, 'utf8'))
  await writeFile(
    appManifest,
    JSON.stringify({ ...manifest, dependencies: { '@velaros-ai/resources': 'workspace:*' } })
  )
  succeeded(f.run('--for', 'app'))
  return f
}

async function lockOwner(path) {
  const entries = await readdir(path)
  assert.equal(entries.length, 1)
  const [name] = entries
  assert.match(name, /\.owner$/u)
  return { name, pid: Number((await readFile(join(path, name), 'utf8')).trim()) }
}

async function seedLock(f, pid) {
  await mkdir(f.lock, { recursive: true })
  const path = join(f.lock, `${randomUUID()}.owner`)
  await writeFile(path, `${pid}\n`)
  return path
}

function deadPid() {
  return Number(
    succeeded(
      spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
      })
    )
  )
}

// 只在真实 worker 内拦截文件系统边界；生产 runner 没有测试端口或等待分支。
function verifierWorker(f, phase, code) {
  const control = new Int32Array(new SharedArrayBuffer(4))
  const ready = Promise.withResolvers()
  const finished = Promise.withResolvers()
  let complete = false
  const worker = new Worker(
    String.raw`
const fs = require('node:fs');
const { dirname } = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const control = new Int32Array(workerData.control);
process.argv = [process.execPath];
let paused = false;
function pause(path) {
  if (paused) return;
  paused = true;
  parentPort.postMessage({ type: 'ready', path });
  if (Atomics.wait(control, 0, 0, 15000) === 'timed-out') throw new Error('Fixture barrier timed out');
}
if (workerData.phase === 'before-publish') {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === workerData.lock) pause(from); return rename(from, to); };
} else if (workerData.phase === 'stale-unlink') {
  const unlink = fs.unlinkSync;
  fs.unlinkSync = path => { if (dirname(path) === workerData.lock) pause(path); return unlink(path); };
} else if (workerData.phase === 'before-rmdir') {
  const rmdir = fs.rmdirSync;
  fs.rmdirSync = path => { if (path === workerData.lock) pause(path); return rmdir(path); };
} else if (workerData.phase === 'process-error') {
  process.kill = () => { throw Object.assign(new Error('Fixture PID query failed'), { code: workerData.code }); };
}
syncBuiltinESMExports();
function describe(error) {
  return { message: error.message, code: error.code, errors: error.errors?.map(describe) };
}
(async () => {
  try {
    const { withVerifiedPackageBuilds } = await import(workerData.runner);
    await withVerifiedPackageBuilds(['app'], () => {
      if (workerData.phase === 'held') pause(workerData.lock);
    });
    parentPort.postMessage({ type: 'finished', ok: true });
  } catch (error) {
    parentPort.postMessage({ type: 'finished', ok: false, error: describe(error) });
  } finally {
    parentPort.close();
  }
})();
`,
    {
      eval: true,
      workerData: {
        control: control.buffer,
        phase,
        code,
        lock: f.lock,
        runner: pathToFileURL(f.runner).href,
      },
    }
  )
  f.workers.push(worker)
  ready.promise.catch(() => {})
  finished.promise.catch(() => {})
  worker.on('message', (message) => {
    if (message.type === 'ready') ready.resolve(message)
    else {
      complete = true
      ready.reject(new Error(`Worker ended before its barrier: ${JSON.stringify(message)}`))
      finished.resolve(message)
    }
  })
  worker.on('error', (error) => {
    ready.reject(error)
    finished.reject(error)
  })
  worker.on('exit', (status) => {
    if (!complete) {
      const error = new Error(`Verifier worker exited without a result: ${status}`)
      ready.reject(error)
      finished.reject(error)
    }
  })
  return {
    ready: ready.promise,
    finished: finished.promise,
    resume: () => {
      Atomics.store(control, 0, 1)
      Atomics.notify(control, 0)
    },
  }
}

function holdProof(f) {
  let release
  const finished = f.verify(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  finished.catch(() => {})
  assert.equal(typeof release, 'function')
  return { release, finished }
}

test('pack proof verifies the real build dependency closure and excludes concurrent builds', async (t) => {
  const f = await fixture(t)
  const proof = await f.verify(async (proof) => {
    assert.equal((await lockOwner(f.lock)).pid, process.pid)
    await assert.rejects(f.verify(), /正在运行/)
    return proof
  })
  assert.deepEqual(Object.keys(proof), ['@velaros-ai/core', '@velaros-ai/app'])
  assert.match(proof['@velaros-ai/app'].outputFingerprint, /^[a-f0-9]{64}$/)
  await assert.rejects(readdir(f.lock), { code: 'ENOENT' })
})

test('source-only resource dependencies prove real inputs without invented outputs or cache entries', async (t) => {
  const f = await resourceFixture(t)
  const proof = await f.verify(async (proof) => {
    const owner = await lockOwner(f.lock)
    assert.equal(owner.pid, process.pid)
    await assert.rejects(f.verify(), /正在运行/u)
    const concurrent = f.run('--incremental', '--for', 'app')
    assert.notEqual(concurrent.status, 0, diagnostic(concurrent))
    assert.match(diagnostic(concurrent), /正在运行/u)
    assert.deepEqual(await lockOwner(f.lock), owner)
    return proof
  })
  assert.deepEqual(Object.keys(proof), [
    '@velaros-ai/core',
    '@velaros-ai/resources',
    '@velaros-ai/app',
  ])
  assert.deepEqual(Object.keys(proof['@velaros-ai/resources']), ['inputFingerprint'])
  assert.match(proof['@velaros-ai/resources'].inputFingerprint, /^[a-f0-9]{64}$/u)
  const cache = JSON.parse(await readFile(f.cache, 'utf8'))
  assert.equal(Object.hasOwn(cache.packages, '@velaros-ai/resources'), false)
  for (const name of ['@velaros-ai/core', '@velaros-ai/app']) {
    assert.deepEqual(proof[name], cache.packages[name])
    assert.match(proof[name].outputFingerprint, /^[a-f0-9]{64}$/u)
  }
  await assert.rejects(readdir(join(f.root, 'packages/resources/dist')), { code: 'ENOENT' })
  await assert.rejects(readdir(f.lock), { code: 'ENOENT' })

  await rm(join(f.root, 'packages/app/dist'), { recursive: true })
  await assert.rejects(f.verify(), /Stale or unverified build for @velaros-ai\/app/u)
  await assert.rejects(readdir(f.lock), { code: 'ENOENT' })
})

test('resource inputs participate in incremental and transitive dependency fingerprints', async (t) => {
  const f = await resourceFixture(t)
  const before = await f.verify()
  assert.deepEqual(await f.order(), ['core', 'app'])
  succeeded(f.run('--incremental', '--for', 'app'))
  assert.deepEqual(await f.order(), ['core', 'app'])

  await writeFile(join(f.root, 'packages/resources/SKILL.md'), '# Changed resource')
  let consumed = false
  await assert.rejects(
    f.verify(() => {
      consumed = true
    }),
    /Stale or unverified build for @velaros-ai\/app/u
  )
  assert.equal(consumed, false)
  succeeded(f.run('--incremental', '--for', 'app'))
  assert.deepEqual(await f.order(), ['core', 'app', 'app'])
  const resourceChanged = await f.verify()
  assert.deepEqual(resourceChanged['@velaros-ai/core'], before['@velaros-ai/core'])
  for (const name of ['@velaros-ai/resources', '@velaros-ai/app']) {
    assert.notEqual(resourceChanged[name].inputFingerprint, before[name].inputFingerprint)
  }

  await writeFile(join(f.root, 'packages/core/source.js'), 'export const changed = true')
  succeeded(f.run('--incremental', '--for', 'app'))
  assert.deepEqual(await f.order(), ['core', 'app', 'app', 'core', 'app'])
  const dependencyChanged = await f.verify()
  for (const name of Object.keys(dependencyChanged)) {
    assert.notEqual(
      dependencyChanged[name].inputFingerprint,
      resourceChanged[name].inputFingerprint
    )
  }
})

test('source-only target mutations during consumption fail the final proof under the same lock', async (t) => {
  const f = await resourceFixture(t)
  const { withVerifiedPackageBuilds } = await import(pathToFileURL(f.runner).href)
  await assert.rejects(
    withVerifiedPackageBuilds(['resources'], async (proof) => {
      const owner = await lockOwner(f.lock)
      assert.deepEqual(Object.keys(proof), ['@velaros-ai/core', '@velaros-ai/resources'])
      await writeFile(join(f.root, 'packages/resources/SKILL.md'), '# Changed while consuming')
      assert.deepEqual(await lockOwner(f.lock), owner)
    }),
    /Build inputs or outputs changed while preparing the candidate/u
  )
  await assert.rejects(readdir(f.lock), { code: 'ENOENT' })
  await assert.rejects(f.verify(), /Stale or unverified build for @velaros-ai\/app/u)
})

test('pack rejects stale source, stale output and changed dependencies', async (t) => {
  for (const changed of [
    'packages/app/source.js',
    'packages/app/dist/index.js',
    'packages/core/source.js',
  ]) {
    await t.test(changed, async (t) => {
      const f = await fixture(t)
      await writeFile(join(f.root, changed), 'changed')
      await assert.rejects(f.verify(), /Stale or unverified build/)
    })
  }
})

test('pack rejects edits during consumption and releases the lock after failure', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    f.verify(async () => {
      await writeFile(join(f.root, 'packages/app/source.js'), 'changed while packing')
    }),
    /Stale or unverified build/
  )
  await assert.rejects(readdir(f.lock), { code: 'ENOENT' })
})

test('incremental builds retain dependency order and rebuild changed dependency closures', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await f.order(), ['core', 'app'])
  succeeded(f.run('--incremental'))
  assert.deepEqual(await f.order(), ['core', 'app'])
  await writeFile(join(f.root, 'packages/core/source.js'), 'export const changed = true')
  succeeded(f.run('--incremental'))
  assert.deepEqual(await f.order(), ['core', 'app', 'core', 'app'])
  await f.verify()
})

test('incremental cache accepts only the complete current map and fingerprint shape', async (t) => {
  const f = await fixture(t)
  const original = JSON.parse(await readFile(f.cache, 'utf8'))
  const entry = original.packages['@velaros-ai/app']
  for (const [name, value] of [
    ['null document', null],
    ['old schema', { ...original, schemaVersion: 0 }],
    ['null packages', { ...original, packages: null }],
    ['array packages', { ...original, packages: [] }],
    ['null entry', { ...original, packages: { '@velaros-ai/app': null } }],
    ['array entry', { ...original, packages: { '@velaros-ai/app': [] } }],
    [
      'invalid fingerprint',
      { ...original, packages: { '@velaros-ai/app': { ...entry, inputFingerprint: 1 } } },
    ],
    [
      'extra entry field',
      { ...original, packages: { '@velaros-ai/app': { ...entry, legacy: true } } },
    ],
  ]) {
    await t.test(name, async () => {
      const before = (await f.order()).length
      await writeFile(f.cache, JSON.stringify(value))
      succeeded(f.run('--incremental'))
      assert.equal((await f.order()).length, before + 2)
      succeeded(f.run('--incremental'))
      assert.equal((await f.order()).length, before + 2)
      await f.verify()
    })
  }
  const before = (await f.order()).length
  await writeFile(f.cache, '{invalid JSON')
  succeeded(f.run('--incremental'))
  assert.equal((await f.order()).length, before + 2)
})

test('cache I/O failure fails explicitly before building and releases the acquired lock', async (t) => {
  const f = await fixture(t)
  const order = await f.order()
  await unlink(f.cache)
  await mkdir(f.cache)
  const result = f.run('--incremental')
  assert.notEqual(result.status, 0, diagnostic(result))
  assert.ok(diagnostic(result).includes(f.cache), diagnostic(result))
  assert.deepEqual(await f.order(), order)
  await assert.rejects(readdir(f.lock), { code: 'ENOENT' })
})

test('invalid manifests fail with their path instead of disappearing from the graph', async (t) => {
  for (const [name, value] of [
    ['malformed JSON', '{'],
    ['null manifest', 'null'],
    ['missing name', '{}'],
    ['nonstring name', '{"name":3}'],
    ['blank name', '{"name":" "}'],
    ['invalid scripts', '{"name":"@velaros-ai/app","scripts":[]}'],
    ['nonstring command', '{"name":"@velaros-ai/app","scripts":{"build":true}}'],
    ['invalid dependencies', '{"name":"@velaros-ai/app","dependencies":null}'],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t, { build: false })
      const path = join(f.root, 'packages/app/package.json')
      await writeFile(path, value)
      const result = f.run()
      assert.notEqual(result.status, 0, diagnostic(result))
      assert.ok(diagnostic(result).includes(path), diagnostic(result))
      await assert.rejects(readFile(join(f.root, 'order.log')), { code: 'ENOENT' })
    })
  }
})

test('duplicate manifest names fail without overwriting either package', async (t) => {
  const f = await fixture(t, { build: false })
  const app = join(f.root, 'packages/app/package.json')
  const core = join(f.root, 'packages/core/package.json')
  const manifest = JSON.parse(await readFile(app, 'utf8'))
  await writeFile(app, JSON.stringify({ ...manifest, name: '@velaros-ai/core' }))
  const result = f.run()
  assert.notEqual(result.status, 0, diagnostic(result))
  assert.ok(diagnostic(result).includes('name 重复'), diagnostic(result))
  assert.ok(diagnostic(result).includes(app), diagnostic(result))
  assert.ok(diagnostic(result).includes(core), diagnostic(result))
})

test('a manifest directory is a real error rather than a package to skip', async (t) => {
  const f = await fixture(t, { build: false })
  const path = join(f.root, 'packages/app/package.json')
  await unlink(path)
  await mkdir(path)
  const result = f.run()
  assert.notEqual(result.status, 0, diagnostic(result))
  assert.ok(diagnostic(result).includes(path), diagnostic(result))
  await assert.rejects(readFile(join(f.root, 'order.log')), { code: 'ENOENT' })
})

test('failed builds do not publish cache proof or leave their lock held', async (t) => {
  const f = await fixture(t, { build: false })
  await writeFile(
    join(f.root, 'packages/core/build.mjs'),
    "throw new Error('fixture build failed')"
  )
  const result = f.run()
  assert.notEqual(result.status, 0, diagnostic(result))
  assert.ok(diagnostic(result).includes('构建失败 @velaros-ai/core'), diagnostic(result))
  await assert.rejects(readFile(f.cache), { code: 'ENOENT' })
  await assert.rejects(readdir(f.lock), { code: 'ENOENT' })
})

test('cycles remain errors and external leaves cannot become verified candidate dependencies', async (t) => {
  const f = await fixture(t, { build: false })
  const path = join(f.root, 'packages/core/package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(
    path,
    JSON.stringify({ ...manifest, dependencies: { '@velaros-ai/app': 'workspace:*' } })
  )
  const cycle = f.run('--list')
  assert.notEqual(cycle.status, 0, diagnostic(cycle))
  assert.ok(diagnostic(cycle).includes('依赖环'), diagnostic(cycle))
  await writeFile(
    path,
    JSON.stringify({ ...manifest, dependencies: { '@velaros-ai/external': '1.0.0' } })
  )
  assert.ok(succeeded(f.run()).includes('外部/预构建依赖（跳过）：@velaros-ai/external'))
  await assert.rejects(f.verify(), /Cannot verify external build dependencies/u)
})

test('flat targets retain scoped names, suffixes and actual directory names', async (t) => {
  const f = await fixture(t, { build: false })
  await rename(join(f.root, 'packages/app'), join(f.root, 'packages/client'))
  for (const target of ['@velaros-ai/app', 'app', 'client']) {
    assert.match(
      succeeded(f.run('--for', target, '--list')),
      /@velaros-ai\/core -> @velaros-ai\/app/u
    )
  }
})

test('a lock publishes its complete owner atomically and cannot replace a concurrent claim', async (t) => {
  const f = await fixture(t)
  const first = verifierWorker(f, 'before-publish')
  const { path } = await first.ready
  assert.equal((await lockOwner(path)).pid, process.pid)
  await assert.rejects(readdir(f.lock), { code: 'ENOENT' })
  const second = holdProof(f)
  try {
    const successor = await lockOwner(f.lock)
    first.resume()
    const result = await first.finished
    assert.equal(result.ok, false)
    assert.match(result.error.message, /正在运行/u)
    await assert.rejects(readdir(path), { code: 'ENOENT' })
    assert.deepEqual(await lockOwner(f.lock), successor)
  } finally {
    second.release()
    await second.finished
  }
})

test('a dead PID lock can be reclaimed while a living owner remains exclusive', async (t) => {
  const f = await fixture(t)
  await seedLock(f, deadPid())
  await f.verify()
  await seedLock(f, process.pid)
  const owner = await lockOwner(f.lock)
  await assert.rejects(f.verify(), /正在运行/u)
  assert.deepEqual(await lockOwner(f.lock), owner)
})

test('malformed and old lock shapes fail without deleting an unknown owner', async (t) => {
  for (const shape of ['file', 'invalid PID', 'unknown entry']) {
    await t.test(shape, async (t) => {
      const f = await fixture(t)
      if (shape === 'file') await writeFile(f.lock, `${process.pid}\n`)
      else {
        const path = await seedLock(f, process.pid)
        if (shape === 'invalid PID') await writeFile(path, '0\n')
        else await writeFile(join(f.lock, 'unowned'), 'unknown')
      }
      const original = shape === 'file' ? await readFile(f.lock) : undefined
      await assert.rejects(f.verify(), /包构建锁/u)
      if (shape === 'file') {
        assert.deepEqual(await readFile(f.lock), original)
        const order = await f.order()
        const result = f.run('--incremental')
        assert.notEqual(result.status, 0, diagnostic(result))
        assert.ok(diagnostic(result).includes('包构建锁不是当前目录格式'), diagnostic(result))
        assert.deepEqual(await readFile(f.lock), original)
        assert.deepEqual(await f.order(), order)
      } else assert.ok((await readdir(f.lock)).length > 0)
    })
  }
})

test('old owner release cannot unlink the successor marker', async (t) => {
  const f = await fixture(t)
  const first = verifierWorker(f, 'held')
  await first.ready
  const old = await lockOwner(f.lock)
  await unlink(join(f.lock, old.name))
  await rmdir(f.lock)
  const second = holdProof(f)
  try {
    const successor = await lockOwner(f.lock)
    assert.notEqual(successor.name, old.name)
    first.resume()
    const result = await first.finished
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'ENOENT')
    assert.deepEqual(await lockOwner(f.lock), successor)
  } finally {
    second.release()
    await second.finished
  }
})

test('old release cannot remove a nonempty successor after unlinking its own marker', async (t) => {
  const f = await fixture(t)
  const first = verifierWorker(f, 'before-rmdir')
  await first.ready
  assert.deepEqual(await readdir(f.lock), [])
  const second = holdProof(f)
  try {
    const successor = await lockOwner(f.lock)
    first.resume()
    assert.equal((await first.finished).ok, true)
    assert.deepEqual(await lockOwner(f.lock), successor)
  } finally {
    second.release()
    await second.finished
  }
})

test('a stale contender cannot delete the new owner published by another contender', async (t) => {
  const f = await fixture(t)
  await seedLock(f, deadPid())
  const first = verifierWorker(f, 'stale-unlink')
  await first.ready
  const second = holdProof(f)
  try {
    const successor = await lockOwner(f.lock)
    first.resume()
    const result = await first.finished
    assert.equal(result.ok, false)
    assert.ok(['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(result.error.code), JSON.stringify(result))
    assert.deepEqual(await lockOwner(f.lock), successor)
  } finally {
    second.release()
    await second.finished
  }
})

test('EPERM and unknown PID query errors never authorize stale-lock deletion', async (t) => {
  const f = await fixture(t)
  await seedLock(f, process.pid)
  const owner = await lockOwner(f.lock)
  for (const code of ['EPERM', 'EIO']) {
    const worker = verifierWorker(f, 'process-error', code)
    const result = await worker.finished
    assert.equal(result.ok, false)
    assert.equal(result.error.code, code)
    assert.deepEqual(await lockOwner(f.lock), owner)
  }
})

test('consumer and lost-lock cleanup errors retain both real causes', async (t) => {
  const f = await fixture(t)
  const primary = new Error('fixture consumer failed')
  await assert.rejects(
    f.verify(async () => {
      const owner = await lockOwner(f.lock)
      await unlink(join(f.lock, owner.name))
      await rmdir(f.lock)
      throw primary
    }),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors[0], primary)
      assert.equal(error.errors[1].code, 'ENOENT')
      return true
    }
  )
})
