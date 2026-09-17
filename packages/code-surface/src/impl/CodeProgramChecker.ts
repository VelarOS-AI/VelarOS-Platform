/**
 * 执行之前先 typecheck：程序不落盘，编译器的文件系统全在内存里。
 *
 * 这一关是代码面最划算的一道门。今天的工具面靠人手写说明，说明漂了模型才知道——
 * 本轮修的两条真实缺陷（回执里没有 `nextActions`、字段其实叫 `content` 不叫 `contents`）
 * 在这里都发不出去，而且报错直接告诉模型正确的名字（`Did you mean 'content'?`）。
 * 它顺带还是截断检测器：输出超长把程序截断了，语法诊断当场就炸。
 *
 * 编译器那一侧的活全在 `utils/compiler.ts`，本类只负责按什么顺序用它们。
 */

import type { CodeProgramCheckResult } from '../types/code-surface.js'
import {
  diagnoseProgram,
  isTypeScriptOnlySyntax,
  JavaScriptCheckOptions,
  stripTypes,
  TypeScriptCheckOptions,
  TypeScriptProgramFileName,
} from '../utils/compiler.js'
import { ProgramFileName } from '../utils/program.js'

/** 程序检查器。 */
export interface CodeProgramCheckerApi {
  /**
   * 按给定的能力声明检查一段程序。
   * 诊断的行列号已经换算成模型写的那一行（从 1 起），照抄回灌就能让它自己改对。
   */
  check(input: { source: string; declarations: string }): CodeProgramCheckResult
}

class CodeProgramChecker implements CodeProgramCheckerApi {
  public check(input: { source: string; declarations: string }): CodeProgramCheckResult {
    const diagnostics = diagnoseProgram(input, ProgramFileName, JavaScriptCheckOptions)
    if (diagnostics.length === 0) return { ok: true }

    // 手滑写了 TypeScript（`as`、类型标注、interface）不该把一整轮弹回去——仓库的宽容铁律是
    // 「钳制不拒绝」。报错全是那一族时按 TypeScript 再查一遍：真有类型错照样拦，
    // 只是语法偏好不算错，剥掉类型照跑，再在回执里告诉它下次写 JavaScript。
    if (!diagnostics.every((diagnostic) => isTypeScriptOnlySyntax(diagnostic.code))) return { ok: false, diagnostics }
    const asTypeScript = diagnoseProgram(input, TypeScriptProgramFileName, TypeScriptCheckOptions)
    if (asTypeScript.length > 0) return { ok: false, diagnostics: asTypeScript }
    return { ok: true, transpiled: stripTypes(input.source), wroteTypeScript: true }
  }
}

/** 进程内共享的那一个程序检查器。 */
export const codeProgramChecker: CodeProgramCheckerApi = new CodeProgramChecker()
