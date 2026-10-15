// 验证真实归档、还原和资源所有权边界，失败时保留原始材料。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  symlink,
  rm,
  lstat,
  rename,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { gzipSync, gunzipSync } from 'node:zlib'
import {
  acquireTaskResources,
  archiveTaskResources,
  checkTaskResourceBudget,
  checkTaskCopyBudget,
  createTaskProcessGuard,
  monitorTaskResources,
  registerTaskResources,
  restoreResourceArchive,
  verifyResourceArchive,
} from './resource-lifecycle.mjs'
import { copyTaskWorkspace, taskWorkspaceCopyFilter } from './task-environment.mjs'

async function fixture(t, limits) {
  const base = await mkdtemp(join(tmpdir(), 'resource-lifecycle-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'vlr-fixture'),
    output = join(base, 'output')
  await mkdir(root)
  await mkdir(output)
  await mkdir(join(root, 'workspace'))
  await writeFile(join(root, 'workspace', 'script.mjs'), 'export const source = 7\n', {
    mode: 0o755,
  })
  await writeFile(join(root, 'binary'), Buffer.from([0, 255, 8]))
  await symlink('workspace/script.mjs', join(root, 'link'))
  return {
    base,
    root,
    output,
    resource: await registerTaskResources(root, output, { minFreeBytes: 1, ...limits }),
  }
}

test('archive verifies every byte before removing the exclusive root and can restore it', async (t) => {
  const f = await fixture(t)
  const budget = await checkTaskResourceBudget(f.resource)
  assert(budget.bytes > 3)
  const archived = await archiveTaskResources(f.resource)
  await assert.rejects(lstat(f.root), { code: 'ENOENT' })
  const path = join(f.output, 'execution-resources.jsonl.gz')
  assert.deepEqual(await verifyResourceArchive(path), archived)
  const restored = join(f.base, 'restored')
  await restoreResourceArchive(path, restored)
  assert.equal(
    await readFile(join(restored, 'workspace/script.mjs'), 'utf8'),
    'export const source = 7\n'
  )
  assert.equal((await lstat(join(restored, 'workspace/script.mjs'))).mode & 0o777, 0o755)
  assert.deepEqual(await readFile(join(restored, 'binary')), Buffer.from([0, 255, 8]))
  assert.equal(await readlink(join(restored, 'link')), 'workspace/script.mjs')
})

test('active leases prevent cleanup, and budget failures preserve the root', async (t) => {
  const f = await fixture(t, { maxTaskBytes: 1 })
  await assert.rejects(checkTaskResourceBudget(f.resource), /storage limit/)
  const release = await acquireTaskResources(f.resource)
  await assert.rejects(archiveTaskResources(f.resource), { code: 'EEXIST' })
  assert((await lstat(f.root)).isDirectory())
  await release()
})

test('changed owner or replaced root cannot authorize deletion', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, '.evaluation-owner.json'), '{}')
  await assert.rejects(archiveTaskResources(f.resource), /owner changed/)
  assert((await lstat(f.root)).isDirectory())
})

test(
  'process cleanup requires the registered workspace and receipt ownership',
  {
    skip: process.platform !== 'darwin',
  },
  async (t) => {
    const f = await fixture(t)
    const directory = join(f.output, 'codex')
    await mkdir(directory)
    await assert.rejects(
      createTaskProcessGuard(f.resource, f.output, directory),
      /inside owned task root/u
    )
    await assert.rejects(
      createTaskProcessGuard(f.resource, join(f.root, 'workspace'), f.base),
      /belong to this run/u
    )
    const guard = await createTaskProcessGuard(f.resource, join(f.root, 'workspace'), directory)
    assert.equal((await guard.stop()).scopeEmpty, true)
    await writeFile(join(f.root, '.evaluation-owner.json'), '{}')
    await assert.rejects(
      createTaskProcessGuard(f.resource, join(f.root, 'workspace'), directory),
      /owner changed/u
    )
  }
)

test('corrupt archives do not restore files', async (t) => {
  const f = await fixture(t)
  await archiveTaskResources(f.resource)
  const path = join(f.output, 'execution-resources.jsonl.gz')
  const buffer = await readFile(path)
  await writeFile(path, buffer.subarray(0, buffer.length - 9))
  await assert.rejects(restoreResourceArchive(path, join(f.base, 'restored')))
  await assert.rejects(lstat(join(f.base, 'restored')), { code: 'ENOENT' })
})

