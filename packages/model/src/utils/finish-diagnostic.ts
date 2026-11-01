import { isUndefined } from '@velaros-ai/core'

/** 只输出固定枚举；未知值不回显，避免泄露或改变重试分类。 */
export function safeFinishDiagnostic(value: unknown): string {
  if (isUndefined(value)) return 'missing'
  if (value === null) return 'null'
  return typeof value === 'string' &&
    [
      'stop',
      'length',
      'tool-calls',
      'content-filter',
      'error',
      'other',
      'unknown',
      'tool_calls',
      'function_call',
      'content_filter',
      'max_output_tokens',
    ].includes(value)
    ? value
    : 'unrecognized'
}
