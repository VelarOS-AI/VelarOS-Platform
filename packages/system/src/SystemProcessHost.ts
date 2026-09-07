import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CommandSpec } from './SystemPlatformCompatibility'

export interface SystemProcessHostOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  hostPath?: string
  parentPid?: number
  isFile?: (path: string) => boolean
}

/** Process ownership is independent of filesystem/network confinement. */
export interface SystemProcessOwnership {
  backend: 'windows-job' | 'process-tree'
  parentDeathCleanup: boolean
  reason: string
}

export function getSystemProcessHostPath(options: SystemProcessHostOptions = {}): string | null {
  if ((options.platform ?? process.platform) !== 'win32') return null
  const configured = options.hostPath ?? options.env?.VELAROS_PROCESS_HOST ?? process.env.VELAROS_PROCESS_HOST
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    configured,
    resources ? join(resources, 'windows-execution', 'velaros-process-host.exe') : undefined,
    import.meta.url ? fileURLToPath(new URL(`../native/win32-${process.arch}/velaros-process-host.exe`, import.meta.url)) : undefined,
  ]
  const probe = options.isFile ?? existsSync
  return candidates.find((candidate): candidate is string => !!candidate && isAbsolute(candidate) && probe(candidate)) ?? null
}

export function buildSystemOwnedProcessSpec(
  spec: CommandSpec & { windowsVerbatimArguments?: boolean },
  options: SystemProcessHostOptions = {}
): { spec: CommandSpec; ownership: SystemProcessOwnership } {
  const host = getSystemProcessHostPath(options)
  if (!host) return {
    spec,
    ownership: { backend: 'process-tree', parentDeathCleanup: false, reason: 'native-host-unavailable' },
  }
  return {
    spec: { file: host, args: [
      '--parent-pid', String(options.parentPid ?? process.pid),
      ...(spec.windowsVerbatimArguments ? ['--verbatim-arguments'] : []),
      '--', spec.file, ...spec.args,
    ] },
    ownership: { backend: 'windows-job', parentDeathCleanup: true, reason: 'native-job-host' },
  }
}
