import { readFile } from 'node:fs/promises'

import { KernelClientErrorCodes } from '../../contract/constants'
import type { KernelDaemonEndpointDescriptor, KernelDaemonPaths } from '../../types/kernel'
import type { KernelHandshake } from '../../types/wire'
import { KernelClientError } from '../../utils/errors'
import { isNodeError } from '../../utils/fs'
import {
  createDefaultKernelDaemonPaths,
  parseKernelDaemonDescriptor,
} from '../../utils/rpc/descriptor'
import { negotiateKernelProtocol } from '../../utils/wire/negotiation'
import { KernelProtocolVersion } from '../../utils/wire/version'

import { KernelClient, type KernelClientApi } from './KernelClient'
import { SocketKernelTransport } from './SocketKernelTransport'

/** 连上共享守护进程之后交出来的三件套：能用的客户端、它的 descriptor 与那次握手。 */
export interface KernelDaemonDirectoryConnection {
  /** 已经握过手、协议核对通过的客户端。 */
  readonly client: KernelClientApi
  /** 守护进程发布的端点 descriptor（端点、令牌、版本都在里面）。 */
  readonly descriptor: KernelDaemonEndpointDescriptor
  /** 那次握手的回应，内核版本已经和 descriptor 对上。 */
  readonly handshake: KernelHandshake
}

/**
 * 本机共享 Kernel 守护进程的目录：算落点、读 descriptor、连上去。
 *
 * 实例是进程内唯一的 `kernelDaemons`。它只负责「找到并连上已经在跑的那个守护进程」，不起也
 * 不停守护进程——起停是 `KernelLauncher` 的事。
 */
export interface KernelDaemonDirectoryApi {
  /** 算出守护进程在本机的落点（运行目录、descriptor、socket、单实例锁）；`name` 用来隔开同机多实例，缺席就是共享的那一份。 */
  defaultPaths(name?: string): KernelDaemonPaths
  /** 读出正在跑的守护进程发布的端点 descriptor；没有在跑抛 DAEMON_NOT_RUNNING，内容不合法抛 DAEMON_DESCRIPTOR_INVALID。 */
  discover(paths?: KernelDaemonPaths): Promise<KernelDaemonEndpointDescriptor>
  /** 发现、连上、核对协议与内核版本，交出客户端、descriptor 与握手结果；任何一步失败都会先把连接关掉再抛 KernelClientError。 */
  connect(paths?: KernelDaemonPaths): Promise<KernelDaemonDirectoryConnection>
}

export class KernelDaemonDirectory implements KernelDaemonDirectoryApi {
  /** 本客户端说的协议版本；对端报的版本必须和它完全相同。 */
  private readonly protocolVersion = KernelProtocolVersion

  public defaultPaths(name?: string): KernelDaemonPaths {
    return createDefaultKernelDaemonPaths(name)
  }

  public async discover(
    paths: KernelDaemonPaths = this.defaultPaths()
  ): Promise<KernelDaemonEndpointDescriptor> {
    let input: unknown
    try {
      input = JSON.parse(await readFile(paths.descriptorPath, 'utf8')) as unknown
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw new KernelClientError({
          code: KernelClientErrorCodes.daemonNotRunning,
          message: '本机没有可用的 Kernel 守护进程端点',
          guidance: '先启动共享 Kernel（或交给启动器去起）再连接。',
        })
      }
      if (error instanceof SyntaxError) {
        throw new KernelClientError({
          code: KernelClientErrorCodes.daemonDescriptorInvalid,
          message: 'Kernel 守护进程的端点 descriptor 不合法',
        })
      }
      throw error
    }
    return parseKernelDaemonDescriptor(input)
  }

  public async connect(
    paths: KernelDaemonPaths = this.defaultPaths()
  ): Promise<KernelDaemonDirectoryConnection> {
    const descriptor = await this.discover(paths)
    // 认证令牌发出去之前先核 descriptor 的协议版本：本来的顺序是先 handshake（令牌已经写上
    // 线）再核版本，和注释说的「先核对 descriptor 版本再信任 socket」正好相反。
    this.assertProtocolCompatible(descriptor.protocolVersion)
    const client = new KernelClient(
      new SocketKernelTransport({
        authToken: descriptor.authToken,
        endpoint: descriptor.endpoint,
      })
    )
    try {
      const handshake = await client.handshake()
      this.assertProtocolCompatible(handshake.protocolVersion)
      if (handshake.kernelVersion !== descriptor.kernelVersion) {
        throw new KernelClientError({
          code: KernelClientErrorCodes.daemonDescriptorInvalid,
          message: 'descriptor 与正在跑的 Kernel 端点对不上',
        })
      }
      return { client, descriptor, handshake }
    } catch (error) {
      await client.dispose()
      throw error
    }
  }

  /** 对端报的协议版本必须和本客户端完全相同；不同就抛 PROTOCOL_VERSION_MISMATCH，并把升级方向带上。 */
  private assertProtocolCompatible(peerVersion: number): void {
    if (peerVersion === this.protocolVersion) return
    const negotiation = negotiateKernelProtocol({ protocolVersion: peerVersion })
    throw new KernelClientError({
      code: KernelClientErrorCodes.protocolVersionMismatch,
      message: `Kernel 守护进程说的是协议 v${peerVersion}，本客户端说的是 v${this.protocolVersion}`,
      guidance: negotiation.status === 'rejected' ? negotiation.guidance : undefined,
    })
  }
}

/** 进程内唯一的守护进程目录。 */
export const kernelDaemons: KernelDaemonDirectoryApi = new KernelDaemonDirectory()
