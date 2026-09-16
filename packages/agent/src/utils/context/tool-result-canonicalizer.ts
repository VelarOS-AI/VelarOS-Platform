// ToolResultCanonicalizer 用到的纯函数（不碰实例状态）。
import { createHash } from 'node:crypto'

import type { CanonicalizeToolResultInput } from '../../types/context.js'
import { isStatefulToolResultName } from '../../utils/context/stateful-tool-results'

/** 取一段文本的 SHA-256 十六进制摘要。 */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 同批工具结果的去重键：会话 id 加内容哈希。 */
export function createBatchKey(sessionId: string, hash: string): string {
  return `${sessionId}\u0000${hash}`
}

/** 给一条工具结果算哈希；有状态的工具连同 callId 一起算，避免不同次调用被判成同一条。 */
export function hashToolResult(input: CanonicalizeToolResultInput): string {
  const content = isStatefulToolResultName(input.toolName)
    ? `${input.toolCallId}\u0000${input.serializedResult}`
    : input.serializedResult
  return sha256(content)
}
