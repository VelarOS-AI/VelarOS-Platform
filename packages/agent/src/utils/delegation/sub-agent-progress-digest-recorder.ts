// SubAgentProgressDigestRecorder 用到的纯函数（不碰实例状态）。
import { isNonBlankString, truncate } from '@velaros-ai/core'

/** 从工具入参里挑一个最有信息量的短提示（第一个非空字符串值）。 */
export function pickArgsHint(args: Record<string, unknown>): Nullable<string> {
  for (const value of Object.values(args)) {
    if (isNonBlankString(value)) return truncate(value.trim(), 60)
  }
  return null
}
