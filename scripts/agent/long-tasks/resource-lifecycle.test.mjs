// 验证真实归档、还原和资源所有权边界，失败时保留原始材料。
import assert from 'node:assert/strict'
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
  monitorTaskResources,
  registerTaskResources,
  restoreResourceArchive,
  verifyResourceArchive,
} from './resource-lifecycle.mjs'

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
  const f = await fixture(t, { maxTaskBytes: 2048 })
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
  const f = await fixture(t, { maxTaskBytes: 2048 })
  await checkTaskResourceBudget(f.resource)
  await writeFile(join(f.output, 'provider-response.json'), Buffer.alloc(4096))
  await assert.rejects(checkTaskResourceBudget(f.resource), /storage limit/)
  assert((await lstat(f.root)).isDirectory())
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
