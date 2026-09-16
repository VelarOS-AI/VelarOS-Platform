import { readFile } from 'node:fs/promises'

import { KernelClientErrorCodes } from '../../contract/constants'
import { KernelClientError } from '../../utils/errors'
import {
  createDefaultKernelDaemonPaths,
  type KernelDaemonEndpointDescriptor,
  type KernelDaemonPaths,
  parseKernelDaemonDescriptor,
} from '../../utils/rpc/descriptor'
import type { KernelHandshake } from '../../utils/wire/handshake'
import { negotiateKernelProtocol } from '../../utils/wire/negotiation'
import { KernelProtocolVersion } from '../../utils/wire/version'

import { KernelClient } from './KernelClient'
import { SocketKernelTransport } from './SocketKernelTransport'

export interface ConnectedKernelDaemon {
  readonly client: KernelClient
  readonly descriptor: KernelDaemonEndpointDescriptor
  readonly handshake: KernelHandshake
}

/** Reads the descriptor a running Kernel daemon published for this user. */
export async function discoverKernelDaemon(
  paths: KernelDaemonPaths = createDefaultKernelDaemonPaths(),
): Promise<KernelDaemonEndpointDescriptor> {
  let input: unknown
  try {
    input = JSON.parse(
      await readFile(paths.descriptorPath, 'utf8'),
    ) as unknown
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

/**
 * Discovers, connects to, and verifies the shared Kernel daemon.
 *
 * The descriptor version is checked before the socket is trusted, and the
 * live handshake must agree with it, so a stale descriptor left behind by a
 * previous Kernel build cannot silently route calls to the wrong runtime.
 */
export async function connectToKernelDaemon(
  paths: KernelDaemonPaths = createDefaultKernelDaemonPaths(),
): Promise<ConnectedKernelDaemon> {
  const descriptor = await discoverKernelDaemon(paths)
  // 认证令牌发出去之前先核 descriptor 的协议版本：本来的顺序是先 handshake（令牌已经写上
  // 线）再核版本，和注释说的「先核对 descriptor 版本再信任 socket」正好相反。
  assertProtocolCompatible(descriptor.protocolVersion)
  const client = new KernelClient(
    new SocketKernelTransport({
      authToken: descriptor.authToken,
      endpoint: descriptor.endpoint,
    }),
  )
  try {
    const handshake = await client.handshake()
    assertProtocolCompatible(handshake.protocolVersion)
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

function assertProtocolCompatible(peerVersion: number): void {
  if (peerVersion === KernelProtocolVersion) return
  const negotiation = negotiateKernelProtocol({ protocolVersion: peerVersion })
  throw new KernelClientError({
    code: KernelClientErrorCodes.protocolVersionMismatch,
    message: `Kernel 守护进程说的是协议 v${peerVersion}，本客户端说的是 v${KernelProtocolVersion}`,
    guidance: negotiation.status === 'rejected' ? negotiation.guidance : undefined,
  })
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && error.code === code
}
