/**
 * 后置条件校验器：`PostconditionValidator`，实现注入面的 `ProjectValidator`（contract/requires.ts）。
 * 请求带 postconditions 时才跑：改动文件在允许列表里、改动行数不超上限、改动文件必须含或不含某段文本（按事务暂存正文判断）。
 */

import { isEmpty, isPresent } from '@velaros-ai/core'

import type { ProjectValidator } from '../../contract/requires.js'
import type { ProjectValidationContext, ValidateInput, ValidationResult } from '../../types/validation.js'

export class PostconditionValidator implements ProjectValidator {
  public readonly id = 'core.postcondition'

  public canValidate(input: ValidateInput): boolean {
    return !!input.postconditions && !isEmpty(input.postconditions)
  }

  public async validate(input: ValidateInput, context: ProjectValidationContext): Promise<ValidationResult> {
    const diagnostics: ValidationResult['diagnostics'] = []
    const tx = input.transactionId ? context.getTransaction(input.transactionId) : undefined
    for (const post of input.postconditions ?? []) {
      if (post.type === 'changed_files_allowlist' && tx) {
        const allow = post.value as string[]
        for (const file of tx.changedFiles) {
          if (!allow.includes(file)) diagnostics.push({ severity: 'error', message: `变更文件不在允许列表中：${file}`, path: file, source: this.id })
        }
      }
      if (post.type === 'max_changed_lines' && tx) {
        const max = Number(post.value)
        if (tx.changedLines > max) diagnostics.push({ severity: 'error', message: `变更行数 ${tx.changedLines} 超过上限 ${max}`, source: this.id })
      }
      if ((post.type === 'must_contain' || post.type === 'must_not_contain') && tx) {
        const needle = String(post.value)
        for (const file of tx.changedFiles) {
          const content = await context.readFile(file)
          if (!isPresent(content)) continue
          if (post.type === 'must_contain' && !content.includes(needle)) diagnostics.push({ severity: 'error', message: `文件必须包含：${needle}`, path: file, source: this.id })
          if (post.type === 'must_not_contain' && content.includes(needle)) diagnostics.push({ severity: 'error', message: `文件不能包含：${needle}`, path: file, source: this.id })
        }
      }
    }
    return { ok: isEmpty(diagnostics), diagnostics, checks: [{ id: this.id, ok: isEmpty(diagnostics), diagnostics }] }
  }
}
