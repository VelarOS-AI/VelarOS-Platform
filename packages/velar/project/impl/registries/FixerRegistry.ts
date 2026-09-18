/**
 * 修复器登记表：`FixerRegistry`。接口 `FixerRegistryApi` 在本文件的类上方。
 */

import { isEmpty } from '@velaros-ai/core'

import type { ProjectFixer } from '../../contract/requires.js'
import type { FixInput, FixResult, ProjectFixContext } from '../../types/fix.js'
import { emptyFixResult, fixerErrorResult, mergeFixResults } from '../../utils/checks.js'

/** 管理事务修复器（插件经 registerFixer 登记），按请求的检查范围依次尝试修复暂存变更。实例由内核持有，一个内核一份。 */
export interface FixerRegistryApi {
  /** 登记一个可参与事务修复的 fixer；按登记顺序运行。 */
  register(fixer: ProjectFixer): void
  /** 已登记的 fixer 号，按登记顺序。 */
  listIds(): string[]
  /**
   * 对事务依次运行被 checks 选中（没给 checks 时全部）且 canFix 为真的 fixer，合并它们的修复、诊断与工具需求。
   * 某个 fixer 的 canFix 或 fix 抛错不中断其余 fixer，记成一条 error 诊断、结果不通过。
   */
  fix(input: FixInput, ctx: ProjectFixContext): Promise<FixResult>
}

export class FixerRegistry implements FixerRegistryApi {
  private fixers: ProjectFixer[] = []

  public register(fixer: ProjectFixer): void {
    this.fixers.push(fixer)
  }

  public listIds(): string[] {
    return this.fixers.map((fixer) => fixer.id)
  }

  public async fix(input: FixInput, ctx: ProjectFixContext): Promise<FixResult> {
    let result = emptyFixResult(input.transactionId)
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
