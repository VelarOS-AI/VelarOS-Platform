import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { Log, toNullable } from '@velaros-ai/core'
import { asRecord, readString } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { MarkItDownLaunchSpec } from '../types/office.js'
import { buildDefaultResourceRoots } from '../utils/resources.js'

import {
  type OfficeResourceRuntime,
  officeResourceRuntime,
} from './OfficeResourceRuntime'

export type { MarkItDownLaunchSpec }

export interface MarkItDownBinaryResolverOptions {
  resourceRoots?: string[]
  resourceRuntime?: OfficeResourceRuntime
}

const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)
const MarkItDownResolverLog = Log.tag('MarkItDownBinaryResolver')

/**
 * 解析随应用安装的 MarkItDown runtime，避免运行期下载或依赖用户自行安装 CLI。
 */
class MarkItDownBinaryResolver {
  private readonly configuredResourceRoots: Nullable<string[]>
  private readonly resourceRuntime: OfficeResourceRuntime

  constructor(options: MarkItDownBinaryResolverOptions = {}) {
    this.configuredResourceRoots = toNullable(options.resourceRoots)
    this.resourceRuntime = options.resourceRuntime ?? officeResourceRuntime
  }

  public resolve(): Nullable<MarkItDownLaunchSpec> {
    if (this.resourceRuntime.isDisabled('markitdown')) return null
    return this.resolveIgnoringDisabled()
  }

  /** 忽略用户停用开关，仅回答「物理上是否已安装」。 */
  public resolveIgnoringDisabled(): Nullable<MarkItDownLaunchSpec> {
    const packageRoot = this.resolveBundledPackageRoot()
    if (!packageRoot) return null

    const command = this.resolveCommand(packageRoot)
    if (!command) return null

    return {
      command,
      packageRoot,
      version: this.readPackageVersion(packageRoot),
    }
  }

  private effectiveResourceRoots(): string[] {
    if (this.configuredResourceRoots) return this.configuredResourceRoots
    return [...this.resourceRuntime.extraResourceRoots(), ...buildDefaultResourceRoots()]
  }

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

  private resolveCommand(packageRoot: string): Nullable<string> {
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

  private readPackageVersion(packageRoot: string): string {
    try {
      const pkg: unknown = require(join(packageRoot, 'package.json'))
      return readString(asRecord(pkg), 'version') ?? '0.0.0'
    } catch (error) {
      // arch-guard:silent-catch-ok 版本号只用于诊断展示，读不到时回落占位值不影响可用性判定。
      MarkItDownResolverLog.debug('读取 MarkItDown 包版本失败，使用占位版本号', { error })
      return '0.0.0'
    }
  }
}

export { MarkItDownBinaryResolver }
/** 使用当前进程资源目录的 MarkItDown 解析器。 */
export const markItDownBinaryResolver = new MarkItDownBinaryResolver()
