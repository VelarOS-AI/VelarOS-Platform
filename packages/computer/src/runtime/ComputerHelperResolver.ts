import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, join, resolve } from 'node:path'

import {
  type ComputerResourceRuntime,
  computerResourceRuntime,
} from './ComputerResourceRuntime'

type Nullable<T> = T | null

/** 平台包目录名前缀（与 packageComputerUseResources.mjs / 插件产物一致）。 */
const PackageNamePrefix = 'computeruse'
/** 一级工具目录名（out/resources 与用户安装根下的布局）。 */
const ToolDirName = 'computer-use'
/** 该插件在 AppResourcePluginId 中的 id。 */
const PluginId = 'computeruse'

/** 当前平台 Python helper 脚本与解释器的解析结果。 */
export interface ComputerHelperLaunchSpec {
  /** Python 解释器命令；来自随插件分发的自包含 venv。 */
  pythonCommand: string
  /** 平台 helper 脚本的绝对路径。 */
  helperScript: string
  /** helper 脚本目录，作为 cwd 以便共享模块导入能解析。 */
  runtimeDir: string
  /** 平台包根目录（含 venv、helper、package.json），供插件目录服务使用。 */
  packageRoot: string
  /** 平台包版本（读取 package.json，缺省 0.0.0）。 */
  version: string
  /** 是否命中了随包/随插件的 venv 解释器。 */
  bundledVenv: boolean
}

export interface ComputerHelperResolverOptions {
  /** 覆盖资源根目录；默认从用户安装根、Electron resourcesPath 与 cwd 推导。 */
  resourceRoots?: string[]
  /** 覆盖平台，主要供测试使用。 */
  platform?: NodeJS.Platform
  resourceRuntime?: ComputerResourceRuntime
}

const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)

/** 各平台对应的 helper 脚本文件名。 */
function helperScriptName(platform: NodeJS.Platform): Nullable<string> {
  if (platform === 'darwin') return 'mac_helper.py'
  if (platform === 'win32') return 'win_helper.py'
  if (platform === 'linux') return 'linux_helper.py'
  return null
}

function readElectronResourcesPath(): Nullable<string> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return resourcesPath && resourcesPath.trim() ? resourcesPath : null
}

function readEnvironmentResourceRoots(): string[] {
  const configured = process.env.VELAROS_COMPUTER_RESOURCE_ROOT?.trim()
  if (!configured) return []
  return configured
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function buildDefaultResourceRoots(resourceRuntime: ComputerResourceRuntime): string[] {
  const environmentRoots = readEnvironmentResourceRoots()
  if (environmentRoots.length > 0) return environmentRoots

  const roots = new Set<string>()
  // 用户按需安装根（userData/resources）优先，安装/停用即时生效。
  for (const root of resourceRuntime.extraResourceRoots()) roots.add(root)
  // 随应用打包的资源目录。
  const resourcesPath = readElectronResourcesPath()
  if (resourcesPath) {
    roots.add(resourcesPath)
    roots.add(join(resourcesPath, 'app.asar.unpacked'))
  }
  // 开发环境下 packageComputerUseResources.mjs 会把带 venv 的平台包写到这里。
  roots.add(resolve(process.cwd(), 'out', 'resources'))
  return [...roots]
}

/**
 * 解析随插件分发的 Computer Use 平台包（helper 脚本 + 自包含 venv）。
 *
 * Computer Use 现按需安装：未安装（找不到带 venv 的平台包）时返回 null，
 * 由 sidecar 报告 helper-missing、上层引导用户到插件市场安装。
 * 不再回落到系统 Python 自行装依赖，避免污染用户机器。
 */
class ComputerHelperResolver {
  private readonly configuredResourceRoots: Nullable<string[]>
  private readonly platform: NodeJS.Platform
  private readonly resourceRuntime: ComputerResourceRuntime

  constructor(options: ComputerHelperResolverOptions = {}) {
    this.configuredResourceRoots = options.resourceRoots ?? null
    this.platform = options.platform ?? process.platform
    this.resourceRuntime = options.resourceRuntime ?? computerResourceRuntime
  }

  /** 尊重用户停用开关：被停用时视为不可用。 */
  public resolve(): Nullable<ComputerHelperLaunchSpec> {
    if (this.resourceRuntime.isDisabled(PluginId)) return null
    return this.resolveIgnoringDisabled()
  }

  /** 忽略用户停用开关，仅回答「物理上是否已安装」。 */
  public resolveIgnoringDisabled(): Nullable<ComputerHelperLaunchSpec> {
    const scriptName = helperScriptName(this.platform)
    if (!scriptName) return null

    const packageName = `${PackageNamePrefix}-${this.platform}-${process.arch}`
    for (const root of this.effectiveResourceRoots()) {
      const candidates = [join(root, ToolDirName, packageName), join(root, packageName)]
      for (const packageRoot of candidates) {
        const helperScript = join(packageRoot, scriptName)
        const pythonCommand = this.resolvePythonCommand(packageRoot)
        if (!pythonCommand || !existsSync(helperScript)) continue
        return {
          pythonCommand,
          helperScript,
          runtimeDir: packageRoot,
          packageRoot,
          version: this.readPackageVersion(packageRoot),
          bundledVenv: true,
        }
      }
    }

    return null
  }

  private effectiveResourceRoots(): string[] {
    if (this.configuredResourceRoots) return this.configuredResourceRoots
    return buildDefaultResourceRoots(this.resourceRuntime)
  }

  /** 仅接受平台包内自包含 venv 的解释器；显式 env 覆盖时放行。 */
  private resolvePythonCommand(packageRoot: string): Nullable<string> {
    const configured = process.env.VELAROS_COMPUTER_PYTHON?.trim()
    if (configured) return configured

    const venvPython =
      this.platform === 'win32'
        ? join(packageRoot, 'venv', 'Scripts', 'python.exe')
        : join(packageRoot, 'venv', 'bin', 'python')
    return existsSync(venvPython) ? venvPython : null
  }

  private readPackageVersion(packageRoot: string): string {
    try {
      const pkg = require(join(packageRoot, 'package.json')) as { version?: unknown }
      return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
    } catch {
      return '0.0.0'
    }
  }
}

/**
 * 解析当前平台的 helper 脚本和解释器（尊重停用开关）。
 *
 * 平台不支持、未安装或被停用时返回 null；解释器是否可启动由 sidecar manager 后续验证。
 */
export function resolveComputerHelper(
  options: ComputerHelperResolverOptions = {}
): Nullable<ComputerHelperLaunchSpec> {
  return new ComputerHelperResolver(options).resolve()
}

export { ComputerHelperResolver }
/**
 * Compatibility resolver using the compatibility resource registry.
 *
 * @deprecated Construct `ComputerHelperResolver` with an explicitly owned
 * resource runtime or inject `resolveHelper` into `ComputerSidecarManager`.
 */
export const computerHelperResolver = new ComputerHelperResolver()
