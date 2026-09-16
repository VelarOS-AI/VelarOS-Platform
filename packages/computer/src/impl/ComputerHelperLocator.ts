import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { toNullable } from '@velaros-ai/core'

import { ComputerResourceLayout } from '../contract/constants.js'
import type {
  ComputerHelperLocatorOptions,
  ComputerResourcePort,
} from '../contract/requires.js'
import type { ComputerHelperLaunchSpec } from '../types/computer.js'
import {
  buildDefaultResourceRoots,
  bundledRuntimeSourceRoot,
  helperScriptName,
  platformPackageName,
  readPackageVersion,
  resolvePythonCommand,
} from '../utils/helper-paths.js'

/**
 * helper 定位器：回答「当前平台的桌面控制 helper 在哪、用哪个解释器」。
 *
 * 只查磁盘，不启动任何进程——「查询状态」这个动作必须廉价且无副作用，能不能真跑起来由 sidecar 回答。
 */
export interface ComputerHelperLocatorApi {
  /** 尊重用户停用开关：被停用时视为不可用，返回 null。 */
  resolve(): Nullable<ComputerHelperLaunchSpec>
  /** 忽略停用开关，只回答「物理上是否已安装」；设置页与插件管理用它显示状态。 */
  resolveIgnoringDisabled(): Nullable<ComputerHelperLaunchSpec>
  /** 随本包发布的 helper 资产目录，宿主的安装器按它取源。 */
  bundledSourceRoot(): string
}

/**
 * 解析随插件分发的 Computer Use 平台包（helper 脚本 + 自包含 venv）。
 *
 * Computer Use 现按需安装：未安装（找不到带 venv 的平台包）时返回 null，
 * 由 sidecar 报告 helper-missing、上层引导用户到插件市场安装。
 * 不再回落到系统 Python 自行装依赖，避免污染用户机器。
 *
 * 导览（§5.3b ④安全门 / ⑤跨层接缝 / ⑥非显然的妥协）
 * - **「只认自包含 venv」是安全门，不是打包偏好**（见 `resolvePythonCommand`）。回落到系统 Python
 *   意味着运行时得靠 `pip install` 自行补依赖——那等于让 agent 往用户机器上装东西，且解释器与
 *   第三方包的来源完全不可控。所以缺 venv 一律判「未安装」，把补救动作交给用户驱动的插件安装。
 *   唯一放行口是显式 `VELAROS_COMPUTER_PYTHON`（开发者自证），不是自动探测。
 * - **`resolve()` 与 `resolveIgnoringDisabled()` 的分工**是刻意的两问：前者答「现在能不能用」
 *   （尊重用户停用开关），后者答「物理上装了没有」（供设置页/插件管理显示状态）。合并成一个会
 *   让「用户主动关掉」和「根本没装」长得一样，两者需要的引导文案完全不同。
 * - **资源来源是注入的**：宿主的按需安装根与停用开关经 `ComputerResourcePort` 传进来。以前这是本包
 *   里的模块级可变登记表，宿主登记在自己的表里、本包那张永远空着，装好的插件因此找不到。
 * - **跨层接缝**：本类只回答「helper 在哪、用哪个解释器」，**不验证解释器能否启动**——那是
 *   `ComputerSidecarManager` 的事。方向不能反：定位器不许 spawn 进程，否则「查询状态」这个
 *   本该廉价的动作会带上启动开销与副作用。
 */
export class ComputerHelperLocator implements ComputerHelperLocatorApi {
  /** 宿主没给资源来源时的缺省：没有额外安装根，也没有任何停用。 */
  private static readonly NoResources: ComputerResourcePort = Object.freeze({
    extraResourceRoots: () => [],
    isDisabled: () => false,
  })

  private readonly configuredResourceRoots: Nullable<string[]>
  private readonly platform: NodeJS.Platform
  private readonly resources: ComputerResourcePort

  constructor(options: ComputerHelperLocatorOptions = {}) {
    this.configuredResourceRoots = toNullable(options.resourceRoots)
    this.platform = options.platform ?? process.platform
    this.resources = options.resources ?? ComputerHelperLocator.NoResources
  }

  public resolve(): Nullable<ComputerHelperLaunchSpec> {
    if (this.resources.isDisabled(ComputerResourceLayout.pluginId)) return null
    return this.resolveIgnoringDisabled()
  }

  public resolveIgnoringDisabled(): Nullable<ComputerHelperLaunchSpec> {
    const scriptName = helperScriptName(this.platform)
    if (!scriptName) return null

    const packageName = platformPackageName(this.platform)
    for (const root of this.effectiveResourceRoots()) {
      const candidates = [
        join(root, ComputerResourceLayout.toolDirectory, packageName),
        join(root, packageName),
      ]
      for (const packageRoot of candidates) {
        const helperScript = join(packageRoot, scriptName)
        const pythonCommand = resolvePythonCommand(packageRoot, this.platform)
        if (!pythonCommand || !existsSync(helperScript)) continue
        return {
          pythonCommand,
          helperScript,
          runtimeDir: packageRoot,
          packageRoot,
          version: readPackageVersion(packageRoot),
          bundledVenv: true,
        }
      }
    }

    return null
  }

  public bundledSourceRoot(): string {
    return bundledRuntimeSourceRoot()
  }

  private effectiveResourceRoots(): string[] {
    if (this.configuredResourceRoots) return this.configuredResourceRoots
    return buildDefaultResourceRoots(this.resources)
  }
}

/** 创建一个 helper 定位器；宿主把自己的资源来源与平台从这里塞进来。 */
export function createComputerHelperLocator(
  options: ComputerHelperLocatorOptions = {}
): ComputerHelperLocatorApi {
  return new ComputerHelperLocator(options)
}
