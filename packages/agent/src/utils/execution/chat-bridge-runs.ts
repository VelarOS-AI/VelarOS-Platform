// 域：聊天面 → 内核会话桥里，单条 run 与它那条消息上的纯判读。桥自己只管排队与唤醒。
import { AppError } from '@velaros-ai/core/error'

import type { ChatSendRequest } from '../../types/agent.js'
import type { PendingKernelChatRun } from '../../types/execution.js'

/**
 * 把一条 run 标记为「已获准入」：先回调宿主的接收回执，再兑现它的准入闸。
 * 已经被取消的 run 在这里就抛 `EXECUTION_ABORTED`，保证回执先于运行唤醒生效，
 * 失败或已取消的输入不会白白消费掉宿主上下文（比如清空输入框）。
 */
export function acceptPendingChatRun<TRenderTarget>(
  run: PendingKernelChatRun<TRenderTarget>
): void {
  if (run.cancelled) throw new AppError('EXECUTION_ABORTED', '这次聊天提交在获准入之前已被取消：本轮不会运行，要继续请重新发送。')
  run.onAccepted?.()
  run.admission.resolve()
}

/**
 * 从一次发送的消息列表里倒着找最后一条用户消息：它才是这轮要落进输入账本的那条。
 * 一条都没有（例如整份 payload 只有系统提醒）返回 null，调用方据此跳过入账直接排执行。
 */
export function findLatestUserMessage(
  messages: ChatSendRequest['messages']
): Nullable<ChatSendRequest['messages'][number]> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') return message
  }
  return null
}
