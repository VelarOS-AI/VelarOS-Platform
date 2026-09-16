import { randomUUID } from 'node:crypto'
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  unlink,
} from 'node:fs/promises'
import { dirname } from 'node:path'

import { isNotUndefined, isNull, isNumber, isObject, isUndefined, Log } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { KernelUpdaterErrorCodes } from '../../contract/constants'
import type { KernelUpdateLockOptions, KernelUpdateLockOwner, KernelUpdateLockRecord } from '../../types/updater'
import { KernelUpdaterError } from '../../utils/errors'
import {
  ignoreMissing,
  isNodeError,
} from '../../utils/fs'
import { KernelTuning } from '../../utils/tuning'

const log = Log.tag('KernelUpdateLock')

/**
 * 跨进程的独占文件锁，`versions/` 与 `current.json` 的每一次改动都在它下面跑。
 *
 * 实例由更新器按锁文件路径建一把，一把锁对应一个锁文件：两个产品
 * 同时更新同一份共享内核时排队，而不是互相踩。记着的 pid 已经不在的锁会被回收；还被活着的进程
 * 持着的锁一个字节都不动。
 */
export interface KernelUpdateLockApi {
  /** 当前持有的锁记录；还没拿到锁、或者已经释放时缺席。 */
  readonly record?: KernelUpdateLockRecord
  /** 独占地拿下锁文件并写入属主记录，返回这条记录；被活着的进程持着、或者读不出属主时抛 KernelUpdaterError（码 UPDATE_LOCK_HELD），锁文件原样不动。 */
  acquire(): Promise<KernelUpdateLockRecord>
  /** 释放锁：关掉文件句柄并删掉锁文件；没拿到过锁或重复释放都是空操作。 */
  release(): Promise<void>
}

export class KernelUpdateLock implements KernelUpdateLockApi {
  private readonly ownerReadRetries: number
  private readonly ownerReadRetryMs: number
  private handle?: FileHandle
  private held?: KernelUpdateLockRecord

  public constructor(private readonly options: KernelUpdateLockOptions) {
    this.ownerReadRetries = options.ownerReadRetries
      ?? KernelTuning.lockOwnerReadRetries
    this.ownerReadRetryMs = options.ownerReadRetryMs
      ?? KernelTuning.lockOwnerReadRetryMs
  }

  public get record(): KernelUpdateLockRecord | undefined {
    return this.held
  }

  public async acquire(): Promise<KernelUpdateLockRecord> {
    if (isNotUndefined(this.held)) return this.held
    const record: KernelUpdateLockRecord = {
      holderId: this.options.holderId ?? randomUUID(),
      pid: process.pid,
      acquiredAt: (this.options.now ?? Date.now)(),
    }
    await mkdir(dirname(this.options.lockPath), { recursive: true, mode: 0o700 })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.handle = await open(this.options.lockPath, 'wx', 0o600)
        await this.handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
        this.held = record
        return record
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error
        const owner = await this.resolveOwner()
        switch (owner.status) {
          case 'held':
            throw new KernelUpdaterError(
              KernelUpdaterErrorCodes.updateLockHeld,
              `Kernel 更新锁正被进程 ${owner.pid} 持有`,
              { path: this.options.lockPath, ownerPid: owner.pid },
            )
          case 'unreadable':
            // 读不出属主：对方很可能刚 open('wx') 还没来得及写 pid。删掉它等于两个进程同时
            // 持锁，所以按「被占用」处理；真是崩溃残留时由人删掉这个文件。
            throw new KernelUpdaterError(
              KernelUpdaterErrorCodes.updateLockHeld,
              `Kernel 更新锁存在但读不出属主，按被占用处理；若确认没有更新在跑，删掉 ${this.options.lockPath} 后重试`,
              { path: this.options.lockPath },
            )
          case 'stale':
            await unlink(this.options.lockPath).catch(ignoreMissing)
            break
        }
      }
    }

    throw new KernelUpdaterError(
      KernelUpdaterErrorCodes.updateLockHeld,
      '拿不到 Kernel 更新锁',
      { path: this.options.lockPath },
    )
  }

  public async release(): Promise<void> {
    const handle = this.handle
    if (isUndefined(handle)) return
    this.handle = undefined
    this.held = undefined
    await handle.close().catch((error) => {
      log.warn('关闭内核更新锁的文件句柄失败', { error, path: this.options.lockPath })
    })
    await unlink(this.options.lockPath).catch(ignoreMissing)
  }

  /**
   * 判定一个已存在的锁文件归谁。
   *
   * `open(path, 'wx')` 成功与「把 pid 写进去」之间有一小段窗口。原来只读一次，读不出就当死锁
   * 删掉——真实竞态下两个进程会同时拿到锁。这里读不出就短暂重读几次。
   */
  private async resolveOwner(): Promise<KernelUpdateLockOwner> {
    for (let attempt = 0; attempt <= this.ownerReadRetries; attempt += 1) {
      const pid = await this.readOwnerPid()
      if (isNotUndefined(pid)) return this.isOwnerAlive(pid)
        ? { status: 'held', pid }
        : { status: 'stale' }
      if (attempt < this.ownerReadRetries) await this.pause()
    }
    return { status: 'unreadable' }
  }

  /** 从锁文件里读出属主 pid；文件为空、内容损坏或 pid 不是正整数都当读不出。 */
  private async readOwnerPid(): Promise<number | undefined> {
    try {
      const input = JSON.parse(
        await readFile(this.options.lockPath, 'utf8'),
      ) as unknown
      if (!isObject(input) && !isNull(input) || isNull(input)) return undefined
      const pid = Reflect.get(input, 'pid') as unknown
      return isNumber(pid) && Number.isInteger(pid) && pid > 0
        ? pid
        : undefined
    } catch (error) {
      log.debug('Kernel update lock owner could not be read', {
        error,
        path: this.options.lockPath,
      })
      return undefined
    }
  }

  /** 判断锁文件里记的进程还在不在；没注入探针时用 `kill(pid, 0)` 探（EPERM 也算活着）。 */
  private isOwnerAlive(pid: number): boolean {
    const probe = this.options.isProcessAlive
    if (isNotUndefined(probe)) return probe(pid)
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return isNodeError(error, 'EPERM')
    }
  }

  /** 两次重读属主之间等一小会儿；宿主可以注入自己的 sleep（测试用）。 */
  private async pause(): Promise<void> {
    const sleep = this.options.sleep
    if (isNotUndefined(sleep)) {
      await sleep(this.ownerReadRetryMs)
      return
    }
    await TimerScope.sleep(this.ownerReadRetryMs, {
      label: 'KernelUpdateLock.ownerRead',
    })
  }
}
