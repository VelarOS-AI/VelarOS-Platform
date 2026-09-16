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

/**
 * 量一块上下文占多少字符：字符串直接取长度，其余按 `JSON.stringify` 后的长度算。
 * stringify 抛错（循环引用等）或返回 undefined 时退到 `String(value).length`，并记一条 warn——
 * 账本宁可给个偏小的估计，也不能因为某一块序列化不了就让整轮预算核算崩掉。
 */
export function estimateBlockChars(value: unknown): number {
  if (isString(value)) return value.length

  try {
    return JSON.stringify(value)?.length ?? String(value).length
  } catch (error) {
    Log.tag('ContextLedger').warn('estimateBlockChars JSON.stringify failed, using string length fallback', { error })
    return String(value).length
  }
}

/**
 * 按「4 字符 ≈ 1 token」的粗口径把字符数折成 token 数，向上取整。
 * 负数按 0 处理，但结果最少为 1——账本里不允许出现「占 0 token」的块，否则零成本的块会绕过所有预算闸门。
 * 这是账本用的快估，不是真分词；精确估算见 context-usage.ts 的 estimateStringTokens。
 */
export function estimateBlockTokens(chars: number): number {
  return Math.max(1, Math.ceil(Math.max(0, chars) / 4))
}
