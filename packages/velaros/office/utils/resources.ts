/** MarkItDown 资源根的推导：环境变量根、Electron 资源目录、VelarOS 家族共用的资源安装根。 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, join, resolve } from 'node:path'

import { isEmpty, Log, toNullable } from '@velaros-ai/core'
import { velarosSharedResources } from '@velaros-ai/core/platform/shared-resources'
import { asRecord, readString } from '@velaros-ai/core/utils/unknownJsonRecord'

const log = Log.tag('OfficeResources')

/** 以本模块为基准创建的 require，用来读已安装资源包的 package.json。 */
const requireFromOfficeModule = createRequire(
  typeof __filename === 'string' ? __filename : import.meta.url
)

/** 读 Electron 打包产物的 resources 目录；不在 Electron 里跑时返回 null。 */
export function readElectronResourcesPath(): Nullable<string> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return resourcesPath?.trim() ? resourcesPath : null
}

/** 读环境变量里配置的资源根（登记在 OfficeEnvironmentVariables）；配了就只认它，不再推导默认根。 */
export function readEnvironmentResourceRoots(): string[] {
  const configured = process.env.VELAROS_MARKITDOWN_RESOURCE_ROOT?.trim()
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

/** 在 MarkItDown 包目录里找可执行文件，Windows 与类 Unix 的候选名不同。 */
export function findMarkItDownCommand(packageRoot: string): Nullable<string> {
  const candidates =
    process.platform === 'win32'
      ? [
          join(packageRoot, 'bin', 'markitdown.cmd'),
          join(packageRoot, 'bin', 'markitdown.exe'),
          join(packageRoot, 'venv', 'Scripts', 'markitdown.exe'),
          join(packageRoot, 'venv', 'Scripts', 'markitdown.cmd'),
        ]
      : [join(packageRoot, 'bin', 'markitdown'), join(packageRoot, 'venv', 'bin', 'markitdown')]

  return toNullable(candidates.find((candidate) => existsSync(candidate)))
}

/** 读已安装资源包的版本号，只用于诊断展示；读不到回落占位值。 */
export function readResourcePackageVersion(packageRoot: string): string {
  try {
    const pkg: unknown = requireFromOfficeModule(join(packageRoot, 'package.json'))
    return readString(asRecord(pkg), 'version') ?? '0.0.0'
  } catch (error) {
    // arch-guard:silent-catch-ok 版本号只用于诊断展示，读不到时回落占位值不影响可用性判定。
    log.debug('读取资源包版本失败，使用占位版本号', { error })
    return '0.0.0'
  }
}
