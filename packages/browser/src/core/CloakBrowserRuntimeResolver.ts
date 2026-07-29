import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'

import { isEmpty, toNullable } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'
import { asRecord, readString } from '@velaros-ai/core/utils/unknownJsonRecord'

import {
  type BrowserResourceRuntime,
  browserResourceRuntime,
} from './BrowserResourceRuntime'

export interface CloakBrowserRuntimeSpec {
  packageRoot: string
  moduleEntry: string
  version: string
  env: Record<string, string>
}

export interface CloakBrowserRuntimeProvider {
  resolve(): Nullable<CloakBrowserRuntimeSpec>
}

export interface CloakBrowserRuntimeResolverOptions {
  resourceRoots?: string[]
  packageResolver?: (specifier: string) => Nullable<string>
  resourceRuntime?: BrowserResourceRuntime
}

const log = logRuntime.tag('CloakBrowserRuntimeResolver')

function nodeRequire(): ReturnType<typeof createRequire> {
  return createRequire(typeof __filename === 'string' ? __filename : import.meta.url)
}

function defaultPackageResolver(specifier: string): Nullable<string> {
  try {
    return nodeRequire().resolve(specifier)
  } catch (error) {
    log.debug('CloakBrowser package resolution missed', { specifier, error })
    return null
  }
}

function readElectronResourcesPath(): Nullable<string> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return resourcesPath?.trim() ? resourcesPath : null
}

function readEnvironmentResourceRoots(): string[] {
  const configured = process.env.VELAROS_CLOAKBROWSER_RESOURCE_ROOT?.trim()
  if (!configured) return []
  return configured
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function buildDefaultResourceRoots(): string[] {
  const environmentRoots = readEnvironmentResourceRoots()
  if (!isEmpty(environmentRoots)) return environmentRoots

  const roots = new Set<string>()
  const resourcesPath = readElectronResourcesPath()
  if (resourcesPath) {
    roots.add(resourcesPath)
    roots.add(join(resourcesPath, 'app.asar.unpacked'))
  }
  roots.add(resolve(process.cwd(), 'out', 'resources'))
  return [...roots]
}

class CloakBrowserRuntimeResolver implements CloakBrowserRuntimeProvider {
  private readonly configuredResourceRoots: Nullable<string[]>
  private readonly packageResolver: (specifier: string) => Nullable<string>
  private readonly resourceRuntime: BrowserResourceRuntime

  constructor(options: CloakBrowserRuntimeResolverOptions = {}) {
    this.configuredResourceRoots = options.resourceRoots ?? null
    this.packageResolver = options.packageResolver ?? defaultPackageResolver
    this.resourceRuntime = options.resourceRuntime ?? browserResourceRuntime
  }

  public resolve(): Nullable<CloakBrowserRuntimeSpec> {
    if (this.resourceRuntime.isDisabled('cloakbrowser')) return null
    return this.resolveIgnoringDisabled()
  }

  /** 忽略用户停用开关，仅回答「物理上是否已安装」。 */
  public resolveIgnoringDisabled(): Nullable<CloakBrowserRuntimeSpec> {
    return this.resolveBundledRuntime() ?? this.resolveInstalledRuntime()
  }

  private effectiveResourceRoots(): string[] {
    if (this.configuredResourceRoots) return this.configuredResourceRoots
    return [...this.resourceRuntime.extraResourceRoots(), ...buildDefaultResourceRoots()]
  }

  private resolveBundledRuntime(): Nullable<CloakBrowserRuntimeSpec> {
    const packageName = `cloakbrowser-${process.platform}-${process.arch}`
    for (const root of this.effectiveResourceRoots()) {
      const candidates = [join(root, 'cloakbrowser', packageName), join(root, packageName)]
      for (const packageRoot of candidates) {
        const moduleEntry = this.resolveModuleEntry(packageRoot)
        if (!moduleEntry) continue
        return this.buildSpec(packageRoot, moduleEntry)
      }
    }

    return null
  }

  private resolveInstalledRuntime(): Nullable<CloakBrowserRuntimeSpec> {
    const packageJsonPath = this.packageResolver('cloakbrowser/package.json')
    if (!packageJsonPath) return null

    const packageRoot = dirname(packageJsonPath)
    const moduleEntry = this.resolvePackageModuleEntry(packageRoot)
    if (!moduleEntry) return null

    return this.buildSpec(packageRoot, moduleEntry)
  }

  private resolveModuleEntry(packageRoot: string): Nullable<string> {
    const bundledPackageRoot = join(packageRoot, 'node_modules', 'cloakbrowser')
    return this.resolvePackageModuleEntry(bundledPackageRoot)
  }

  private resolvePackageModuleEntry(packageRoot: string): Nullable<string> {
    const packageJsonPath = join(packageRoot, 'package.json')
    if (!existsSync(packageJsonPath)) return null

    const packageJson = this.readPackageJson(packageJsonPath)
    const main = readString(packageJson, 'main') ?? 'dist/index.js'
    const candidates = [join(packageRoot, main), join(packageRoot, 'dist', 'index.js')]
    return toNullable(candidates.find((candidate) => existsSync(candidate)))
  }

  private buildSpec(packageRoot: string, moduleEntry: string): CloakBrowserRuntimeSpec {
    return {
      packageRoot,
      moduleEntry,
      version: this.readRuntimeVersion(packageRoot),
      env: {
        CLOAKBROWSER_CACHE_DIR: join(packageRoot, 'cache'),
        CLOAKBROWSER_AUTO_UPDATE: 'false',
      },
    }
  }

  private readRuntimeVersion(packageRoot: string): string {
    const runtimePackageJson = this.readPackageJson(join(packageRoot, 'package.json'))
    return readString(runtimePackageJson, 'version') ?? '0.0.0'
  }

  private readPackageJson(packageJsonPath: string): Record<string, unknown> {
    try {
      return asRecord(nodeRequire()(packageJsonPath)) ?? {}
    } catch (error) {
      log.debug('读取 CloakBrowser package.json 失败', { packageJsonPath, error })
      return {}
    }
  }
}

export { CloakBrowserRuntimeResolver }
/**
 * Compatibility resolver using process defaults and the compatibility
 * resource registry.
 *
 * @deprecated Construct `CloakBrowserRuntimeResolver` with explicit
 * `resourceRoots`, `packageResolver`, and `resourceRuntime`.
 */
export const cloakBrowserRuntimeResolver = new CloakBrowserRuntimeResolver()
