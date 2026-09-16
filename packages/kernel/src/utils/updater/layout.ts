import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { isBlank, isNotUndefined } from '@velaros-ai/core'

import type { KernelInstallLayout } from '../../types/updater'

import { assertKernelVersion } from './version'

export type { KernelInstallLayout } from '../../types/updater'
/** 指定共享内核安装根的环境变量名。 */
export const KernelInstallRootVariable = 'VELAROS_KERNEL_HOME'

/** 按平台算出缺省的安装根；登记过的环境变量优先。 */
export function defaultKernelInstallRoot(): string {
  const configured = process.env[KernelInstallRootVariable]
  if (isNotUndefined(configured) && !isBlank(configured.trim())) return configured
  switch (process.platform) {
    case 'darwin':
      return darwinInstallRoot()
    case 'win32':
      return windowsInstallRoot()
    default:
      return xdgInstallRoot()
  }
}

/** macOS 上的安装根：`~/Library/Application Support/VelarOS/kernel`。 */
function darwinInstallRoot(): string {
  return join(homedir(), 'Library', 'Application Support', 'VelarOS', 'kernel')
}

/** Windows 上的安装根：`%LOCALAPPDATA%\VelarOS\kernel`，变量没设时按家目录折出来。 */
function windowsInstallRoot(): string {
  const localAppData = process.env.LOCALAPPDATA
  const base = isNotUndefined(localAppData) && !isBlank(localAppData.trim())
    ? localAppData
    : join(homedir(), 'AppData', 'Local')
  return join(base, 'VelarOS', 'kernel')
}

/** 其余平台按 XDG 约定：`$XDG_DATA_HOME/velaros/kernel`，变量没设时用 `~/.local/share`。 */
function xdgInstallRoot(): string {
  const dataHome = process.env.XDG_DATA_HOME
  const base = isNotUndefined(dataHome) && !isBlank(dataHome.trim())
    ? dataHome
    : join(homedir(), '.local', 'share')
  return join(base, 'velaros', 'kernel')
}

/** 从一个安装根派生出更新器要用的全部绝对路径。 */
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

/** 某个版本的安装目录；版本号先校验过，所以它永远逃不出 `versions/`。 */
export function kernelVersionDirectory(
  layout: KernelInstallLayout,
  version: string,
): string {
  assertKernelVersion(version)
  return join(layout.versionsDirectory, version)
}

/** 把布局里的目录挨个建出来（只有属主可进）；已经在了就什么都不做。 */
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
