import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { KnowledgeRecord } from '../../src/knowledge/knowledge/domain/Types'
import { KnowledgeIngestion } from '../../src/knowledge/knowledge/ingestion/Ingestion'
import { KnowledgeWorkspace } from '../../src/knowledge/knowledge/ingestion/WorkspaceStore'

type DocumentFileSystem = NonNullable<ConstructorParameters<typeof KnowledgeWorkspace>[2]>
const fileSystem: DocumentFileSystem = {
  listDirectory: (path) => readdir(path, { withFileTypes: true }),
  read: (path) => readFile(path),
  inspect: (path) => stat(path),
}
const runtime = { provider: 'test', model: 'embedding', indexRuntimeKey: 'test-index' }

function record(
  root: string,
  path: string,
  sourceKind: KnowledgeRecord['sourceKind'] = 'markdown'
): KnowledgeRecord {
  return {
    id: path,
    path,
    workspaceRoot: root,
    title: path,
    summary: '',
    content: 'Existing indexed content',
    sourceKind,
    tags: [],
    indexStatus: 'ready',
    indexError: '',
    chunkCount: 1,
    indexTextHash: 'existing',
    embeddingProvider: 'test',
    embeddingModel: 'embedding',
    createdAt: 1,
    updatedAt: 1,
    lastAccessedAt: 1,
  }
}

async function fixture(t: TestContext, io: Partial<DocumentFileSystem> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'velar-knowledge-lifecycle-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const records = new Map<string, KnowledgeRecord>()
  const deleted: string[] = []
  const upserted: string[] = []
  const workspace = new KnowledgeWorkspace(undefined, undefined, { ...fileSystem, ...io })
  const mutation: ConstructorParameters<typeof KnowledgeIngestion>[2] = {
    getCurrentIndexRuntime: () => runtime,
    upsertKnowledge: async (input) => {
      const saved = {
        ...record(root, input.path, input.sourceKind),
        ...input,
        tags: input.tags ?? [],
        summary: input.summary ?? '',
      }
      records.set(saved.id, saved)
      upserted.push(saved.id)
      return saved
    },
    deleteKnowledge: async (id) => {
      records.delete(id)
      deleted.push(id)
    },
  }
  const ingestion = new KnowledgeIngestion(
    {
      listKnowledgeByWorkspaceRoot: (_root, kinds) =>
        [...records.values()].filter((entry) => !kinds || kinds.includes(entry.sourceKind)),
      listFileIndexByWorkspaceRoot: () => [],
      upsertFileIndex: () => {},
    },
    workspace,
    mutation
  )
  return { root, records, deleted, upserted, workspace, mutation, ingestion }
}

void test('an unavailable root preserves documents and does not publish a successful sync time', async (t) => {
  const f = await fixture(t)
  f.records.set('notes.md', record(f.root, 'notes.md'))
  await rm(f.root, { recursive: true })
  await assert.rejects(f.ingestion.ensureWorkspaceSynced(f.root), { code: 'ENOENT' })
  assert.equal(f.records.size, 1)
  assert.deepEqual(f.deleted, [])
  assert.deepEqual(f.ingestion.listWorkspaceSyncStates(), [])
})

void test('unreadable subdirectories abort the scan before any document mutation or cleanup', async (t) => {
  const f = await fixture(t, {
    listDirectory: async (path) => {
      if (path.endsWith('private'))
        throw Object.assign(new Error('directory denied'), { code: 'EACCES' })
      return fileSystem.listDirectory(path)
    },
  })
  await writeFile(join(f.root, 'first.md'), 'New content to be indexed')
  await mkdir(join(f.root, 'private'))
  f.records.set('private/known.md', record(f.root, 'private/known.md'))
  await assert.rejects(f.ingestion.syncWorkspace(f.root), { code: 'EACCES' })
  assert.deepEqual(f.upserted, [])
  assert.deepEqual(f.deleted, [])
  assert.deepEqual(f.ingestion.listWorkspaceSyncStates(), [])
})

void test('a file metadata failure is an incomplete scan, not proof of deletion', async (t) => {
  const f = await fixture(t, {
    inspect: async () => {
      throw Object.assign(new Error('stat denied'), { code: 'EACCES' })
    },
  })
  await writeFile(join(f.root, 'notes.md'), 'Current content')
  f.records.set('notes.md', record(f.root, 'notes.md'))
  await assert.rejects(f.ingestion.syncWorkspace(f.root), { code: 'EACCES' })
  assert.deepEqual(f.deleted, [])
  assert.equal(f.records.size, 1)
})

