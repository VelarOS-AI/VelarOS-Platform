import { readFile } from 'node:fs/promises'

import { KernelClientError } from '../../utils/errors-client'
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
      throw new KernelClientError(
        'DAEMON_NOT_RUNNING',
        'Kernel daemon endpoint is not available',
        'Start the shared Kernel (or let the launcher start it) before connecting.',
      )
    }
    if (error instanceof SyntaxError) {
      throw new KernelClientError(
        'DAEMON_DESCRIPTOR_INVALID',
        'Kernel daemon endpoint descriptor is invalid',
      )
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
      throw new KernelClientError(
        'DAEMON_DESCRIPTOR_INVALID',
        'Kernel daemon descriptor does not match the running endpoint',
      )
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
  throw new KernelClientError(
    'PROTOCOL_VERSION_MISMATCH',
    `Kernel daemon speaks protocol v${peerVersion}; this client speaks v${KernelProtocolVersion}`,
    negotiation.status === 'rejected' ? negotiation.guidance : undefined,
  )
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && error.code === code
}
