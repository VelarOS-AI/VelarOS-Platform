// 上下文载荷存储的索引键（纯函数，不碰实例状态）。
/** 载荷存储的索引键：会话 id 加内容哈希。 */
export function createStoreKey(sessionId: string, hash: string): string {
  return `${sessionId}:${hash}`
}
