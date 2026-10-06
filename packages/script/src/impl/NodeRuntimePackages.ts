import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { isPlainObject, isString, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { NodeDefaultPackages } from '../contract/constants.js'
import type { NodeRuntimePackage, NodeRuntimePackageReference } from '../types/environment.js'

/** 默认包的实际版本与解析根来自同一事实源。 */
export interface NodeRuntimePackagesApi {
  /** 默认读取 Script 的依赖；发行宿主可提供已校验的资源目录。 */
  defaults(directory?: string): readonly NodeRuntimePackage[]
  /** 列出与安装版本绑定的原包查询入口，不加载文档正文或执行模块。 */
  references(packages: readonly NodeRuntimePackage[]): readonly NodeRuntimePackageReference[]
}

/** 发现可导入的 npm 包，不读取说明也不执行包代码。 */
class NodeRuntimePackages implements NodeRuntimePackagesApi {
  public references(
    packages: readonly NodeRuntimePackage[]
  ): readonly NodeRuntimePackageReference[] {
    return packages.map((pkg) => {
      const root = realpathSync(join(pkg.directory, 'node_modules', pkg.name))
      const readme = readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) => entry.isFile() && /^readme(?:\.(?:md|markdown|txt|rst))?$/iu.test(entry.name)
        )
        .map((entry) => entry.name)
        .sort()[0]
      return {
        ...pkg,
        root,
        packageJson: join(root, 'package.json'),
        readme: optionalWhen(Boolean(readme), join(root, readme ?? '')),
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
