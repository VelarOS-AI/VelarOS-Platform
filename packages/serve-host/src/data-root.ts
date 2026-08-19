import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { KernelDaemonPaths } from '@velaros-ai/kernel/client/contracts'

export interface VelarHostPaths {
  readonly dataRoot: string
  readonly runtimeRoot: string
  readonly kernel: KernelDaemonPaths
  readonly modsRoot: string
  readonly configPath: string
  readonly credentialPath: string
  readonly managementEndpoint: string
  readonly statusPath: string
  /** 远程节点的已配对客户端公钥；与插件设备凭据分目录，互不影响撤销。 */
  readonly remoteNodeCredentialPath: string
  /** 跨机调用的审计目录；只落元数据，不落任何调用载荷。 */
  readonly auditRoot: string
}

export function defaultVelarHostDataRoot(): string {
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'VelarOS', 'Host')
    case 'win32':
      return join(process.env.APPDATA ?? homedir(), 'VelarOS', 'Host')
    default:
      return join(
        process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
        'velaros',
        'host',
      )
  }
}

export function createVelarHostPaths(dataRoot?: string): VelarHostPaths {
  const root = resolve(dataRoot?.trim() || defaultVelarHostDataRoot())
  const runtimeRoot = join(root, 'runtime')
  return {
    dataRoot: root,
    runtimeRoot,
    kernel: {
      descriptorPath: join(runtimeRoot, 'kernel.endpoint.json'),
      lockPath: join(runtimeRoot, 'kernel.lock'),
      socketPath: join(runtimeRoot, 'kernel.sock'),
    },
    modsRoot: join(root, 'kernel'),
    configPath: join(root, 'host-config.json'),
    credentialPath: join(root, 'extension', 'device.json'),
    managementEndpoint: createVelarHostManagementEndpoint(runtimeRoot),
    statusPath: join(root, 'host.json'),
    remoteNodeCredentialPath: join(root, 'remoteNode', 'client.json'),
    auditRoot: join(root, 'audit'),
  }
}

/**
 * Returns the OS-local management endpoint for one Host runtime root.
 *
 * Windows pipe names cannot safely contain a filesystem path, so they use a stable digest instead.
 * Unix keeps the socket inside the private runtime directory so its filesystem permissions are the
 * access boundary; no TCP port or bearer token is involved.
 */
export function createVelarHostManagementEndpoint(
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const identity = createHash('sha256').update(resolve(runtimeRoot)).digest('hex').slice(0, 24)
    return `\\\\.\\pipe\\velaros-host-${identity}`
  }
  return join(runtimeRoot, 'management.sock')
}
