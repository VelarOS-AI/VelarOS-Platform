import { randomBytes, randomUUID } from 'node:crypto'
import { type FileHandle, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isUndefined, Log } from '@velaros-ai/core'

import type {
  KernelDaemonEndpointDescriptor,
  KernelDaemonPaths,
  KernelRpcEndpoint,
} from '../../types/kernel'
import { ignoreMissing } from '../../utils/fs'
import { createDefaultKernelDaemonPaths } from '../../utils/rpc/descriptor'
import {
  acquireKernelDaemonLock,
  assertKernelRuntimeDirectoryIsPrivate,
  writeKernelDaemonDescriptor,
} from '../../utils/serve/daemon-process'

import { KernelLocalRpcServer } from './KernelLocalRpcServer'
import type { KernelServiceApi } from './KernelService'

const log = Log.tag('KernelDaemon')

/** 起一个本机守护进程要交进来的东西：听哪个端点、三条路径、代理哪个服务面。 */
export interface KernelLocalDaemonOptions {
  /** 显式指定的 RPC 端点；不给就按平台选（Windows 走回环 TCP，其余走 unix socket）。 */
  readonly endpoint?: KernelRpcEndpoint
  /** descriptor、锁与 socket 的落点；不给就用缺省的运行目录。 */
  readonly paths?: KernelDaemonPaths
  /** 这个守护进程对外暴露的服务面。 */
  readonly service: KernelServiceApi
}

/**
 * 本机单实例 sidecar 的生命周期；实例归装配 Kernel 进程的那一处。
 *
 * 独占锁在 RPC 端点起来之前就先拿到。产品发现的是同一份 descriptor，于是连到同一个 Kernel
 * 真身上，而不是各自悄悄建出几份宿主与状态库。
 */
export interface KernelLocalDaemonApi {
  /** 抢锁、起 RPC 端点、发布 descriptor；已经在跑就回现有的 descriptor，已回收则抛错。 */
  start(): Promise<KernelDaemonEndpointDescriptor>
  /** 回已发布的端点 descriptor；还没启动时抛错。 */
  getDescriptor(): KernelDaemonEndpointDescriptor
  /** 停掉 RPC 端点、删掉 descriptor 与锁；重复调用无副作用。 */
  dispose(): Promise<void>
}

/** 本机单实例守护进程。 */
export class KernelLocalDaemon implements KernelLocalDaemonApi {
  private readonly paths: KernelDaemonPaths
  private readonly instanceId = randomUUID()
  // 认证令牌要够长才挡得住猜：32 字节随机数，按 base64url 编码进 descriptor。
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
        throw new Error('已回收的 Kernel 守护进程不能再启动')
      case 'running':
        return this.getDescriptor()
      case 'idle':
        break
    }

    const runtimeDirectory = dirname(this.paths.lockPath)
    await mkdir(runtimeDirectory, {
      recursive: true,
      // 运行目录里有令牌与 socket：只给属主进出。
      mode: 0o700,
    })
    await assertKernelRuntimeDirectoryIsPrivate(runtimeDirectory)
    this.lockHandle = await acquireKernelDaemonLock(
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
      await writeKernelDaemonDescriptor(this.paths.descriptorPath, descriptor)
      this.descriptor = descriptor
      this.state = 'running'
      return descriptor
    } catch (error) {
      await this.server?.dispose().catch((cleanupError) => {
        log.warn('启动出错后回收 Kernel RPC 服务端时又失败了', { error: cleanupError })
      })
      this.server = undefined
      await this.releaseOwnership()
      throw error
    }
  }

  public getDescriptor(): KernelDaemonEndpointDescriptor {
    if (isUndefined(this.descriptor)) {
      throw new Error('Kernel 守护进程还没启动')
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

  /** 交还本实例占着的东西：删 descriptor、关锁句柄、删锁文件。 */
  private async releaseOwnership(): Promise<void> {
    if (isUndefined(this.lockHandle)) return
    await unlink(this.paths.descriptorPath).catch(ignoreMissing)
    await this.lockHandle.close().catch((error: unknown) => {
      log.warn('Kernel 守护进程的锁句柄关不掉', { error })
    })
    this.lockHandle = undefined
    await unlink(this.paths.lockPath).catch(ignoreMissing)
  }
}
