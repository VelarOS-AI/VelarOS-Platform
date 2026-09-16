

import type { RunSoloToolUseContinuationInput, SoloToolUseContinuationEvents, SoloToolUseContinuationResult } from '../../types/loop.js'
import { createInternalFollowUpMessage } from '../history/internal-messages'
import { ChatRuntimeEvents } from '../wire/chat-runtime.js'

import { markToolSpaceBootstrapDiscoverySatisfied } from './tool-space-bootstrap-planner'

/**
 * 模型这一轮确实调了工具之后的续轮处理：先把工具空间侦察标记为已满足（模型已经动手，不必再强制它先查地图），
 * 执行并把工具结果追加进 history，再压入 after-tool 阶段的 loop reminder。
 *
 * 正常返回 `continue` 进下一轮；只有隐藏轮数帽已经耗尽（`shouldForceStopAfterToolTurn`）时才记一条 warn，
 * 返回 `completed` / `wind-down-cap` 就地收尾——此时不再走收尾门，因为收的理由是帽子到顶而非模型答完了。
 * 两条路都会先发 turnEnd 事件，也都把本轮工具结果原样带出去。
 */
async function runSoloToolUseContinuation<
  TExecutor,
  TToolContext,
  TEvents extends SoloToolUseContinuationEvents = SoloToolUseContinuationEvents,
>(
  input: RunSoloToolUseContinuationInput<TExecutor, TToolContext, TEvents>
): Promise<SoloToolUseContinuationResult> {
  if (input.bootstrapToolChoice) {
    input.setBootstrapState(
      markToolSpaceBootstrapDiscoverySatisfied(input.getBootstrapState())
    )
  }

  const toolResults = await input.appendToolResultsToHistory(input.history, input.executor)

  const afterToolReminders = await input.tickLoopReminders({
    mode: 'solo',
    phase: 'after-tool',
    toolContext: input.toolContext,
  })
  for (const reminder of afterToolReminders) {
    input.history.push(createInternalFollowUpMessage(reminder))
  }

  if (input.shouldForceStopAfterToolTurn()) {
    input.log.warn('solo loop hit hidden turn cap; forcing stop', {
      turn: input.turn,
      hardCap: input.hardCap,
    })
    input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
    return { status: 'completed', reason: 'wind-down-cap', toolResults }
  }

  input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
  input.log.debug('turn end', { turn: input.turn })
  return { status: 'continue', toolResults }
}

export { runSoloToolUseContinuation }
