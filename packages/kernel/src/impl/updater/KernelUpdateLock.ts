import { randomUUID } from 'node:crypto'
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  unlink,
} from 'node:fs/promises'
import { dirname } from 'node:path'

import { isNotUndefined, isNull, isNumber, isObject, Log } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { KernelUpdaterErrorCodes } from '../../contract/constants'
import { KernelUpdaterError } from '../../utils/errors'
import {
  ignoreMissing,
  isNodeError,
} from '../../utils/fs'
import { KernelTuning } from '../../utils/tuning'

const log = Log.tag('KernelUpdateLock')

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
  /** 读不出锁属主时重读几次（对方可能刚 open('wx') 还没写进 pid）。 */
  readonly ownerReadRetries?: number
  readonly ownerReadRetryMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

/** 读不出属主时的重读次数与间隔：够覆盖 open→write 这一小段，又不至于把调用方挂住。 */

/**
 * Exclusive file lock guarding every mutation of `versions/` and
 * `current.json`, so two products updating the same shared Kernel serialise
 * instead of racing. A lock whose recorded pid is gone is reclaimed; a lock
 * held by a live process raises a KernelUpdaterError（码 UPDATE_LOCK_HELD） and changes nothing.
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
        const owner = await resolveLockOwner(options.lockPath, {
          isAlive,
          retries: options.ownerReadRetries ?? KernelTuning.lockOwnerReadRetries,
          retryMs: options.ownerReadRetryMs ?? KernelTuning.lockOwnerReadRetryMs,
          sleep: options.sleep ?? sleep,
        })
        switch (owner.status) {
          case 'held':
            throw new KernelUpdaterError(
              KernelUpdaterErrorCodes.updateLockHeld,
              `Kernel 更新锁正被进程 ${owner.pid} 持有`,
              { path: options.lockPath, ownerPid: owner.pid },
            )
          case 'unreadable':
            // 读不出属主：对方很可能刚 open('wx') 还没来得及写 pid。删掉它等于两个进程同时
            // 持锁，所以按「被占用」处理；真是崩溃残留时由人删掉这个文件。
            throw new KernelUpdaterError(
              KernelUpdaterErrorCodes.updateLockHeld,
              `Kernel 更新锁存在但读不出属主，按被占用处理；若确认没有更新在跑，删掉 ${options.lockPath} 后重试`,
              { path: options.lockPath },
            )
          case 'stale':
            await unlink(options.lockPath).catch(ignoreMissing)
            break
        }
      }
    }

    throw new KernelUpdaterError(
      KernelUpdaterErrorCodes.updateLockHeld,
      '拿不到 Kernel 更新锁',
      { path: options.lockPath },
    )
  }

  public async release(): Promise<void> {
    if (this.released) return
    this.released = true
    await this.handle.close().catch((error) => {
      log.warn('Kernel update lock handle failed to close', { error, path: this.lockPath })
    })
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

type KernelUpdateLockOwner =
  | { readonly status: 'held'; readonly pid: number }
  /** 属主进程已经不在，锁可以回收。 */
  | { readonly status: 'stale' }
  /** 重读多次仍读不出属主（文件为空或内容损坏）。 */
  | { readonly status: 'unreadable' }

/**
 * 判定一个已存在的锁文件归谁。
 *
 * `open(path, 'wx')` 成功与「把 pid 写进去」之间有一小段窗口。原来只读一次，读不出就当死锁
 * 删掉——真实竞态下两个进程会同时拿到锁。这里读不出就短暂重读几次。
 * （`serve/daemon/daemon.ts` 的守护进程锁有同一段逻辑；合并成一处留给改造。）
 */
async function resolveLockOwner(
  path: string,
  options: {
    readonly isAlive: (pid: number) => boolean
    readonly retries: number
    readonly retryMs: number
    readonly sleep: (ms: number) => Promise<void>
  },
): Promise<KernelUpdateLockOwner> {
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const pid = await readLockOwnerPid(path)
    if (isNotUndefined(pid)) return options.isAlive(pid)
      ? { status: 'held', pid }
      : { status: 'stale' }
    if (attempt < options.retries) await options.sleep(options.retryMs)
  }
  return { status: 'unreadable' }
}

function sleep(ms: number): Promise<void> {
  return TimerScope.sleep(ms, { label: 'KernelUpdateLock.ownerRead' })
}

async function readLockOwnerPid(path: string): Promise<number | undefined> {
  try {
    const input = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isObject(input) && !isNull(input) || isNull(input)) return undefined
    const pid = Reflect.get(input, 'pid') as unknown
    return isNumber(pid) && Number.isInteger(pid) && pid > 0
      ? pid
      : undefined
  } catch (error) {
    log.debug('Kernel update lock owner could not be read', { error, path })
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
