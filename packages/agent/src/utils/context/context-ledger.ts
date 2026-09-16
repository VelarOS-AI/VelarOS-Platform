import { isString, Log } from '@velaros-ai/core'



/**
 * 块文本失败信号判定：safety.containsFailureCause（ContextWorkingSetOS 分类）与
 * toolFailureReason 特征（ContextAttentionPolicyEngine 打分）共用的单源正则。
 */
export function hasFailureSignal(contentText: string): boolean {
  for (const line of contentText.split('\n')) {
    const start = line.trimStart().toLowerCase()
    if (start.startsWith('error:') || start.startsWith('fatal:')) return true
  }
  return /\b(failed|failure|exception|stderr|exit code|timeout|denied)\b/iu.test(contentText)
}

export function estimateBlockChars(value: unknown): number {
  if (isString(value)) return value.length

  try {
    return JSON.stringify(value)?.length ?? String(value).length
  } catch (error) {
    Log.tag('ContextLedger').warn('estimateBlockChars JSON.stringify failed, using string length fallback', { error })
    return String(value).length
  }
}

export function estimateBlockTokens(chars: number): number {
  return Math.max(1, Math.ceil(Math.max(0, chars) / 4))
}
