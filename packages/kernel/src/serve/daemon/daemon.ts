import { randomBytes, randomUUID } from 'node:crypto'
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  isFunction,
  isNotUndefined,
  isNull,
  isObject,
  isUndefined,
  Log,
} from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'
import {
  createDefaultKernelDaemonPaths,
  type KernelDaemonEndpointDescriptor,
  type KernelDaemonPaths,
  type KernelRpcEndpoint,
} from '@velaros-ai/kernel/client/contracts'
import type { KernelService } from '@velaros-ai/kernel/runtime'

import { KernelLocalRpcServer } from '../rpc/local-rpc-server'

const log = Log.tag('KernelDaemon')

export interface KernelLocalDaemonOptions {
  readonly endpoint?: KernelRpcEndpoint
  readonly paths?: KernelDaemonPaths
  readonly service: KernelService
}

export type KernelDaemonErrorCode =
  | 'DAEMON_ALREADY_RUNNING'
  | 'DAEMON_LOCK_FAILED'

export class KernelDaemonError extends Error {
  public constructor(
    public readonly code: KernelDaemonErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'KernelDaemonError'
  }
}

/**
 * Single-instance local sidecar lifecycle.
 *
 * The exclusive lock is acquired before the RPC endpoint starts. Products
 * discover the same descriptor and connect to one Kernel truth rather than
 * silently constructing separate hosts and state stores.
 */
export class KernelLocalDaemon {
  private readonly paths: KernelDaemonPaths
  private readonly instanceId = randomUUID()
  private readonly authToken = randomBytes(32).toString('base64url')
  private lockHandle?: FileHandle
  private server?: KernelLocalRpcServer
  private descriptor?: KernelDaemonEndpointDescriptor
  private state: 'idle' | 'running' | 'disposed' = 'idle'

  public constructor(private readonly options: KernelLocalDaemonOptions) {
    this.paths = options.paths ?? createDefaultKernelDaemonPaths()
  }

  public async start(): Promise<KernelDaemonEndpointDescriptor> {
    switch (this.state) {
      case 'disposed':
        throw new Error('Disposed Kernel daemon cannot be started')
      case 'running':
        return this.getDescriptor()
      case 'idle':
        break
    }

    const runtimeDirectory = dirname(this.paths.lockPath)
    await mkdir(runtimeDirectory, {
      recursive: true,
      mode: 0o700,
    })
    await assertRuntimeDirectoryIsPrivate(runtimeDirectory)
    this.lockHandle = await acquireDaemonLock(
      this.paths.lockPath,
      this.instanceId,
    )
    try {
      const endpoint = this.options.endpoint
        ?? (
          process.platform === 'win32'
            ? { kind: 'tcp', host: '127.0.0.1', port: 0 } as const
            : { kind: 'unix', path: this.paths.socketPath } as const
        )
      this.server = new KernelLocalRpcServer({
        authToken: this.authToken,
        endpoint,
        service: this.options.service,
      })
      const resolvedEndpoint = await this.server.start()
      const handshake = this.options.service.handshake()
      const descriptor: KernelDaemonEndpointDescriptor = {
        authToken: this.authToken,
        instanceId: this.instanceId,
        protocolVersion: handshake.protocolVersion,
        kernelVersion: handshake.kernelVersion,
        pid: process.pid,
        startedAt: Date.now(),
        endpoint: resolvedEndpoint,
      }
      await writeDescriptor(this.paths.descriptorPath, descriptor)
      this.descriptor = descriptor
      this.state = 'running'
      return descriptor
    } catch (error) {
      await this.server?.dispose().catch((cleanupError) => {
        log.warn('Kernel RPC server cleanup failed after startup error', { error: cleanupError })
      })
      this.server = undefined
      await this.releaseOwnership()
      throw error
    }
  }

  public getDescriptor(): KernelDaemonEndpointDescriptor {
    if (isUndefined(this.descriptor)) {
      throw new Error('Kernel daemon has not started')
    }
    return this.descriptor
  }

  public async dispose(): Promise<void> {
    if (this.state === 'disposed') return
    this.state = 'disposed'
    try {
      await this.server?.dispose()
    } finally {
      this.server = undefined
      this.descriptor = undefined
      await this.releaseOwnership()
    }
  }

  private async releaseOwnership(): Promise<void> {
    if (isUndefined(this.lockHandle)) return
    await unlink(this.paths.descriptorPath).catch(ignoreMissing)
    await this.lockHandle.close().catch((error) => {
      log.warn('Kernel daemon lock handle failed to close', { error })
    })
    this.lockHandle = undefined
    await unlink(this.paths.lockPath).catch(ignoreMissing)
  }
}

