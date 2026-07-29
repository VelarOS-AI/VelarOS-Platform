import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { assertKernelVersion } from './version'

/**
 * Absolute paths the updater owns. Every path is derived from a single root so
 * a product can install a private Kernel without colliding with the shared one.
 */
export interface KernelInstallLayout {
  readonly root: string
  readonly versionsDirectory: string
  readonly pointerPath: string
  readonly runtimeDirectory: string
  readonly dataDirectory: string
  readonly backupsDirectory: string
  readonly stagingDirectory: string
  readonly lockPath: string
}

export const KernelInstallRootVariable = 'VELAROS_KERNEL_HOME'

export function defaultKernelInstallRoot(): string {
  const configured = process.env[KernelInstallRootVariable]
  if (configured !== undefined && configured.trim().length > 0) return configured
  if (process.platform === 'darwin') return darwinInstallRoot()
  if (process.platform === 'win32') return windowsInstallRoot()
  return xdgInstallRoot()
}

function darwinInstallRoot(): string {
  return join(homedir(), 'Library', 'Application Support', 'VelarOS', 'kernel')
}

function windowsInstallRoot(): string {
  const localAppData = process.env.LOCALAPPDATA
  const base = localAppData !== undefined && localAppData.trim().length > 0
    ? localAppData
    : join(homedir(), 'AppData', 'Local')
  return join(base, 'VelarOS', 'kernel')
}

function xdgInstallRoot(): string {
  const dataHome = process.env.XDG_DATA_HOME
  const base = dataHome !== undefined && dataHome.trim().length > 0
    ? dataHome
    : join(homedir(), '.local', 'share')
  return join(base, 'velaros', 'kernel')
}

export function createKernelInstallLayout(
  root: string = defaultKernelInstallRoot(),
): KernelInstallLayout {
  return {
    root,
    versionsDirectory: join(root, 'versions'),
    pointerPath: join(root, 'current.json'),
    runtimeDirectory: join(root, 'runtime'),
    dataDirectory: join(root, 'data'),
    backupsDirectory: join(root, 'backups'),
    stagingDirectory: join(root, '.staging'),
    lockPath: join(root, 'update.lock'),
  }
}

/** Version strings are validated before use so they can never escape `versions/`. */
export function kernelVersionDirectory(
  layout: KernelInstallLayout,
  version: string,
): string {
  assertKernelVersion(version)
  return join(layout.versionsDirectory, version)
}

export async function ensureKernelInstallLayout(
  layout: KernelInstallLayout,
): Promise<void> {
  for (const directory of [
    layout.root,
    layout.versionsDirectory,
    layout.runtimeDirectory,
    layout.dataDirectory,
    layout.backupsDirectory,
    layout.stagingDirectory,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  }
}
