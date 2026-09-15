/**
 * JS/TS 语法校验器：`TypeScriptSyntaxValidator`，实现注入面的 `ProjectValidator`（contract/requires.ts）。
 * 用 TypeScript 解析器逐个检查请求（或事务改动）里的 JS/TS 文件，只报纯语法错误；诊断带行列、TS 诊断码与出错行摘录。
 * 依赖指纹是这些文件的路径加暂存正文，内容不变时校验结果可以复用。TypeScript 插件默认装它。
 */

import { createHash } from 'node:crypto'

import { isEmpty } from '@velaros-ai/core'

import type { ProjectValidator } from '../../contract/requires.js'
import type { ProjectValidationContext, ValidateInput, ValidationResult } from '../../types/validation.js'
import { isSelectedValidator } from '../../utils/checks.js'
import { isJsTsPath, jsTsSyntaxDiagnostics } from '../../utils/jsts-ast.js'

export class TypeScriptSyntaxValidator implements ProjectValidator {
  public readonly id = 'velaros.typescript.syntax-validator'
  public readonly checkIds: readonly string[] = ['typescript.syntax', 'parse', 'syntax']

  public canValidate(input: ValidateInput): boolean {
    return isSelectedValidator(this, input.checks)
  }

  public async cacheKey(input: ValidateInput, context: ProjectValidationContext): Promise<string> {
    const paths = (
      input.paths ??
      (input.transactionId
        ? (context.getTransaction(input.transactionId)?.changedFiles ?? [])
        : [])
    )
      .filter(isJsTsPath)
      .sort()
    const hash = createHash('sha256')
    for (const path of paths) hash.update(JSON.stringify([path, await context.readFile(path)]))
    return hash.digest('hex')
  }

  public async validate(input: ValidateInput, context: ProjectValidationContext): Promise<ValidationResult> {
    const paths =
      input.paths ??
      (input.transactionId
        ? (context.getTransaction(input.transactionId)?.changedFiles ?? [])
        : [])
    const result: ValidationResult = { ok: true, diagnostics: [], checks: [] }
    for (const path of paths.filter(isJsTsPath)) {
      const content = await context.readFile(path)
      const diagnostics = jsTsSyntaxDiagnostics(path, content ?? '', 'typescript.syntax')
      result.diagnostics.push(...diagnostics)
      result.checks.push({
        id: `typescript.syntax:${path}`,
        ok: isEmpty(diagnostics),
        diagnostics,
      })
    }
    result.ok = isEmpty(result.diagnostics)
    return result
  }
}
