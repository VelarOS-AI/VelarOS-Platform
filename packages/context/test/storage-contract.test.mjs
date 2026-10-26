import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'

import { localContextStorage } from '../dist/node.js'

import {
  storageContract,
  storeContract,
  volatileStorageBackend,
} from './support/storage-contract.mjs'

async function sqliteFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'storage-contract-'))
  const connections = []
  // fixture 拥有目录和连接，清理顺序不能依赖后续登记的测试钩子。
  t.after(async () => {
    for (const storage of connections) await storage.close()
    await rm(dir, { recursive: true, force: true })
  })
  return {
    open: () => {
      const storage = localContextStorage({ path: join(dir, 'state.sqlite') })
      connections.push(storage)
      return storage
    },
  }
}

describe('INV-12 storage adapters preserve persistence and lifecycle contracts', () => {
  storageContract('SQLite', sqliteFixture)
  storeContract('SQLite', sqliteFixture)
  storageContract('opaque asynchronous test adapter', async () => volatileStorageBackend())
})

test('INV-18 local lease ownership only proves exit for an absent process on the same host', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  t.after(() => storage.close())
  assert.equal(storage.leaseOwnerActive(storage.leaseOwner), true)
  for (const identity of [
    'broken',
    'null',
    '{}',
    JSON.stringify({ host: 'foreign-host', pid: process.pid }),
  ])
    assert.equal(storage.leaseOwnerActive(identity), undefined)
  const kill = t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('absent'), { code: 'ESRCH' })
  })
  assert.equal(storage.leaseOwnerActive(JSON.stringify({ host: hostname(), pid: 123 })), false)
  kill.mock.mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' })
  })
  assert.equal(storage.leaseOwnerActive(JSON.stringify({ host: hostname(), pid: 123 })), undefined)
})

test('SQLite initialization failure closes the connection it just opened', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'storage-init-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.sqlite')
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE context_records(session TEXT)')
  } finally {
    db.close()
  }
  const close = t.mock.method(DatabaseSync.prototype, 'close')
  assert.throws(() => localContextStorage({ path }), /no such column/)
  assert.equal(close.mock.calls.length, 1)
})
