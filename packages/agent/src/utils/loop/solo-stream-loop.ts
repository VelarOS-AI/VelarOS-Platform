// SoloStreamLoop 用到的纯函数（不碰实例状态）。
import { type AppError } from '@velaros-ai/core/error'

import type { SoloInterruptedToolCallRecoveryKind } from '../../types/loop.js'

/**
 * 主 Agent 面（B5 单引擎双面：装配 AgentLoop 引擎的 UI 投影面）。
 *
 * 每一轮执行顺序（引擎骨架 + 本面装配）：
 * 1. 检查 abort（护栏 3，引擎）。
 * 2. 构建系统提示词和本轮上下文。
 * 3. 整理/压缩历史记录，避免超过上下文窗口。
 * 4. 调用模型流式接口，并在流式过程中即时执行工具。
 * 5. 若有工具调用，把 tool result 追加回 history 后进入下一轮。
 * 6. 若没有工具调用，运行自动验证 gate，通过后结束。
 */

export function resolveInterruptedToolCallRecoveryKind(
  error: AppError
): SoloInterruptedToolCallRecoveryKind {
  const reason = error.context?.reason
  if (reason === 'final_tool_name_missing' || reason === 'tool_input_start_name_missing') return 'invalid-identity'
  const finishReason = error.context?.finishReason
  return finishReason === 'length' || finishReason === 'repetition_truncation'
    ? 'output-truncation'
    : 'invalid-input'
}

/** 构造注入给下一轮的能力中立纠正提示，不把所有参数协议错误误报为超长截断。 */
export function buildInterruptedToolCallRecoveryGuidance(
  kind: SoloInterruptedToolCallRecoveryKind
): string {
  if (kind === 'invalid-identity') return [
    '上一次工具调用缺少工具名称，已在执行前拒绝，没有产生副作用。',
    '如果该操作仍然必要，请从当前工具目录中选择一个明确工具，并重新发送一次完整调用。',
    '不要猜测或省略工具名，也不要重复分析；现在直接完成这个未执行的操作。',
  ].join('\n')

  if (kind === 'invalid-input') return [
    '上一次工具调用的参数不是完整、合法的 JSON object，已在执行前拒绝，没有产生副作用。',
    '如果该操作仍然必要，只重发一个完整工具调用；严格遵循当前 schema，确保字符串、换行和引号正确转义。',
    '参数含长文本时，改用当前能力公开的小块写入或分段追加方式；具体操作名与参数以工具目录为准。',
    '不要重复分析，现在直接完成这个未执行的操作。',
  ].join('\n')

  return [
    '上一次工具调用因为一次性输出内容过大，在传输中途被截断、没能执行。',
    '请把这次操作拆成更小的多次工具调用，每次只处理一部分，不要再一口气输出超大内容。',
    '优先使用当前能力公开的局部更新或分段追加操作；具体操作名与参数必须以工具目录为准。',
    '现在就用更小的分批方式重做这次操作。',
  ].join('\n')
}
