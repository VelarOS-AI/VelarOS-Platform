import { VelarosStandardDeclarations } from '../contract/surface.js'
import type { GrantedModule, ScriptPackageDefinition, ScriptPackageSurface } from '../types/script.js'

/** 虚拟包的唯一声明与可执行投影编译入口。 */
export interface ScriptPackageCompilerApi {
  /** 校验宿主映射，仅投影当前已授权模块；保留真实操作身份。 */
  compile(packages: readonly ScriptPackageDefinition[], modules: readonly GrantedModule[]): ScriptPackageSurface
}

class ScriptPackageCompiler implements ScriptPackageCompilerApi {
  public compile(packages: readonly ScriptPackageDefinition[], modules: readonly GrantedModule[]): ScriptPackageSurface {
    const ids = new Set(modules.map(item => item.namespace))
    const names = new Set<string>()
    const granted: GrantedModule[] = [...modules]
    const projected: ScriptPackageDefinition[] = []
    for (const pkg of packages) {
      if ((pkg.specifier !== 'velaros' && !/^velaros:[a-z][a-z0-9-]*$/u.test(pkg.specifier)) || pkg.specifier === 'velaros:program' || ids.has(pkg.specifier) || names.has(pkg.specifier)) throw new Error(`脚本包名冲突或无效：${pkg.specifier}`)
      names.add(pkg.specifier)
      const exports: Record<string, string> = Object.create(null)
      for (const [name, target] of Object.entries(pkg.exports)) {
        if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/u.test(name) || ['__proto__','prototype','constructor','default','output'].includes(name) || !/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/u.test(target)) throw new Error(`脚本包成员无效：${pkg.specifier}.${name}`)
        if (ids.has(target)) exports[name] = target
      }
      const members = Object.entries(exports).map(([name, target]) => `export * as ${name} from '${target}';`).join('\n')
      const primitive = pkg.specifier === 'velaros' ? VelarosStandardDeclarations.slice(VelarosStandardDeclarations.indexOf('{')+1,VelarosStandardDeclarations.lastIndexOf('}')) : ''
      granted.push({ namespace: pkg.specifier, declarations: `declare module '${pkg.specifier}' { ${members}\n${primitive} }` })
      projected.push(Object.freeze({ specifier: pkg.specifier, exports: Object.freeze(exports) }))
    }
    if (!names.has('velaros')) granted.push({ namespace: 'velaros', declarations: VelarosStandardDeclarations })
    return { packages: Object.freeze(projected), granted: Object.freeze(granted) }
  }
}

/** 检查、执行与发现共享同一个纯包编译器。 */
export const scriptPackageCompiler: ScriptPackageCompilerApi = new ScriptPackageCompiler()
