/**
 * MarkItDown 定位：`MarkItDownLocator` 与工厂 `createMarkItDownLocator`。接口 `MarkItDownLocatorApi` 在本文件的类上方。
 * 找的是随应用安装（插件市场装到共享资源根，或打进 Electron 资源目录）的 MarkItDown runtime，运行期不下载任何东西。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { toNullable } from '@velaros-ai/core'

import type { MarkItDownLocatorOptions, OfficeResourcePort } from '../../contract/requires.js'
import type { MarkItDownLaunchSpec } from '../../types/office.js'
import {
  buildDefaultResourceRoots,
  findMarkItDownCommand,
  readResourcePackageVersion,
} from '../../utils/resources.js'

/**
 * MarkItDown 定位器：回答「本机装没装 MarkItDown、可执行文件在哪、什么版本」。
 * 宿主把自己的资源端口注进来时，用户在设置里的停用开关也会被认；缺省实例只按平台约定推导资源根。
 */
export interface MarkItDownLocatorApi {
  /** 定位可用的 MarkItDown；没装或被用户停用时返回 null。 */
  resolve(): Nullable<MarkItDownLaunchSpec>
  /** 忽略用户停用开关，仅回答「物理上是否已安装」；插件目录要拿它区分「没装」与「装了但关了」。 */
  resolveIgnoringDisabled(): Nullable<MarkItDownLaunchSpec>
}

export class MarkItDownLocator implements MarkItDownLocatorApi {
  private readonly configuredResourceRoots: Nullable<string[]>
  private readonly resources: Nullable<OfficeResourcePort>

  constructor(options: MarkItDownLocatorOptions = {}) {
    this.configuredResourceRoots = toNullable(options.resourceRoots)
    this.resources = toNullable(options.resources)
  }

  public resolve(): Nullable<MarkItDownLaunchSpec> {
    if (this.resources?.isDisabled('markitdown')) return null
    return this.resolveIgnoringDisabled()
  }

  public resolveIgnoringDisabled(): Nullable<MarkItDownLaunchSpec> {
    const packageRoot = this.resolveBundledPackageRoot()
    if (!packageRoot) return null

    const command = findMarkItDownCommand(packageRoot)
    if (!command) return null

    return { command, packageRoot, version: readResourcePackageVersion(packageRoot) }
  }

  /** 这次要搜哪些资源根：显式配置优先，其次宿主登记的额外根，最后平台约定的默认根。 */
  private effectiveResourceRoots(): string[] {
    if (this.configuredResourceRoots) return this.configuredResourceRoots
    return [...(this.resources?.extraResourceRoots() ?? []), ...buildDefaultResourceRoots()]
  }

  /** 在资源根里找 markitdown-<platform>-<arch> 包目录。 */
  private resolveBundledPackageRoot(): Nullable<string> {
    const packageName = `markitdown-${process.platform}-${process.arch}`
    for (const root of this.effectiveResourceRoots()) {
      const candidates = [join(root, 'markitdown', packageName), join(root, packageName)]
      const packageRoot = candidates.find((candidate) =>
        existsSync(join(candidate, 'package.json'))
      )
      if (packageRoot) return packageRoot
    }

    return null
  }
}

/** 造一个 MarkItDown 定位器；宿主把自己的资源端口传进来，用户的停用开关才会被认。 */
export function createMarkItDownLocator(
  options: MarkItDownLocatorOptions = {}
): MarkItDownLocatorApi {
  return new MarkItDownLocator(options)
}
