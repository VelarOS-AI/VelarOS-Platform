import type { ExecutionStatus } from '../../types/agent.js'
import { assertCanTransitionExecutionStatus, canTransitionExecutionStatus } from '../../utils/records/state-machine'

/**
 * 执行状态机。
 *
 * 提供合法状态迁移校验，防止 ExecutionRecord 从终态被错误地拉回到中间态，
 * 或跳过必要中间态（如直接从 pending 跳到 completed）。
 *
 * 迁移表与判定本身是纯函数（`utils/records/state-machine.ts`），这里只把它们收成一个可注入的件：
 * `ExecutionService` 建一份，`ExecutionRecords` 从构造参数收，宿主换判据时不必改账本。
 */
export interface ExecStateMachineApi {
  /** 问一次「from 能不能走到 to」：合法返回 true，终态一律 false。纯判定，不落任何状态。 */
  canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean
  /** 写入新状态前的把门：非法迁移直接抛 VALIDATION 错误，调用方不必再自己判一遍。 */
  assertCanTransition(from: ExecutionStatus, to: ExecutionStatus): void
}

class ExecStateMachine implements ExecStateMachineApi {
  public canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
    return canTransitionExecutionStatus(from, to)
  }

  public assertCanTransition(from: ExecutionStatus, to: ExecutionStatus): void {
    assertCanTransitionExecutionStatus(from, to)
  }
}

export { ExecStateMachine, ExecStateMachine as ExecutionStateMachine }
