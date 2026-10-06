import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { isPlainObject, isString, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { NodeDefaultPackages } from '../contract/constants.js'
import type { NodeRuntimePackage, NodeRuntimePackageReference } from '../types/environment.js'
import { shapeOperationFailure } from '../utils/capability-failure.js'

/** 默认包的实际版本与解析根来自同一事实源。 */
export interface NodeRuntimePackagesApi {
  /** 默认读取 Script 的依赖；发行宿主可提供已校验的资源目录。 */
  defaults(directory?: string): readonly NodeRuntimePackage[]
  /** 列出运行环境后备安装；程序启动时由其 Node 进程更新工作区覆盖，不执行模块。 */
  references(packages: readonly NodeRuntimePackage[]): readonly NodeRuntimePackageReference[]
}

/** 发现可导入的 npm 包，不读取说明也不执行包代码。 */
class NodeRuntimePackages implements NodeRuntimePackagesApi {
  public references(
    packages: readonly NodeRuntimePackage[]
  ): readonly NodeRuntimePackageReference[] {
    return packages.map((pkg) => {
      const source = 'runtime' as const
      let packageJson = join(pkg.directory, 'node_modules', pkg.name, 'package.json')
      let root: string | undefined
      try {
        root = realpathSync(dirname(packageJson))
        packageJson = join(root, 'package.json')
        const manifest: unknown = JSON.parse(readFileSync(packageJson, 'utf8'))
        if (!isPlainObject(manifest)) throw new AppError('VALIDATION', '包清单需要 JSON 对象')
        const readme = readdirSync(root, { withFileTypes: true })
          .filter(
            (entry) => entry.isFile() && /^readme(?:\.(?:md|markdown|txt|rst))?$/iu.test(entry.name)
          )
          .map((entry) => entry.name)
          .sort()[0]
        return {
          name: pkg.name,
          source,
          version: optionalWhen(isString, manifest.version),
          skill: pkg.skill,
          root,
          packageJson,
          readme: optionalWhen(Boolean(readme), join(root, readme ?? '')),
        }
      } catch (cause) {
        return { name: pkg.name, source, root, packageJson, error: shapeOperationFailure(cause) }
      }
    })
  }

  public defaults(directory?: string): readonly NodeRuntimePackage[] {
    const require = createRequire(import.meta.url)
    return NodeDefaultPackages.map((name) => {
      const paths = directory
        ? [join(directory, 'node_modules')]
        : (require.resolve.paths(name) ?? [])
      const modules = paths.find((path) => existsSync(join(path, name, 'package.json')))
      if (!modules) throw new AppError('UNAVAILABLE', `标准 Node 环境缺少 ${name}`)
      const manifest: unknown = JSON.parse(
        readFileSync(join(modules, name, 'package.json'), 'utf8')
      )
      if (!isPlainObject(manifest) || manifest.name !== name || !isString(manifest.version))
        throw new AppError('UNAVAILABLE', `标准 Node 包身份无效：${name}`)
      return { name, version: manifest.version, directory: dirname(modules) }
    })
  }
}

/** 基础包目录由执行器与产品装配共享。 */
export const nodeRuntimePackages: NodeRuntimePackagesApi = new NodeRuntimePackages()
