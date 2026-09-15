/**
 * VelarOS 产品家族共享资源目录：`VelarOSSharedResources` 与唯一的 `velarosSharedResources`。接口见 `interface/provides.ts` 的 `VelarOSSharedResourcesApi`。
 * 只算路径，不建目录、不写盘；只在 Node 里用。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import type { VelarOSSharedResourceStoreOptions } from '../contract/platform.js'
import type { VelarOSSharedResourcesApi } from '../interface/provides.js'

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
