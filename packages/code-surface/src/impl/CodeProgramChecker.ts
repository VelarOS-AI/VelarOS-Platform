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
import type { CodeProgramCheckResult } from '../types/code-surface.js'
import type { GrantedModule } from '../types/code-surface.js'
import { rejectWithDiagnostics } from '../utils/budget.js'
import {
  diagnoseProgram,
  isTypeScriptOnlySyntax,
  JavaScriptCheckOptions,
  stripTypes,
  TypeScriptCheckOptions,
  TypeScriptProgramFileName,
} from '../utils/compiler.js'
import { joinGrantedDeclarations } from '../utils/compiler.js'
import { ProgramFileName, readCapabilityNamespace } from '../utils/program.js'

/** 程序检查器。 */
export interface CodeProgramCheckerApi {
  /**
   * 按给定的能力声明检查一段程序。
   * 诊断的行列号已经换算成模型写的那一行（从 1 起），照抄回灌就能让它自己改对。
   */
  check(input: { source: string; granted: readonly GrantedModule[] }): CodeProgramCheckResult
  /**
   * 程序 import 了哪些**没授权**的能力模块。
   *
   * 认 TS2307（`Cannot find module 'velar:git'`）这个专属码，不自己写判定——
   * 语言本身已经把这道闸给了：没授权的模块名解析不出来。
   */
  missingModules(input: { source: string; granted: readonly GrantedModule[] }): string[]
}

class CodeProgramChecker implements CodeProgramCheckerApi {
  public check(input: { source: string; granted: readonly GrantedModule[] }): CodeProgramCheckResult {
    const declarations = joinGrantedDeclarations(input.granted)
    const diagnostics = diagnoseProgram({ source: input.source, declarations }, ProgramFileName, JavaScriptCheckOptions)
    if (diagnostics.length === 0) return { ok: true }

    // 手滑写了 TypeScript（`as`、类型标注、interface）不该把一整轮弹回去——仓库的宽容铁律是
    // 「钳制不拒绝」。报错全是那一族时按 TypeScript 再查一遍：真有类型错照样拦，
    // 只是语法偏好不算错，剥掉类型照跑，再在回执里告诉它下次写 JavaScript。
    if (!diagnostics.every((diagnostic) => isTypeScriptOnlySyntax(diagnostic.code))) return rejectWithDiagnostics(diagnostics)
    const asTypeScript = diagnoseProgram(
      { source: input.source, declarations },
      TypeScriptProgramFileName,
      TypeScriptCheckOptions
    )
    if (asTypeScript.length > 0) return rejectWithDiagnostics(asTypeScript)
    return { ok: true, transpiled: stripTypes(input.source), wroteTypeScript: true }
  }

  public missingModules(input: { source: string; granted: readonly GrantedModule[] }): string[] {
    const declarations = joinGrantedDeclarations(input.granted)
    const diagnostics = diagnoseProgram({ source: input.source, declarations }, ProgramFileName, JavaScriptCheckOptions)
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
