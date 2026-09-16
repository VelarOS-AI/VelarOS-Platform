/** 工具载荷句柄的拼法：句柄要能唯一定位「哪个会话的哪份内容」，故会话 id 先转义再与内容哈希拼接。 */
export function buildContextPayloadRef(sessionId: string, hash: string): string {
  return `ctx-payload:${encodeURIComponent(sessionId)}:${hash}`
}

/** 用户文本载荷句柄的拼法：与工具载荷句柄同构，只靠前缀区分两类载荷。 */
export function buildContextUserTextRef(sessionId: string, hash: string): string {
  return `ctx-user-payload:${encodeURIComponent(sessionId)}:${hash}`
}
