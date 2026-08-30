import { homedir } from 'node:os'
import { join } from 'node:path'

interface VelarOSSharedResourceStoreOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
}

/**
 * VelarOS 产品族共享数据根的磁盘 ABI v1。
 *
 * `shared/resources` 只承载可重新下载的安装产物；`shared/account` 承载当前系统用户下
 * 各 VelarOS 产品可选择复用的账号会话。产品配置、项目索引、缓存与启停状态不得写入这里。
 * VELAROS_SHARED_DATA_ROOT 供便携部署与测试显式改根。
 */
function resolveVelarOSSharedDataRoot(
  options: VelarOSSharedResourceStoreOptions = {}
): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const homeDirectory = options.homeDirectory ?? homedir()
  const override = env['VELAROS_SHARED_DATA_ROOT']?.trim()
  if (override) return override

  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA']?.trim()
    const appData = env['APPDATA']?.trim()
    return join(localAppData || appData || join(homeDirectory, 'AppData', 'Local'), 'VelarOS')
  }

  if (platform === 'darwin')
    return join(homeDirectory, 'Library', 'Application Support', 'VelarOS')

  const xdgDataHome = env['XDG_DATA_HOME']?.trim()
  return join(xdgDataHome || join(homeDirectory, '.local', 'share'), 'VelarOS')
}

/** 组织级资源根：<VelarOS shared data>/shared/resources/<resource-id>/... */
function resolveVelarOSSharedResourcesRoot(
  options: VelarOSSharedResourceStoreOptions = {}
): string {
  return join(resolveVelarOSSharedDataRoot(options), 'shared', 'resources')
}

/** 组织级账号根：<VelarOS shared data>/shared/account/v1。 */
function resolveVelarOSSharedAccountRoot(
  options: VelarOSSharedResourceStoreOptions = {}
): string {
  return join(resolveVelarOSSharedDataRoot(options), 'shared', 'account', 'v1')
}

export {
  resolveVelarOSSharedAccountRoot,
  resolveVelarOSSharedDataRoot,
  resolveVelarOSSharedResourcesRoot,
  type VelarOSSharedResourceStoreOptions,
}
