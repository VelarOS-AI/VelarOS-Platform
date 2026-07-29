import { randomUUID } from 'node:crypto'
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  unlink,
} from 'node:fs/promises'
import { dirname } from 'node:path'

import { KernelUpdateLockError } from './errors'
import {
  ignoreMissing,
  isNodeError,
} from './fs-utils'

export interface KernelUpdateLockRecord {
  readonly holderId: string
  readonly pid: number
  readonly acquiredAt: number
}

export interface KernelUpdateLockOptions {
  readonly lockPath: string
  readonly holderId?: string
  readonly isProcessAlive?: (pid: number) => boolean
  readonly now?: () => number
}

/**
 * Exclusive file lock guarding every mutation of `versions/` and
 * `current.json`, so two products updating the same shared Kernel serialise
 * instead of racing. A lock whose recorded pid is gone is reclaimed; a lock
 * held by a live process raises `KernelUpdateLockError` and changes nothing.
 */
export class KernelUpdateLock {
  private released = false

  private constructor(
    private readonly lockPath: string,
    private readonly handle: FileHandle,
    public readonly record: KernelUpdateLockRecord,
  ) {}

  public static async acquire(
    options: KernelUpdateLockOptions,
  ): Promise<KernelUpdateLock> {
    const isAlive = options.isProcessAlive ?? isProcessAlive
    const record: KernelUpdateLockRecord = {
      holderId: options.holderId ?? randomUUID(),
      pid: process.pid,
      acquiredAt: (options.now ?? Date.now)(),
    }
    await mkdir(dirname(options.lockPath), { recursive: true, mode: 0o700 })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(options.lockPath, 'wx', 0o600)
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
        return new KernelUpdateLock(options.lockPath, handle, record)
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error
        const ownerPid = await readLockOwnerPid(options.lockPath)
        if (ownerPid !== undefined && isAlive(ownerPid)) {
          throw new KernelUpdateLockError(
            `Kernel update lock is held by process ${ownerPid}`,
            { path: options.lockPath, ownerPid },
          )
        }
        await unlink(options.lockPath).catch(ignoreMissing)
      }
    }

    throw new KernelUpdateLockError(
      'Kernel update lock could not be acquired',
      { path: options.lockPath },
    )
  }

  public async release(): Promise<void> {
    if (this.released) return
    this.released = true
    await this.handle.close().catch(() => undefined)
    await unlink(this.lockPath).catch(ignoreMissing)
  }
}

export async function withKernelUpdateLock<T>(
  options: KernelUpdateLockOptions,
  operation: (lock: KernelUpdateLock) => Promise<T>,
): Promise<T> {
  const lock = await KernelUpdateLock.acquire(options)
  try {
    return await operation(lock)
  } finally {
    await lock.release()
  }
}

async function readLockOwnerPid(path: string): Promise<number | undefined> {
  try {
    const input = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (typeof input !== 'object' || input === null) return undefined
    const pid = Reflect.get(input, 'pid') as unknown
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0
      ? pid
      : undefined
  } catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeError(error, 'EPERM')
  }
}
