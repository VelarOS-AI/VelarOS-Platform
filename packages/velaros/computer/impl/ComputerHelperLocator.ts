import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { toNullable } from '@velaros-ai/core'

import { ComputerResourceLayout } from '../contract/constants.js'
import type { ComputerHelperLocatorOptions, ComputerResourcePort } from '../contract/requires.js'
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
  /** 忽略停用开关，只回答「资源是否已就绪」；宿主设置页用它显示状态。 */
  resolveIgnoringDisabled(): Nullable<ComputerHelperLaunchSpec>
  /** 随本单元发布的 helper 资产目录，宿主的安装器按它取源。 */
  bundledSourceRoot(): string
}

/**
 * 解析宿主分发的 Computer Use 平台包（helper 脚本与自包含 Python）。
 * Desktop 在应用资源中内置该包；其他宿主可经 ComputerResourcePort 注入资源根与停用状态。
 * 兼容已有 venv 布局，缺少自包含解释器时返回 null，交给宿主修复运行资源。
 * 仅显式 VELAROS_COMPUTER_PYTHON 可覆盖解释器，不自动探测系统 Python。
 * 本类只查磁盘；解释器启动与权限检测交给 ComputerSidecarManager。
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