test('a whole missing final record is detected even when the gzip stream is valid', async (t) => {
  const f = await fixture(t)
  await archiveTaskResources(f.resource)
  const archive = join(f.output, 'execution-resources.jsonl.gz')
  const lines = gunzipSync(await readFile(archive))
    .toString()
    .trim()
    .split('\n')
  lines.pop()
  await writeFile(archive, gzipSync(lines.join('\n') + '\n'))
  await assert.rejects(verifyResourceArchive(archive), /Incomplete resource archive/)
})

test('a replacement directory with a copied owner record is preserved', async (t) => {
  const f = await fixture(t)
  const original = join(f.base, 'original')
  await rename(f.root, original)
  await mkdir(f.root)
  await writeFile(join(f.root, '.evaluation-owner.json'), JSON.stringify(f.resource))
  await assert.rejects(archiveTaskResources(f.resource))
  assert((await lstat(original)).isDirectory())
  assert((await lstat(f.root)).isDirectory())
})

test('the storage monitor reports growth over budget and drains before cleanup', async (t) => {
  const f = await fixture(t, { maxTaskBytes: 8 * 1024 ** 2 + 2048 })
  await checkTaskResourceBudget(f.resource)
  const exceeded = Promise.withResolvers()
  const stop = monitorTaskResources(f.resource, exceeded.resolve, 5)
  t.after(stop)
  await writeFile(join(f.root, 'growth'), Buffer.alloc(4096))
  const guard = setTimeout(() => exceeded.reject(new Error('monitor did not observe growth')), 2000)
  try {
    assert.match(String(await exceeded.promise), /storage limit/)
  } finally {
    clearTimeout(guard)
    await stop()
  }
  assert((await lstat(f.root)).isDirectory())
})

test('raw evidence growth counts toward the attempt storage budget', async (t) => {
  const f = await fixture(t, { maxTaskBytes: 8 * 1024 ** 2 + 2048 })
  await checkTaskResourceBudget(f.resource)
  await writeFile(join(f.output, 'provider-response.json'), Buffer.alloc(4096))
  await assert.rejects(checkTaskResourceBudget(f.resource), /storage limit/)
  assert((await lstat(f.root)).isDirectory())
})

test('projected evidence and judge copies reserve space before creating destinations', async (t) => {
  const f = await fixture(t, { maxTaskBytes: 8 * 1024 ** 2 + 2048 })
  const initial = await checkTaskResourceBudget(f.resource)
  assert(initial.archiveReserveBytes >= 8 * 1024 ** 2)
  const source = join(f.base, 'external-source')
  await mkdir(source)
  await writeFile(join(source, 'evidence'), Buffer.alloc(4096))
  const destination = join(f.root, 'judge')
  await assert.rejects(checkTaskCopyBudget(f.resource, [{ source, destination }]), /storage limit/)
  await assert.rejects(lstat(destination), { code: 'ENOENT' })
  await assert.rejects(
    checkTaskCopyBudget(f.resource, [{ source, destination: join(f.output, 'evidence') }]),
    /storage limit/
  )
  await assert.rejects(
    checkTaskCopyBudget(f.resource, [{ source, destination: f.base }]),
    /must belong/
  )
})

test('resource cancellation rejects finalization before scanning or admitting another copy', async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  const reason = new Error('storage monitor cancelled the producer')
  controller.abort(reason)
  await assert.rejects(
    checkTaskCopyBudget(
      f.resource,
      [{ source: '/does-not-exist', destination: join(f.root, 'judge') }],
      controller.signal
    ),
    (error) => error === reason
  )
  await assert.rejects(
    checkTaskResourceBudget(f.resource, { signal: controller.signal }),
    (error) => error === reason
  )
  assert((await lstat(f.root)).isDirectory())
})

test('copy admission measures the same filtered files that are copied and accepts file sources', async (t) => {
  const f = await fixture(t, { maxTaskBytes: 8 * 1024 ** 2 + 64 * 1024 })
  const source = join(f.base, 'external')
  await mkdir(join(source, 'src'), { recursive: true })
  await writeFile(join(source, 'src', 'entry.js'), 'export const value = 1\n')
  for (const name of ['.git', '.pytest_cache', '__pycache__', 'node_modules']) {
    await mkdir(join(source, name))
    await writeFile(join(source, name, 'large'), Buffer.alloc(128 * 1024))
  }
  const destination = join(f.root, 'judge')
  await assert.rejects(checkTaskCopyBudget(f.resource, [{ source, destination }]), /storage limit/)
  const budget = await checkTaskCopyBudget(f.resource, [
    {
      source,
      destination,
      filter: taskWorkspaceCopyFilter('node'),
    },
  ])
  const before = await checkTaskResourceBudget(f.resource)
  await copyTaskWorkspace(source, destination, 'node')
  const after = await checkTaskResourceBudget(f.resource)
  assert.equal(after.rootBytes - before.rootBytes, budget.additionalBytes)
  assert.equal(
    await readFile(join(destination, 'src', 'entry.js'), 'utf8'),
    'export const value = 1\n'
  )
  const file = await checkTaskCopyBudget(f.resource, [
    {
      source: join(source, 'src', 'entry.js'),
      destination: join(f.root, 'restored.js'),
    },
  ])
  assert.equal(file.additionalBytes, budget.additionalBytes)
  for (const name of ['.git', '.pytest_cache', '__pycache__', 'node_modules'])
    await assert.rejects(lstat(join(destination, name)), { code: 'ENOENT' })
})