/** 读不出属主时的重读次数与间隔（见 {@link acquireDaemonLock}）。 */
const lockOwnerReadRetries = 5
const lockOwnerReadRetryMs = 20

async function acquireDaemonLock(
  lockPath: string,
  instanceId: string,
): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(
        JSON.stringify({ instanceId, pid: process.pid }),
        'utf8',
      )
      return handle
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error
      // `open('wx')` 成功与「写进 pid」之间有一小段窗口：读不出属主时短暂重读，别把对方正在
      // 成型的锁当死锁删掉（真实竞态下会变成两个守护进程同时持锁）。
      // 同一段逻辑在 `serve/updater/lock.ts` 也有一份；合并成一处留给改造。
      const ownerPid = await readLockOwnerPidWithRetry(lockPath)
      if (isNotUndefined(ownerPid)) {
        if (isProcessAlive(ownerPid)) {
          throw new KernelDaemonError(
            'DAEMON_ALREADY_RUNNING',
            '本机端点已经被另一个 Kernel 守护进程占用',
          )
        }
        await unlink(lockPath).catch(ignoreMissing)
        continue
      }
      throw new KernelDaemonError(
        'DAEMON_LOCK_FAILED',
        `Kernel 守护进程锁存在但读不出属主，按被占用处理；若确认没有 Kernel 在跑，删掉 ${lockPath} 后重试`,
      )
    }
  }
  throw new KernelDaemonError(
    'DAEMON_LOCK_FAILED',
    'Kernel 守护进程锁获取失败',
  )
}

async function readLockOwnerPidWithRetry(
  path: string,
): Promise<number | undefined> {
  for (let attempt = 0; attempt <= lockOwnerReadRetries; attempt += 1) {
    const pid = await readLockOwnerPid(path)
    if (isNotUndefined(pid)) return pid
    if (attempt < lockOwnerReadRetries) {
      await TimerScope.sleep(lockOwnerReadRetryMs, {
        label: 'KernelDaemon.lockOwnerRead',
      })
    }
  }
  return undefined
}

/**
 * 运行目录必须归自己所有、且只有自己能进。
 *
 * 缺省落点在共享的 `<tmpdir>/velaros-kernel-<uid>`：另一个用户预先建好这个目录，就能替换
 * descriptor 把客户端引到自己的 socket，客户端会把认证令牌发过去。`mkdir` 的 `mode` 只在
 * **新建**时生效，目录已存在时既不改权限也不核属主——这里补上这道闸。
 *
 * Windows 没有 POSIX 属主与模式位（`process.getuid` 不存在），跳过。
 */
async function assertRuntimeDirectoryIsPrivate(directory: string): Promise<void> {
  if (!isFunction(process.getuid)) return
  const stats = await stat(directory)
  const uid = process.getuid()
  if (stats.uid !== uid) {
    throw new KernelDaemonError(
      'DAEMON_LOCK_FAILED',
      `Kernel 运行目录 ${directory} 属于 uid ${stats.uid}，不是当前用户（uid ${uid}），拒绝使用`,
    )
  }
  const groupAndOtherBits = stats.mode & 0o077
  if (groupAndOtherBits !== 0) {
    throw new KernelDaemonError(
      'DAEMON_LOCK_FAILED',
      `Kernel 运行目录 ${directory} 的权限是 ${(stats.mode & 0o777).toString(8)}，对同机其他用户开放，拒绝使用（应为 700）`,
    )
  }
}

async function readLockOwnerPid(path: string): Promise<number | undefined> {
  try {
    const input = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isObject(input) && !isNull(input) || isNull(input)) return undefined
    const pid = Reflect.get(input, 'pid')
    return Number.isInteger(pid) && (pid as number) > 0
      ? pid as number
      : undefined
  } catch (error) {
    log.debug('Kernel daemon lock owner could not be read', { error, path })
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

async function writeDescriptor(
  path: string,
  descriptor: KernelDaemonEndpointDescriptor,
): Promise<void> {
  const temporaryPath = `${path}.${descriptor.instanceId}.tmp`
  await writeFile(
    temporaryPath,
    `${JSON.stringify(descriptor)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
  await rename(temporaryPath, path)
}

function ignoreMissing(error: unknown): void {
  if (!isNodeError(error, 'ENOENT')) throw error
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && error.code === code
}
