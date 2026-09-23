/**
 * 执行之前先 typecheck：程序不落盘，编译器的文件系统全在内存里。
 *
 * 这一关是代码面最划算的一道门：模型对回执形状的误解在这里就发不出去，
 * 而且报错直接告诉它正确的名字（字段叫 `content` 不叫 `contents` 时给 `Did you mean 'content'?`）。
 * 它顺带还是截断检测器：输出超长把程序截断了，语法诊断当场就炸。
 *
 * 编译器那一侧的活全在 `utils/compiler.ts`，本类只负责按什么顺序用它们。
 */

import { isNotNull } from '@velaros-ai/core'

import { CodeSurfaceDiagnosticCodes } from '../contract/constants.js'
import { ProgramModuleDeclarations } from '../contract/surface.js'
import type { CodeProgramCheckResult } from '../types/script.js'
import type { GrantedModule } from '../types/script.js'
import { rejectWithDiagnostics } from '../utils/budget.js'
import {
  checkedProgramFile,
  diagnoseProgram,
  isTypeScriptOnlySyntax,
  JavaScriptCheckOptions,
  stripTypes,
  TypeScriptCheckOptions,
} from '../utils/compiler.js'
import { joinGrantedDeclarations } from '../utils/compiler.js'
import { readCapabilityNamespace } from '../utils/program.js'

/** 程序检查器。 */
export interface CodeProgramCheckerApi {
  /**
   * 按给定的能力声明检查一段程序，连同它 import 到的库里的脚本。
   * path 是它在脚本库里的位置（相对 import 从这里算，直接跑的代码不给）；modules 是它可能 import 到的库里的脚本：路径 → 正文。
   * 诊断的行列号已经换算成模型写的那一行（从 1 起），出在库里别的脚本上的带着那个脚本的路径，照抄回灌就能让它自己改对。
   */
  check(input: { source: string; granted: readonly GrantedModule[]; path?: string; modules?: Readonly<Record<string, string>> }): CodeProgramCheckResult
  /**
   * 程序（连同它 import 到的库里的脚本）import 了哪些**没授权**的能力模块。
   *
   * 认 TS2307（`Cannot find module 'velaros:git'`）这个专属码，不自己写判定——
   * 语言本身已经把这道闸给了：没授权的模块名解析不出来。
   */
  missingModules(input: { source: string; granted: readonly GrantedModule[]; path?: string; modules?: Readonly<Record<string, string>> }): string[]
}

class CodeProgramChecker implements CodeProgramCheckerApi {
  public check(input: { source: string; granted: readonly GrantedModule[]; path?: string; modules?: Readonly<Record<string, string>> }): CodeProgramCheckResult {
    const declarations = joinGrantedDeclarations(ProgramModuleDeclarations, input.granted)
    const diagnostics = diagnoseProgram({ source: input.source, declarations, modules: input.modules }, checkedProgramFile(input.path, false), JavaScriptCheckOptions)
    if (diagnostics.length === 0) return { ok: true }

    // 手滑写了 TypeScript（`as`、类型标注、interface）不该把一整轮弹回去——仓库的宽容铁律是
    // 「钳制不拒绝」。报错全是那一族时按 TypeScript 再查一遍：真有类型错照样拦，
    // 只是语法偏好不算错，剥掉类型照跑，再在回执里告诉它下次写 JavaScript。
    if (!diagnostics.every((diagnostic) => isTypeScriptOnlySyntax(diagnostic.code))) return rejectWithDiagnostics(diagnostics)
    const asTypeScript = diagnoseProgram(
      { source: input.source, declarations, modules: input.modules },
      checkedProgramFile(input.path, true),
      TypeScriptCheckOptions
    )
    if (asTypeScript.length > 0) return rejectWithDiagnostics(asTypeScript)
    return { ok: true, transpiled: stripTypes(input.source), wroteTypeScript: true }
  }

  public missingModules(input: { source: string; granted: readonly GrantedModule[]; path?: string; modules?: Readonly<Record<string, string>> }): string[] {
    const declarations = joinGrantedDeclarations(ProgramModuleDeclarations, input.granted)
    const diagnostics = diagnoseProgram({ source: input.source, declarations, modules: input.modules }, checkedProgramFile(input.path, false), JavaScriptCheckOptions)
    const missing: string[] = []
    for (const diagnostic of diagnostics) {
      if (diagnostic.code !== CodeSurfaceDiagnosticCodes.unresolvedModule) continue
      const matched = /'([^']+)'/u.exec(diagnostic.message)
      const namespace = matched ? readCapabilityNamespace(matched[1] ?? '') : null
      if (isNotNull(namespace) && !missing.includes(namespace)) missing.push(namespace)
    }
    return missing
  }
}

/** 进程内共享的那一个程序检查器。 */
export const codeProgramChecker: CodeProgramCheckerApi = new CodeProgramChecker()
