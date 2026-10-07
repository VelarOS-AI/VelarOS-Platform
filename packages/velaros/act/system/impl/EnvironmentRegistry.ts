import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { getBuiltinModule } from 'node:process'
import type { DatabaseSync } from 'node:sqlite'

import { isArray, isObject, isPlainObject, isString, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import {
  createExclusiveSqliteLock,
  type ExclusiveSqliteLockApi,
} from '@velaros-ai/core/utils/ExclusiveSqliteLock'
import { writeJsonFileAtomically } from '@velaros-ai/core/utils/FilePersistence'
import { createKeyedSerialQueue } from '@velaros-ai/core/utils/KeyedSerialQueue'

import { EnvironmentLimits } from '../contract/constants.js'
import type {
  EnvironmentLease,
  EnvironmentOperationContext,
  EnvironmentRegistryOptions,
} from '../contract/requires.js'
import type {
  EnvironmentApply,
  EnvironmentDescribe,
  EnvironmentGeneration,
  EnvironmentIndex,
  EnvironmentPackageDescription,
  EnvironmentRollback,
  EnvironmentSearch,
  EnvironmentState,
} from '../types/environment.js'
import {
  assertEnvironmentRevision,
  environmentDescriptions,
  environmentPackageSpec,
  environmentRevision,
  environmentState,
  validateEnvironmentApply,
  validateEnvironmentSearch,
} from '../utils/environment.js'

import { EnvironmentFiles } from './EnvironmentFiles.js'

/** Agent 持久依赖环境：发布、回滚与执行快照共用磁盘事实。 */
export interface EnvironmentRegistryApi {
  /** 宿主固定的绝对作用域根目录。 */
  readonly directory: string
  /** 查询当前环境和仍可恢复的历史。 */
  list(): Promise<EnvironmentState>
  /** 按关键词搜索 npm registry。 */
  search(
    input: EnvironmentSearch,
    signal: AbortSignal
  ): Promise<readonly EnvironmentPackageDescription[]>
  /** 查询包的指定版本说明。 */
  describe(
    input: EnvironmentDescribe,
    signal: AbortSignal
  ): Promise<readonly EnvironmentPackageDescription[]>
  /** 安装或删除完成后按 baseRevision 原子发布。 */
  apply(
    input: EnvironmentApply,
    signal: AbortSignal,
    recordEffect?: EnvironmentOperationContext['recordEffect']
  ): Promise<EnvironmentState>
  /** 将历史内容发布为新版本，当前执行快照保持不变。 */
  rollback(
    input: EnvironmentRollback,
    signal: AbortSignal,
    recordEffect?: EnvironmentOperationContext['recordEffect']
  ): Promise<EnvironmentState>
  /** 固定一次执行及其进程树的依赖和命令目录。 */
  acquire(signal: AbortSignal): Promise<EnvironmentLease>
  /** 回收无历史、无存活租约的安装目录。 */
  collect(): Promise<void>
}

/** 安装发生在独占候选目录；只有短暂发布与租约操作持有跨进程锁。 */
class EnvironmentRegistry implements EnvironmentRegistryApi {
  public readonly directory: string
  private readonly files: EnvironmentFiles
  private readonly lock: ExclusiveSqliteLockApi
  private readonly queue = createKeyedSerialQueue()

  public constructor(private readonly options: EnvironmentRegistryOptions) {
    if (!isAbsolute(options.directory)) throw new AppError('VALIDATION', 'npm 环境需要绝对目录')
    this.directory = resolve(options.directory)
    this.files = new EnvironmentFiles(this.directory)
    this.lock =
      options.lock ??
      createExclusiveSqliteLock(() => {
        const sqlite = getBuiltinModule('node:sqlite')
        if (!sqlite)
          throw new AppError('UNAVAILABLE', 'npm 环境需要 node:sqlite 或宿主提供跨进程锁')
        const database: DatabaseSync = new sqlite.DatabaseSync(join(this.directory, 'lock.sqlite'))
        return database
      })
  }

  public async list(): Promise<EnvironmentState> {
    return environmentState(await this.files.readIndex())
  }

  public async search(
    input: EnvironmentSearch,
    signal: AbortSignal
  ): Promise<readonly EnvironmentPackageDescription[]> {
    const query = validateEnvironmentSearch(input)
    return environmentDescriptions(await this.options.npm.search(query.query, query.limit, signal))
  }

  public async describe(
    input: EnvironmentDescribe,
    signal: AbortSignal
  ): Promise<readonly EnvironmentPackageDescription[]> {
    environmentPackageSpec(input.package)
    return environmentDescriptions(await this.options.npm.describe(input.package, signal))
  }

  public async apply(
    input: EnvironmentApply,
    signal: AbortSignal,
    recordEffect?: EnvironmentOperationContext['recordEffect']
  ): Promise<EnvironmentState> {
    recordEffect?.('none')
    const request = validateEnvironmentApply(input)
    const names = request.install!.map(environmentPackageSpec)
    if (names.some((name) => this.options.reservedPackages?.includes(name)))
      throw new AppError('CONFLICT', '导入名已由固定 Skill 提供，请用 npm alias 安装')
    signal.throwIfAborted()
    const id = randomUUID()
    const directory = join(this.directory, 'revisions', id)
    let lease: string | undefined
    let published = false
    let retained = false
    try {
      await this.locked(async () => {
        const index = await this.files.readIndex()
        assertEnvironmentRevision(index, request.baseRevision)
        const current = index.entries.at(-1)?.generation
        const remaining = (current?.packages ?? []).filter(
          (pkg) => !request.remove!.includes(pkg.name)
        )
        if (
          new Set([...remaining.map((pkg) => pkg.name), ...names]).size > EnvironmentLimits.packages
        )
          throw new AppError('LIMIT', `环境最多直接安装 ${EnvironmentLimits.packages} 个包`)
        lease = await this.createLease([id])
        await this.files.prepare(id, current)
      })
      await this.files.remove(directory!, request.remove!)
      signal.throwIfAborted()
      recordEffect?.('unknown')
      await this.options.npm.install(
        directory!,
        request.install!,
        Boolean(request.allowScripts),
        signal
      )
      signal.throwIfAborted()
      const generation = await this.files.inspect(id)
      const state = await this.locked(async () => {
        const index = await this.files.readIndex()
        assertEnvironmentRevision(index, request.baseRevision)
        signal.throwIfAborted()
        const next = await this.publish(index, generation)
        published = true
        recordEffect?.('committed')
        return environmentState(next)
      })
      return state
    } catch (error) {
      if (isObject(error) && 'cleanupIncomplete' in error && error.cleanupIncomplete) {
        retained = true
        if (lease) await this.retainLease(lease, [id])
      }
      throw error
    } finally {
      if (!retained) {
        try {
          if (!published) await rm(directory, { recursive: true, force: true })
          if (lease) await this.releaseLease(lease)
        } catch (error) {
          Log.tag('EnvironmentRegistry').caught('保留未完成清理的 npm 环境，稍后回收', error)
        }
      }
    }
  }

  public async rollback(
    input: EnvironmentRollback,
    signal: AbortSignal,
    recordEffect?: EnvironmentOperationContext['recordEffect']
  ): Promise<EnvironmentState> {
    recordEffect?.('none')
    environmentRevision(input.baseRevision)
    environmentRevision(input.revision)
    const state = await this.locked(async () => {
      signal.throwIfAborted()
      const index = await this.files.readIndex()
      assertEnvironmentRevision(index, input.baseRevision)
      const previous = index.entries.find((entry) => entry.revision === input.revision)
      if (!previous) throw new AppError('NOT_FOUND', '目标环境版本已不在保留历史中')
      await this.files.verify(previous.generation)
      signal.throwIfAborted()
      recordEffect?.('unknown')
      const result = environmentState(await this.publish(index, previous.generation))
      recordEffect?.('committed')
      return result
    })
    await this.collectSafely()
    return state
  }

  public async acquire(signal: AbortSignal): Promise<EnvironmentLease> {
    return this.locked(async () => {
      signal.throwIfAborted()
      const index = await this.files.readIndex()
      const generation = index.entries.at(-1)?.generation
      signal.throwIfAborted()
      const lease = await this.createLease(generation ? [generation.id] : [])
      return {
        environment: {
          id: `npm:${index.revision}:${generation?.id ?? 'empty'}`,
          packages: (generation?.packages ?? []).map((pkg) => ({
            name: pkg.name,
            version: pkg.version,
            directory: pkg.directory,
          })),
          skills: [],
        },
        binDirectories: generation
          ? [join(this.directory, 'revisions', generation.id, 'node_modules', '.bin')]
          : [],
        retain: () => this.retainLease(lease, generation ? [generation.id] : []),
        release: () => this.releaseLease(lease),
      }
    })
  }

  public async collect(): Promise<void> {
    await this.locked(async () => {
      const index = await this.files.readIndex()
      const used = new Set(index.entries.map((entry) => entry.generation.id))
      const leases = join(this.directory, 'leases')
      await mkdir(leases, { recursive: true, mode: 0o700 })
      for (const name of await readdir(leases)) {
        if (!name.endsWith('.json')) continue
        const path = join(leases, name)
        const lease: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (
          !isPlainObject(lease) ||
          !Number.isSafeInteger(lease.pid) ||
          Number(lease.pid) < 1 ||
          !isArray(lease.generations) ||
          lease.generations.some((id) => !isString(id))
        )
          throw new AppError('VALIDATION', '环境租约损坏，暂不回收')
        try {
          if (!lease.retained) process.kill(Number(lease.pid), 0)
        } catch (error) {
          if (isObject(error) && 'code' in error && error.code === 'ESRCH') {
            await rm(path, { force: true })
            continue
          }
          throw error
        }
        for (const id of lease.generations) used.add(String(id))
      }
      const revisions = join(this.directory, 'revisions')
      await mkdir(revisions, { recursive: true, mode: 0o700 })
      for (const name of await readdir(revisions)) {
        if (!used.has(name) && /^[a-f0-9-]{36}$/u.test(name))
          await rm(join(revisions, name), { recursive: true, force: true })
      }
    })
  }

  private async publish(
    index: EnvironmentIndex,
    generation: EnvironmentGeneration
  ): Promise<EnvironmentIndex> {
    const revision = index.revision + 1
    environmentRevision(revision)
    const next: EnvironmentIndex = {
      format: 1,
      revision,
      entries: [
        ...index.entries,
        { revision, createdAt: new Date().toISOString(), generation },
      ].slice(-EnvironmentLimits.history),
    }
    await this.files.writeIndex(next)
    return next
  }

  private async createLease(generations: readonly string[]): Promise<string> {
    const path = join(this.directory, 'leases', `${randomUUID()}.json`)
    await writeJsonFileAtomically(path, { pid: process.pid, generations }, { mode: 0o600 })
    return path
  }

  private async releaseLease(path: string): Promise<void> {
    await this.locked(() => rm(path, { force: true }))
    await this.collectSafely()
  }

  private async retainLease(path: string, generations: readonly string[]): Promise<void> {
    await this.locked(() =>
      writeJsonFileAtomically(
        path,
        { pid: process.pid, generations, retained: true },
        { mode: 0o600 }
      )
    )
  }

  private async collectSafely(): Promise<void> {
    try {
      await this.collect()
    } catch (error) {
      Log.tag('EnvironmentRegistry').caught('环境回收稍后重试', error)
    }
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    return this.queue.run('environment', async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      if (!this.lock.acquire()) throw new AppError('CONFLICT', '环境正在被另一进程发布，请稍后重试')
      try {
        return await operation()
      } finally {
        this.lock.release()
      }
    })
  }
}

/** 为同一 agent 的全部会话创建持久环境；跨实例以目录与锁共享。 */
export function createEnvironmentRegistry(
  options: EnvironmentRegistryOptions
): EnvironmentRegistryApi {
  return new EnvironmentRegistry(options)
}
