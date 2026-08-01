import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { KernelDaemonPaths } from '@velaros-ai/kernel-client/contracts'

export interface VelarHostPaths {
  readonly dataRoot: string
  readonly runtimeRoot: string
  readonly kernel: KernelDaemonPaths
  readonly modsRoot: string
  readonly configPath: string
  readonly credentialPath: string
  readonly controlTokenPath: string
  readonly statusPath: string
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
  }
}
