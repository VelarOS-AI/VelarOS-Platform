import { randomBytes, randomUUID } from 'node:crypto'
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'

import { isNotUndefined, isNull, isObject, isUndefined, Log } from '@velaros-ai/core'
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

    await mkdir(dirname(this.paths.lockPath), {
      recursive: true,
      mode: 0o700,
    })
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
      const ownerPid = await readLockOwnerPid(lockPath)
      if (isNotUndefined(ownerPid) && isProcessAlive(ownerPid)) {
        throw new KernelDaemonError(
          'DAEMON_ALREADY_RUNNING',
          'A Kernel daemon already owns the local endpoint',
        )
      }
      await unlink(lockPath).catch(ignoreMissing)
    }
  }
  throw new KernelDaemonError(
    'DAEMON_LOCK_FAILED',
    'Kernel daemon lock could not be acquired',
  )
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
