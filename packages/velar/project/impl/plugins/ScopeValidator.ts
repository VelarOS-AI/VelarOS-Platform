/**
 * 事务范围校验器：`ScopeValidator`，实现注入面的 `ProjectValidator`（contract/requires.ts）。
 * 核对事务改动的文件数、行数不超过策略上限，也没有碰受保护文件和生成文件；核心插件总会装它。
 */

import { isEmpty } from '@velaros-ai/core'

import type { ProjectValidator } from '../../contract/requires.js'
import type { ProjectValidationContext, ValidateInput, ValidationResult } from '../../types/validation.js'
import { matchesAny } from '../../utils/glob.js'

export class ScopeValidator implements ProjectValidator {
  public readonly id = 'core.scope'

  public canValidate(): boolean {
    return true
  }

  public validate(input: ValidateInput, context: ProjectValidationContext): ValidationResult {
    const diagnostics: ValidationResult['diagnostics'] = []
    const tx = input.transactionId ? context.getTransaction(input.transactionId) : undefined
    if (tx) {
      if (tx.changedFiles.length > context.policy.maxChangedFilesPerTransaction) {
        diagnostics.push({ severity: 'error', message: `变更文件过多：${tx.changedFiles.length}`, source: this.id })
      }
      if (tx.changedLines > context.policy.maxChangedLinesPerTransaction) {
        diagnostics.push({ severity: 'error', message: `变更行数过多：${tx.changedLines}`, source: this.id })
      }
      for (const file of tx.changedFiles) {
        if (matchesAny(file, context.policy.protectedFiles)) {
          diagnostics.push({ severity: 'error', message: `受保护文件被修改：${file}`, path: file, source: this.id })
        }
        if (matchesAny(file, context.policy.generatedFiles)) {
          diagnostics.push({ severity: 'error', message: `生成文件不能手工修改：${file}`, path: file, source: this.id })
        }
      }
    }
    return { ok: isEmpty(diagnostics), diagnostics, checks: [{ id: this.id, ok: isEmpty(diagnostics), diagnostics }] }
  }
}
