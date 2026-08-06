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
  readonly controlTokenPath: string
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
    controlTokenPath: join(root, 'control', 'token'),
    statusPath: join(root, 'host.json'),
    remoteNodeCredentialPath: join(root, 'remoteNode', 'client.json'),
    auditRoot: join(root, 'audit'),
  }
}
