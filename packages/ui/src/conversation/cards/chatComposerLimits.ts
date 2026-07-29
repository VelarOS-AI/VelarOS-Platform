/**
 * 输入卡（`ChatAwaitingInputCard`）所需的 composer 字符上限 + 钳制——子集副本。
 *
 * composer 完整限额面（图片/请求/违规）是 composer 域（第五原子），随其入包；此处只复制输入卡实际
 * 消费的 3 个符号（常量 + 纯钳制），过渡期与宿主 `@utils/chat/chatComposerLimits` 同值，composer 原子
 * 落地后统收。
 */
export const ChatComposerInputMaxChars = 60_000
export const ChatComposerInputWarningChars = Math.floor(ChatComposerInputMaxChars * 0.9)

export function clampChatComposerInput(input: string): {
  value: string
  truncated: boolean
} {
  if (input.length <= ChatComposerInputMaxChars) return { value: input, truncated: false }

  return {
    value: input.slice(0, ChatComposerInputMaxChars),
    truncated: true,
  }
}
