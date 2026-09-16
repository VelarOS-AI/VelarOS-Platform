// UserTextPayloadPlanner 用到的纯函数（不碰实例状态）。
/** 用户文本载荷的索引键：会话 id、消息序号与哈希前 12 位。 */
export function buildUserTextMessageKey(sessionId: string, messageIndex: number, hash: string): string {
  return `${sessionId}:user:${messageIndex}:${hash.slice(0, 12)}`
}
