/** MarkItDown 资源根的推导：环境变量根、Electron 资源目录、VelarOS 家族共用的资源安装根。 */

import { delimiter, join, resolve } from 'node:path'

import { isEmpty } from '@velaros-ai/core'
import { velarosSharedResources } from '@velaros-ai/platform/shared-resources'

import { OfficeEnvironmentVariables } from '../contract/constants.js'

/** 读 Electron 打包产物的 resources 目录；不在 Electron 里跑时返回 null。 */
export function readElectronResourcesPath(): Nullable<string> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return resourcesPath?.trim() ? resourcesPath : null
}

/** 读环境变量里配置的资源根；配了就只认它，不再猜默认根。 */
export function readEnvironmentResourceRoots(): string[] {
  const configured = process.env[OfficeEnvironmentVariables.markItDownResourceRoot]?.trim()
  if (!configured) return []
  return configured
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/** 推导本机可能装着 MarkItDown 的资源根，按优先级排列。 */
export function buildDefaultResourceRoots(): string[] {
  const environmentRoots = readEnvironmentResourceRoots()
  if (!isEmpty(environmentRoots)) return environmentRoots

  const roots = new Set<string>()
  // VelarOS 产品家族共用的资源安装根：插件市场就装在这里。宿主把这个根登记进**它自己的**
  // 资源登记表时本包一无所知（Desktop 实测如此），装好的 MarkItDown 于是找不到；这个根是
  // 平台约定而不是宿主私有事实，本包自己算一份，宿主登不登记都能发现已安装的插件。
  roots.add(velarosSharedResources.resourcesRoot())
  const resourcesPath = readElectronResourcesPath()
  if (resourcesPath) {
    roots.add(resourcesPath)
    roots.add(join(resourcesPath, 'app.asar.unpacked'))
  }
  roots.add(resolve(process.cwd(), 'out', 'resources'))
  return [...roots]
}