test('cancellation during copy measurement stops traversal before admission', async (t) => {
  const f = await fixture(t)
  const source = join(f.base, 'external')
  await mkdir(source)
  await writeFile(join(source, 'a'), 'first')
  await writeFile(join(source, 'b'), 'second')
  const controller = new AbortController()
  const reason = new Error('cancel during scan')
  const visited = []
  await assert.rejects(
    checkTaskCopyBudget(
      f.resource,
      [
        {
          source,
          destination: join(f.root, 'judge'),
          filter: (path) => {
            visited.push(path)
            if (path !== source) controller.abort(reason)
            return true
          },
        },
      ],
      controller.signal
    ),
    (error) => error === reason
  )
  assert.equal(visited.length, 2)
  await assert.rejects(lstat(join(f.root, 'judge')), { code: 'ENOENT' })
})

test(
  'live sockets are allowed during measurement but prevent archiving an unsettled task',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t)
    const server = createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(join(f.root, 'socket'), resolve)
    })
    try {
      assert((await checkTaskResourceBudget(f.resource)).bytes > 0)
      await assert.rejects(archiveTaskResources(f.resource), /Unsettled special resource/)
      assert((await lstat(f.root)).isDirectory())
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
)

test(
  'completed FIFO fixtures archive as metadata and restore without opening a stream',
  { skip: process.platform === 'win32', timeout: 5000 },
  async (t) => {
    const f = await fixture(t)
    const fifo = join(f.root, 'workspace/config pipe')
    await promisify(execFile)('mkfifo', ['-m', '640', fifo], {
      env: { PATH: '/usr/bin:/bin' },
      timeout: 1000,
    })
    assert((await lstat(fifo)).isFIFO())
    const archived = await archiveTaskResources(f.resource)
    const path = join(f.output, 'execution-resources.jsonl.gz')
    const records = gunzipSync(await readFile(path))
      .toString()
      .trim()
      .split('\n')
      .map(JSON.parse)
    assert.equal(records[0].version, 2)
    assert.deepEqual(
      records.find((x) => x.path === 'workspace/config pipe'),
      { path: 'workspace/config pipe', mode: 0o640, type: 'fifo' }
    )
    const destination = join(f.base, 'restored')
    assert.deepEqual(await restoreResourceArchive(path, destination), archived)
    assert((await lstat(join(destination, 'workspace/config pipe'))).isFIFO())
    assert.equal((await lstat(join(destination, 'workspace/config pipe'))).mode & 0o777, 0o640)
    assert.deepEqual(await readFile(join(destination, 'binary')), Buffer.from([0, 255, 8]))
    records[0].version = 1
    const invalid = join(f.output, 'fifo-in-legacy.gz')
    await writeFile(invalid, gzipSync(records.map(JSON.stringify).join('\n') + '\n'))
    await assert.rejects(verifyResourceArchive(invalid))
  }
)

test('legacy version-one archives still verify and restore byte-for-byte', async (t) => {
  const f = await fixture(t)
  await archiveTaskResources(f.resource)
  const path = join(f.output, 'execution-resources.jsonl.gz')
  const records = gunzipSync(await readFile(path))
    .toString()
    .trim()
    .split('\n')
    .map(JSON.parse)
  records[0] = { type: 'format', version: 1 }
  const legacy = join(f.output, 'legacy.gz')
  await writeFile(legacy, gzipSync(records.map(JSON.stringify).join('\n') + '\n'))
  const verified = await verifyResourceArchive(legacy)
  const destination = join(f.base, 'legacy-restored')
  assert.deepEqual(await restoreResourceArchive(legacy, destination), verified)
  assert.deepEqual(await readFile(join(destination, 'binary')), Buffer.from([0, 255, 8]))
})
