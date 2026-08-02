import { isEmpty,isNonBlankString, optionalWhen } from '@velaros-ai/core'

import { toErrorObject } from '../errors.js'
import type { FixInput, FixResult, ProjectFixContext, ProjectFixer } from '../types/fix.js'

function emptyResult(transactionId: string): FixResult {
  return {
    ok: true,
    changed: false,
    transactionId,
    changedFiles: [],
    fixes: [],
    diagnostics: [],
  }
}

function fixerErrorResult(
  transactionId: string,
  fixerId: string,
  phase: string,
  error: any
): FixResult {
  const errorObject = toErrorObject(error)
  const message =
    isNonBlankString(errorObject.message)
      ? errorObject.message
      : `Fixer ${fixerId} 在 ${phase} 阶段失败。`
  return {
    ok: false,
    changed: false,
    transactionId,
    changedFiles: [],
    fixes: [],
    diagnostics: [
      {
        severity: 'error',
        source: `${fixerId}.${phase}`,
        message,
        data: errorObject,
      },
    ],
  }
}

function mergeFixResults(current: FixResult, next: FixResult, transactionId: string): FixResult {
  return {
    ok: current.ok && next.ok,
    changed: current.changed || next.changed,
    transactionId,
    changedFiles: [...new Set([...current.changedFiles, ...next.changedFiles])],
    fixes: [...current.fixes, ...next.fixes],
    diagnostics: [...current.diagnostics, ...next.diagnostics],
    toolRequirements: optionalWhen([...(current.toolRequirements ?? []), ...(next.toolRequirements ?? [])].length, ([...(current.toolRequirements ?? []), ...(next.toolRequirements ?? [])])),
  }
}

/** 管理事务修复器，并按请求的检查范围依次尝试修复暂存变更。 */
export class FixerRegistry {
  private fixers: ProjectFixer[] = []

  /** 注册一个可参与事务修复的 fixer。 */
  public register(fixer: ProjectFixer): void {
    this.fixers.push(fixer)
  }

  /** 返回当前已注册的 fixer id。 */
  public listIds(): string[] {
    return this.fixers.map((fixer) => fixer.id)
  }

  /** 对指定事务运行匹配的 fixer，并合并修复结果与诊断信息。 */
  public async fix(input: FixInput, ctx: ProjectFixContext): Promise<FixResult> {
    let result = emptyResult(input.transactionId)
    for (const fixer of this.fixers) {
      if (input.checks && !isEmpty(input.checks) && !input.checks.includes(fixer.id)) continue
      let canFix = false
      try {
        canFix = await fixer.canFix(input, ctx)
      } catch (error) {
        // arch-guard:silent-catch-ok fixer canFix 异常会归一化进 FixResult diagnostics。
        result = mergeFixResults(
          result,
          fixerErrorResult(input.transactionId, fixer.id, 'canFix', error),
          input.transactionId
        )
        continue
      }
      if (!canFix) continue

      try {
        const next = await fixer.fix(input, ctx)
        result = mergeFixResults(result, next, input.transactionId)
      } catch (error) {
        // arch-guard:silent-catch-ok fixer fix 异常会归一化进 FixResult diagnostics。
        result = mergeFixResults(
          result,
          fixerErrorResult(input.transactionId, fixer.id, 'fix', error),
          input.transactionId
        )
      }
    }
    return result
  }
}
