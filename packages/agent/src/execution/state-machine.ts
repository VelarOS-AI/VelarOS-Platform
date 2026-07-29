import { AppError } from '@velaros-ai/core/error'
import type { ExecutionStatus } from '@velaros-ai/core/types'

/**
 * 合法状态迁移表。
 *
 * - 待开始：起始态，可进入等待确认、运行、中断或失败。
 * - 等待确认：等待用户确认，同意后运行，拒绝后失败，取消后中断。
 * - 运行中：可暂停等待输入或确认，也可正常完成或异常结束。
 * - 等待输入：等待用户文本输入，提交后回到运行中。
 * - 中断、完成、失败：终态，不再允许任何迁移。
 */
const AllowedTransitions: Record<ExecutionStatus, ExecutionStatus[]> = {
  pending: ['awaiting_confirmation', 'running', 'aborted', 'failed'],
  awaiting_confirmation: ['running', 'aborted', 'failed'],
  running: ['awaiting_confirmation', 'awaiting_input', 'aborted', 'completed', 'failed'],
  awaiting_input: ['running', 'aborted', 'failed'],
  aborted: [],
  completed: [],
  failed: [],
}

/**
 * 执行状态机。
 *
 * 提供合法状态迁移校验，防止 ExecutionRecord 从终态被错误地拉回到中间态，
 * 或跳过必要中间态（如直接从 pending 跳到 completed）。
 */
class ExecStateMachine {
  public canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
    return AllowedTransitions[from].includes(to)
  }

  public assertCanTransition(from: ExecutionStatus, to: ExecutionStatus): void {
    if (!this.canTransition(from, to)) {
      throw new AppError(
        'VALIDATION',
        `非法的执行状态流转：${from} -> ${to}`
      )
    }
  }
}

export { ExecStateMachine }
export { ExecStateMachine as ExecutionStateMachine }