void test('file read failures preserve known documents and suppress destructive reconciliation', async (t) => {
  let denied = true
  const f = await fixture(t, {
    read: async (path) => {
      if (denied) throw Object.assign(new Error('read denied'), { code: 'EACCES' })
      return fileSystem.read(path)
    },
  })
  await writeFile(join(f.root, 'notes.md'), 'Current content')
  f.records.set('notes.md', record(f.root, 'notes.md'))
  f.records.set('missing.md', record(f.root, 'missing.md'))
  await assert.rejects(f.ingestion.ensureWorkspaceSynced(f.root), { code: 'UNAVAILABLE' })
  assert.equal(f.records.size, 2)
  assert.deepEqual(f.deleted, [])
  assert.deepEqual(f.ingestion.listWorkspaceSyncStates(), [])
  denied = false
  const retried = await f.ingestion.ensureWorkspaceSynced(f.root)
  assert.equal(retried.scanned, 1)
  assert.deepEqual(f.deleted, ['missing.md'])
  assert.equal(f.records.get('notes.md')?.content, 'Current content')
})

void test('a failed forced sync invalidates the earlier TTL and can immediately retry', async (t) => {
  let denied = false
  const f = await fixture(t, {
    read: async (path) => {
      if (denied) throw new Error('read temporarily failed')
      return fileSystem.read(path)
    },
  })
  await writeFile(join(f.root, 'notes.md'), 'Current content')
  await f.ingestion.syncWorkspace(f.root)
  assert.equal(f.ingestion.listWorkspaceSyncStates().length, 1)
  denied = true
  await assert.rejects(f.ingestion.syncWorkspace(f.root, { force: true }))
  assert.deepEqual(f.ingestion.listWorkspaceSyncStates(), [])
  denied = false
  assert.equal((await f.ingestion.ensureWorkspaceSynced(f.root)).scanned, 1)
})

void test('complete scans still remove confirmed missing, empty and binary documents', async (t) => {
  const f = await fixture(t)
  for (const path of ['missing.md', 'empty.md', 'binary.md'])
    f.records.set(path, record(f.root, path))
  await writeFile(join(f.root, 'empty.md'), '')
  await writeFile(join(f.root, 'binary.md'), Buffer.alloc(100))
  const result = await f.ingestion.syncWorkspace(f.root)
  assert.equal(result.removed, 3)
  assert.equal(f.records.size, 0)
  assert.equal(f.ingestion.listWorkspaceSyncStates().length, 1)
})

void test('cleanup failures remain failures and do not start a successful TTL', async (t) => {
  const f = await fixture(t)
  f.records.set('missing.md', record(f.root, 'missing.md'))
  f.mutation.deleteKnowledge = async () => {
    throw new Error('vector delete unavailable')
  }
  await assert.rejects(f.ingestion.syncWorkspace(f.root), /vector delete unavailable/)
  assert.equal(f.records.size, 1)
  assert.deepEqual(f.ingestion.listWorkspaceSyncStates(), [])
})

void test('concurrent scans of the same workspace share a single reconciliation', async (t) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let scans = 0
  const f = await fixture(t, {
    listDirectory: async (path) => {
      scans += 1
      await gate
      return fileSystem.listDirectory(path)
    },
  })
  f.records.set('missing.md', record(f.root, 'missing.md'))
  const first = f.ingestion.syncWorkspace(f.root)
  const second = f.ingestion.syncWorkspace(f.root, { force: true })
  assert.equal(first, second)
  release()
  await Promise.all([first, second])
  assert.equal(scans, 1)
  assert.deepEqual(f.deleted, ['missing.md'])
})

void test('code cleanup retains inaccessible paths but removes a confirmed missing path in a reachable root', async (t) => {
  let denied = true
  const f = await fixture(t, {
    inspect: async (path) => {
      if (denied) throw Object.assign(new Error('inspection denied'), { code: 'EACCES' })
      return fileSystem.inspect(path)
    },
  })
  f.records.set('code.ts', record(f.root, 'code.ts', 'code'))
  await f.ingestion.syncCodeCandidates(f.root, {})
  assert.deepEqual(f.deleted, [])
  denied = false
  await f.ingestion.syncCodeCandidates(f.root, {})
  assert.deepEqual(f.deleted, ['code.ts'])
})

void test('code cleanup retains old knowledge when its workspace root is unavailable', async (t) => {
  const f = await fixture(t)
  f.records.set('code.ts', record(f.root, 'code.ts', 'code'))
  await rm(f.root, { recursive: true })
  await f.ingestion.syncCodeCandidates(f.root, {})
  assert.equal(f.records.size, 1)
  assert.deepEqual(f.deleted, [])
})
