import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { KernelUpdateLock } from '../../../src/impl/updater/KernelUpdateLock'
import type { KernelUpdateLockOptions } from '../../../src/types/updater'
import { KernelUpdaterError } from '../../../src/utils/errors'

import { createTemporaryDirectories } from './support'

const directories = createTemporaryDirectories('lock')

/** 建一把锁并当场拿下它；拿不到就把失败原样抛给用例。 */
async function acquireLock(options: KernelUpdateLockOptions): Promise<KernelUpdateLock> {
  const lock = new KernelUpdateLock(options)
  await lock.acquire()
  return lock
}

afterEach(async () => {
  await directories.cleanup()
})

async function lockPath(): Promise<string> {
  return join(await directories.create(), 'nested', 'update.lock')
}

describe('Kernel update lock', () => {
  test('grants exclusive ownership and records the holder', async () => {
    const path = await lockPath()
    const lock = await acquireLock({
      lockPath: path,
      holderId: 'product-a',
      now: () => 1700000000000,
    })

    try {
      expect(lock.record).toEqual({
        holderId: 'product-a',
        pid: process.pid,
        acquiredAt: 1700000000000,
      })
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        holderId: 'product-a',
        pid: process.pid,
        acquiredAt: 1700000000000,
      })
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      await lock.release()
    }
  })

  test('fails the second acquirer with a distinct lock error', async () => {
    const path = await lockPath()
    const first = await acquireLock({
      lockPath: path,
      holderId: 'product-a',
    })

    try {
      const contention = acquireLock({
        lockPath: path,
        holderId: 'product-b',
      })
      await expect(contention).rejects.toBeInstanceOf(KernelUpdaterError)
      await expect(contention).rejects.toMatchObject({
        code: 'UPDATE_LOCK_HELD',
        details: { path, ownerPid: process.pid },
      })
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ holderId: 'product-a' })
    } finally {
      await first.release()
    }
  })

  test('reclaims a lock whose recorded process is gone', async () => {
    const path = await lockPath()
    const stale = await acquireLock({
      lockPath: path,
      holderId: 'crashed-product',
    })
    // A crashed holder never releases; the file outlives the process.
    void stale

    const reclaimed = await acquireLock({
      lockPath: path,
      holderId: 'product-b',
      isProcessAlive: () => false,
    })

    try {
      expect(reclaimed.record?.holderId).toBe('product-b')
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ holderId: 'product-b' })
    } finally {
      await reclaimed.release()
    }
  })

  test('refuses a lock whose owner cannot be read instead of stealing it', async () => {
    // 对方刚 `open(path, 'wx')` 成功、还没来得及写进 pid 的那一小段窗口长这样。
    // 原来会读一次读不出就把锁删掉，真实竞态下两个进程同时持锁。
    const path = await lockPath()
    const first = await acquireLock({ lockPath: path })
    await first.release()
    await writeFile(path, '', 'utf8')

    const contention = acquireLock({
      lockPath: path,
      holderId: 'product-b',
      ownerReadRetries: 2,
      ownerReadRetryMs: 1,
    })
    await expect(contention).rejects.toMatchObject({
      code: 'UPDATE_LOCK_HELD',
      details: { path },
    })
    // 锁文件必须原样留着——它是对方的。
    expect(await readFile(path, 'utf8')).toBe('')
  })

  test('waits out a half-written lock and then reads its owner', async () => {
    const path = await lockPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '', 'utf8')
    // 对方在第二次重读之前把 pid 写了进去。
    let reads = 0
    const contention = acquireLock({
      lockPath: path,
      holderId: 'product-b',
      ownerReadRetries: 5,
      ownerReadRetryMs: 1,
      sleep: async () => {
        reads += 1
        if (reads === 2) {
          await writeFile(
            path,
            JSON.stringify({ holderId: 'product-a', pid: 424242, acquiredAt: 1 }),
            'utf8'
          )
        }
      },
      isProcessAlive: () => true,
    })

    await expect(contention).rejects.toMatchObject({
      code: 'UPDATE_LOCK_HELD',
      details: { path, ownerPid: 424242 },
    })
  })

  test('releases idempotently and removes the lock file', async () => {
    const path = await lockPath()
    const lock = await acquireLock({ lockPath: path })

    await lock.release()
    await lock.release()

    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    const next = await acquireLock({ lockPath: path })
    await next.release()
  })

  test('releases the lock when the guarded operation throws', async () => {
    const path = await lockPath()
    const lock = new KernelUpdateLock({ lockPath: path })

    await lock.acquire()
    try {
      expect(() => {
        throw new Error('update failed')
      }).toThrowError('update failed')
    } finally {
      await lock.release()
    }

    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
