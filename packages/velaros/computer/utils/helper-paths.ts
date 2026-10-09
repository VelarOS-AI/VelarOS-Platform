/** 按平台与资源根推导 helper 脚本、自包含 Python 与平台包目录的位置。 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isEmpty, isNonBlankString, isString } from '@velaros-ai/core'
import { velarosSharedResources } from '@velaros-ai/core/platform/shared-resources'

import { ComputerResourceLayout } from '../contract/constants.js'
import type { ComputerResourcePort } from '../contract/requires.js'

/** 读不到平台包 package.json 时的占位版本；只影响展示，不影响可用性判定。 */
const UnknownPackageVersion = '0.0.0'

const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)

/** 各平台对应的 helper 脚本文件名；不支持的平台返回 null。 */
export function helperScriptName(platform: NodeJS.Platform): Nullable<string> {
  switch (platform) {
    case 'darwin':
      return 'mac_helper.py'
    case 'win32':
      return 'win_helper.py'
    case 'linux':
      return 'linux_helper.py'
    default:
      return null
  }
}

/** 平台包的目录名：`<前缀>-<平台>-<架构>`，与宿主打包脚本一致。 */
export function platformPackageName(platform: NodeJS.Platform): string {
  return `${ComputerResourceLayout.packageNamePrefix}-${platform}-${process.arch}`
}

/** Electron 打包后的资源目录；不在 Electron 里跑时返回 null。 */
export function readElectronResourcesPath(): Nullable<string> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return isNonBlankString(resourcesPath) ? resourcesPath : null
}

/** 环境变量指定的资源根；设了就整组接管，不与默认根合并。 */
export function readEnvironmentResourceRoots(): string[] {
  const configured = process.env.VELAROS_COMPUTER_RESOURCE_ROOT?.trim()
  if (!configured) return []
  return configured
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * 按优先级列出要搜的资源根。
 *
 * `VELAROS_COMPUTER_RESOURCE_ROOT` 一旦设置就**整组接管**（测试与打包排障需要一个确定的、不受宿主状态影响的根集）；
 * 否则依次是宿主登记的资源根 → VelarOS 共享资源根 → 应用打包资源 → 开发期 `out/resources`。
 */
export function buildDefaultResourceRoots(resources: ComputerResourcePort): string[] {
  const environmentRoots = readEnvironmentResourceRoots()
  if (!isEmpty(environmentRoots)) return environmentRoots

  const roots = new Set<string>()
  for (const root of resources.extraResourceRoots()) roots.add(root)
  roots.add(velarosSharedResources.resourcesRoot())
  const resourcesPath = readElectronResourcesPath()
  if (resourcesPath) {
    roots.add(resourcesPath)
    roots.add(join(resourcesPath, 'app.asar.unpacked'))
  }
  roots.add(resolve(process.cwd(), 'out', 'resources'))
  return [...roots]
}

/**
 * 平台包里自包含 Python 的路径，兼容已有 venv 布局；显式 `VELAROS_COMPUTER_PYTHON` 可覆盖。
 *
 * 自包含解释器是执行边界：回落到系统 Python 意味着要靠 `pip install` 自行补依赖，
 * 那等于让智能体往用户机器上装东西，解释器与第三方包的来源完全不可控。
 */
export function resolvePythonCommand(
  packageRoot: string,
  platform: NodeJS.Platform
): Nullable<string> {
  const configured = process.env.VELAROS_COMPUTER_PYTHON?.trim()
  if (configured) return configured

  const portablePython =
    platform === 'win32'
      ? join(packageRoot, 'python', 'python.exe')
      : join(packageRoot, 'python', 'bin', 'python3')
  if (existsSync(portablePython)) return portablePython
  const venvPython =
    platform === 'win32'
      ? join(packageRoot, 'venv', 'Scripts', 'python.exe')
      : join(packageRoot, 'venv', 'bin', 'python')
  return existsSync(venvPython) ? venvPython : null
}

/** 读平台包的版本号；读不到就给占位值，绝不因此把「已安装」判成「未安装」。 */
export function readPackageVersion(packageRoot: string): string {
  try {
    const pkg = require(join(packageRoot, 'package.json')) as { version?: unknown }
    return isString(pkg.version) ? pkg.version : UnknownPackageVersion
  } catch {
    // arch-guard:silent-catch-ok 版本号只用于展示；读不到不影响能否启动 helper，
    // 为它把「已安装」判成「未安装」是更坏的失败方向。
    return UnknownPackageVersion
  }
}

/**
 * 随本单元发布的 helper 资产目录（各平台的 Python 脚本），宿主的安装器按它取源。
 *
 * 从**包根的 package.json** 往回定位，而不是数 `../..` 几层：编译产物的目录深度会随结构改变，
 * 数层数的写法一改目录就悄悄指错地方（原来的 `new URL('../../runtime')` 就是这样）。
 */
export function bundledRuntimeSourceRoot(): string {
  const packagedRoot = process.env.VELAROS_COMPUTER_RUNTIME_SOURCE_ROOT?.trim()
  if (packagedRoot) return resolve(packagedRoot)

  let directory = dirname(fileURLToPath(import.meta.url))
  // 包根的标志是 package.json；根目录的 dirname 等于自身，用它兜住循环。
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return resolve(join(directory, ComputerResourceLayout.bundledRuntimeDirectory))
}
