import {
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  KernelUpdateLock,
  KernelUpdateLockError,
  withKernelUpdateLock,
} from '../../../src/serve/updater'

import { createTemporaryDirectories } from './support'

const directories = createTemporaryDirectories('lock')

afterEach(async () => {
  await directories.cleanup()
})

async function lockPath(): Promise<string> {
  return join(await directories.create(), 'nested', 'update.lock')
}

describe('Kernel update lock', () => {
  test('grants exclusive ownership and records the holder', async () => {
    const path = await lockPath()
    const lock = await KernelUpdateLock.acquire({
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
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      await lock.release()
    }
  })

  test('fails the second acquirer with a distinct lock error', async () => {
    const path = await lockPath()
    const first = await KernelUpdateLock.acquire({
      lockPath: path,
      holderId: 'product-a',
    })

    try {
      const contention = KernelUpdateLock.acquire({
        lockPath: path,
        holderId: 'product-b',
      })
      await expect(contention).rejects.toBeInstanceOf(KernelUpdateLockError)
      await expect(contention).rejects.toMatchObject({
        code: 'UPDATE_LOCK_HELD',
        details: { path, ownerPid: process.pid },
      })
      expect(JSON.parse(await readFile(path, 'utf8')))
        .toMatchObject({ holderId: 'product-a' })
    } finally {
      await first.release()
    }
  })

  test('reclaims a lock whose recorded process is gone', async () => {
    const path = await lockPath()
    const stale = await KernelUpdateLock.acquire({
      lockPath: path,
      holderId: 'crashed-product',
    })
    // A crashed holder never releases; the file outlives the process.
    void stale

    const reclaimed = await KernelUpdateLock.acquire({
      lockPath: path,
      holderId: 'product-b',
      isProcessAlive: () => false,
    })

    try {
      expect(reclaimed.record.holderId).toBe('product-b')
      expect(JSON.parse(await readFile(path, 'utf8')))
        .toMatchObject({ holderId: 'product-b' })
    } finally {
      await reclaimed.release()
    }
  })

  test('reclaims a lock left with an unreadable payload', async () => {
    const path = await lockPath()
    const first = await KernelUpdateLock.acquire({ lockPath: path })
    await first.release()
    await writeFile(path, 'not json', 'utf8')

    const reclaimed = await KernelUpdateLock.acquire({
      lockPath: path,
      holderId: 'product-b',
    })
    await reclaimed.release()

    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('releases idempotently and removes the lock file', async () => {
    const path = await lockPath()
    const lock = await KernelUpdateLock.acquire({ lockPath: path })

    await lock.release()
    await lock.release()

    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    const next = await KernelUpdateLock.acquire({ lockPath: path })
    await next.release()
  })

  test('releases the lock when the guarded operation throws', async () => {
    const path = await lockPath()

    await expect(withKernelUpdateLock({ lockPath: path }, () => {
      throw new Error('update failed')
    })).rejects.toThrowError('update failed')

    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
