/**
 * 执行之前先查语法：程序不落盘，解析全在内存里。
 *
 * 查 JavaScript 语法、核对每个 import 落得到，不做整体类型检查：模型写的是普通 JS，
 * 类型推断上的挑剔（空数组推成 `never[]`、字面量拓宽）只会把一段对的程序整轮弹回去。
 * 字段名写错、入参形状不对交给运行时——能力的入参照样按 schema 校验，写错的那一次调用当场报错、不生效。
 * 标准 output 的值/展示类型若静态已能证明矛盾，执行前拒绝，避免先做工具调用再在交结果时失败；未知值仍留给运行时。
 * 它顺带还是截断检测器：输出超长把程序截断了，语法诊断当场就炸。
 *
 * 我们自己写的代码模版另走 `typecheck`：模版会原样教给模型，照声明做完整类型检查。
 *
 * 编译器那一侧的活全在 `utils/compiler.ts`，本类只负责按什么顺序用它们。
 */

import { ProgramModuleDeclarations } from '../contract/surface.js'
import type { CodeProgramCheckResult } from '../types/script.js'
import type { GrantedModule } from '../types/script.js'
import { rejectWithDiagnostics } from '../utils/budget.js'
import {
  diagnoseOutputTypes,
  diagnoseSyntax,
  isTypeScriptOnlySyntax,
  joinGrantedDeclarations,
  missingCapabilityModules,
  stripTypes,
  typecheckTemplate,
} from '../utils/compiler.js'

/** 程序检查器。 */
export interface CodeProgramCheckerApi {
  /**
   * 按给定的能力声明检查一段程序的语法，连同它 import 到的库里的脚本；每个 import 都要落得到；标准 output 的确定类型矛盾提前拒绝。
   * path 是它在脚本库里的位置（相对 import 从这里算，直接跑的代码不给）；modules 是它可能 import 到的库里的脚本：路径 → 正文。
   * 诊断的行列号就是模型写的那一行（从 1 起），出在库里别的脚本上的带着那个脚本的路径，照抄回灌就能让它自己改对。
   */
  check(input: {
    source: string
    granted: readonly GrantedModule[]
    path?: string
    modules?: Readonly<Record<string, string>>
  }): CodeProgramCheckResult
  /** 程序（连同它 import 到的库里的脚本）import 了哪些**没授权**的能力模块：没授权的模块不在声明里，import 它就落不到。 */
  missingModules(input: {
    source: string
    granted: readonly GrantedModule[]
    path?: string
    modules?: Readonly<Record<string, string>>
  }): string[]
  /** 给我们自己写的代码模版照声明做完整类型检查：写错一个键，模型照着写就跟着错。模型交的程序不走这里。 */
  typecheck(input: { source: string; granted: readonly GrantedModule[] }): CodeProgramCheckResult
}

class CodeProgramChecker implements CodeProgramCheckerApi {
  public check(input: {
    source: string
    granted: readonly GrantedModule[]
    path?: string
    modules?: Readonly<Record<string, string>>
  }): CodeProgramCheckResult {
    const target = {
      source: input.source,
      declarations: joinGrantedDeclarations(ProgramModuleDeclarations, input.granted),
      path: input.path,
      modules: input.modules,
    }
    const diagnostics = diagnoseSyntax(target, false)
    if (diagnostics.length === 0) {
      const outputs = diagnoseOutputTypes(target, false)
      return outputs.length === 0 ? { ok: true } : rejectWithDiagnostics(outputs)
    }

    // 手滑写了 TypeScript（`as`、类型标注、interface）不该把一整轮弹回去——仓库的宽容铁律是
    // 「钳制不拒绝」。报错全是那一族时按 TypeScript 再解析一遍：真有语法错照样拦，
    // 只是语法偏好不算错，剥掉类型照跑，再在回执里告诉它下次写 JavaScript。
    if (!diagnostics.every((diagnostic) => isTypeScriptOnlySyntax(diagnostic.code)))
      return rejectWithDiagnostics(diagnostics)
    const asTypeScript = diagnoseSyntax(target, true)
    if (asTypeScript.length > 0) return rejectWithDiagnostics(asTypeScript)
    const outputs = diagnoseOutputTypes(target, true)
    if (outputs.length > 0) return rejectWithDiagnostics(outputs)
    return { ok: true, transpiled: stripTypes(input.source), wroteTypeScript: true }
  }

  public missingModules(input: {
    source: string
    granted: readonly GrantedModule[]
    path?: string
    modules?: Readonly<Record<string, string>>
  }): string[] {
    return missingCapabilityModules({
      source: input.source,
      declarations: joinGrantedDeclarations(ProgramModuleDeclarations, input.granted),
      path: input.path,
      modules: input.modules,
    })
  }

  public typecheck(input: {
    source: string
    granted: readonly GrantedModule[]
  }): CodeProgramCheckResult {
    const diagnostics = typecheckTemplate({
      source: input.source,
      declarations: joinGrantedDeclarations(ProgramModuleDeclarations, input.granted),
    })
    return diagnostics.length === 0 ? { ok: true } : rejectWithDiagnostics(diagnostics)
  }
}

/** 进程内共享的那一个程序检查器。 */
export const codeProgramChecker: CodeProgramCheckerApi = new CodeProgramChecker()
