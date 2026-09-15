/**
 * VelarOS 产品家族共享资源目录：`VelarOSSharedResources` 与唯一的 `velarosSharedResources`。接口见 `interface/provides.ts` 的 `VelarOSSharedResourcesApi`。
 * 只算路径，不建目录、不写盘；只在 Node 里用。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import type { VelarOSSharedResourceStoreOptions } from '../types/options.js'

/**
 * VelarOS 产品家族共享资源目录：各产品共用的数据、可重新下载的资源、账号会话放在哪，实例是 `velarosSharedResources`。
 * 只算路径，不建目录、不写盘；只在 Node 里用。
 */
export interface VelarOSSharedResourcesApi {
  /** 共享数据的根目录：按平台放在用户数据目录下的 VelarOS 目录；环境变量 VELAROS_SHARED_DATA_ROOT 可以覆盖。 */
  dataRoot(options?: VelarOSSharedResourceStoreOptions): string
  /** 共享资源目录：「共享数据根/shared/resources」，只放可以重新下载的安装产物。 */
  resourcesRoot(options?: VelarOSSharedResourceStoreOptions): string
  /** 共享账号会话目录：「共享数据根/shared/account/v1」。 */
  accountRoot(options?: VelarOSSharedResourceStoreOptions): string
}

export class VelarOSSharedResources implements VelarOSSharedResourcesApi {
  public dataRoot(options: VelarOSSharedResourceStoreOptions = {}): string {
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

  public resourcesRoot(options: VelarOSSharedResourceStoreOptions = {}): string {
    return join(this.dataRoot(options), 'shared', 'resources')
  }

  public accountRoot(options: VelarOSSharedResourceStoreOptions = {}): string {
    return join(this.dataRoot(options), 'shared', 'account', 'v1')
  }
}

/** 整个进程只有一份的共享资源目录解析。 */
export const velarosSharedResources: VelarOSSharedResourcesApi = new VelarOSSharedResources()
