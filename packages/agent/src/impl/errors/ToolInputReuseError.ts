import { AppError } from '@velaros-ai/core/error'

/**
 * 复用请求无法还原成可执行参数。reusableAttempt 表示原失败调用仍未被认领：执行器把它原样放回回执的
 * inputReuse，模型改好 changes 即可再复用；引用无效、已执行或已被认领时不带它，只说明原因。
 */
export class ToolInputReuseError extends AppError {
  constructor(message: string, details: Record<string, unknown>, readonly reusableAttempt?: string) {
    super('VALIDATION', message, undefined, details)
    this.name = 'ToolInputReuseError'
  }
}
