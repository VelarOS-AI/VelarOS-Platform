import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, join, resolve } from 'node:path'

import { asRecord, readString } from '@velaros-ai/core/utils/unknownJsonRecord'

import {
  type OfficeResourceRuntime,
  officeResourceRuntime,
} from './OfficeResourceRuntime'

export interface MarkItDownLaunchSpec {
  command: string
  packageRoot: string
  version: string
}

export interface MarkItDownBinaryResolverOptions {
  resourceRoots?: string[]
  resourceRuntime?: OfficeResourceRuntime
}

const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)

function readElectronResourcesPath(): Nullable<string> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return resourcesPath?.trim() ? resourcesPath : null
}

function readEnvironmentResourceRoots(): string[] {
  const configured = process.env.VELAROS_MARKITDOWN_RESOURCE_ROOT?.trim()
  if (!configured) return []
  return configured
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function buildDefaultResourceRoots(): string[] {
  const environmentRoots = readEnvironmentResourceRoots()
  if (environmentRoots.length > 0) return environmentRoots

  const roots = new Set<string>()
  const resourcesPath = readElectronResourcesPath()
  if (resourcesPath) {
    roots.add(resourcesPath)
    roots.add(join(resourcesPath, 'app.asar.unpacked'))
  }
  roots.add(resolve(process.cwd(), 'out', 'resources'))
  return [...roots]
}

/**
 * 解析随应用打包的 MarkItDown runtime，避免运行期下载或依赖用户自行安装 CLI。
 */
class MarkItDownBinaryResolver {
  private readonly configuredResourceRoots: Nullable<string[]>
  private readonly resourceRuntime: OfficeResourceRuntime

  constructor(options: MarkItDownBinaryResolverOptions = {}) {
    this.configuredResourceRoots = options.resourceRoots ?? null
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

    return candidates.find((candidate) => existsSync(candidate)) ?? null
  }

  private readPackageVersion(packageRoot: string): string {
    try {
      const pkg = require(join(packageRoot, 'package.json')) as Record<string, unknown>
      return readString(asRecord(pkg), 'version') ?? '0.0.0'
    } catch {
      return '0.0.0'
    }
  }
}

export { MarkItDownBinaryResolver }
/**
 * Compatibility resolver using process defaults and the compatibility
 * resource registry.
 *
 * @deprecated Construct `MarkItDownBinaryResolver` with explicit
 * `resourceRoots` and `resourceRuntime`.
 */
export const markItDownBinaryResolver = new MarkItDownBinaryResolver()
