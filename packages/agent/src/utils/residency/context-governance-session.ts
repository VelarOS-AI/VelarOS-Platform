// ContextGovernanceSession 用到的纯函数（不碰实例状态）。
/** 两串 id 序列的公共前缀长度：治理投影靠它判断这一轮的前缀有没有被改写。 */
export function resolveSharedPrefixLength(left: readonly string[], right: readonly string[]): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}
