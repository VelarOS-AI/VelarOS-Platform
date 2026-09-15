/**
 * 校验与修复的公共小函数：按请求的 checks 挑 validator，修复结果的空值、失败值与合并。`ValidatorRegistry`、`FixerRegistry` 共用。
 */

import { isEmpty, isNonBlankString, optionalWhen } from '@velaros-ai/core'

import type { ProjectValidator } from '../contract/requires.js'
import type { FixResult } from '../types/fix.js'

import { toErrorObject } from './errors.js'

/** validator 有没有被本次 checks 选中：没给 checks 时全选；给了就按 validator 的 id 和 checkIds 别名匹配。 */
export function isSelectedValidator(validator: ProjectValidator, checks?: readonly string[]): boolean {
  if (!checks || isEmpty(checks)) return true
  return [validator.id, ...(validator.checkIds ?? [])].some((id) => checks.includes(id))
}

/** 一个 fixer 都没跑时的修复结果：通过、没改动。 */
export function emptyFixResult(transactionId: string): FixResult {
  return {
    ok: true,
    changed: false,
    transactionId,
    changedFiles: [],
    fixes: [],
    diagnostics: [],
  }
}

/** fixer 在某个阶段（canFix、fix）抛错时的修复结果：不通过，带一条 source 为「fixer 号.阶段」的 error 诊断。 */
export function fixerErrorResult(
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

/** 合并两次修复结果：都通过才通过，有一次改动就算改动，改动文件去重，修复、诊断与工具需求依次拼接。 */
export function mergeFixResults(current: FixResult, next: FixResult, transactionId: string): FixResult {
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
