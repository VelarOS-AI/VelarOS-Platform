import { toNullable } from '@velaros-ai/core'

import type { ExecutionRecord, StreamExecutionGraphPayload } from '../../types/agent.js'
import { buildExecutionAdvice, buildPlanView } from '../../utils/records/debug-plan-view'
import { requireCurrentTask } from '../../utils/records/execution-tasks'

/**
 * 调试图载荷：把一条 `ExecutionRecord` 压成调试面板一次渲染要的扁平结构（计划视图 + 任务列表 + 最近事件）。
 *
 * 无状态，每次调用现算；`execution.currentTaskId` 指向的任务必须在 `tasks` 里，找不到直接抛 `INVARIANT`，因为那是记录本身坏了。
 * 实现是 `ExecDebugPayload`（对外别名 `ExecutionDebugPayloadBuilder`），由 `ExecutionRecords` 持有。
 */
export interface ExecDebugPayloadApi {
  /** 现算一份调试面板载荷：计划视图取「有执行计划的最近祖先任务」，所以子任务在跑时也能看到父任务的整盘计划；事件只带最近 80 条，防止长执行把载荷撑爆。当前任务在记录里找不到时抛 `INVARIANT`。 */
  build(execution: ExecutionRecord): StreamExecutionGraphPayload
}

class ExecDebugPayload implements ExecDebugPayloadApi {
  public build(execution: ExecutionRecord): StreamExecutionGraphPayload {
    const currentTaskId = execution.currentTaskId
    const currentTask = requireCurrentTask(execution, 'buildDebugPayload')
    const currentExecutionAdvice = buildExecutionAdvice(currentTask)

    return {
      kind: 'execution-graph',
      executionId: execution.id,
      sourceSessionId: execution.sourceSessionId,
      status: execution.status,
      currentTaskId,
      currentRecommendedAction: (toNullable(currentTask.recommendedAction)),
      currentExecutionAdvice,
      planView: buildPlanView(execution, currentTask),
      roleId: execution.roleId,
      roleLabel: execution.roleLabel,
      tasks: execution.tasks,
      events: execution.events.slice(-80),
    }
  }
}

export { ExecDebugPayload, ExecDebugPayload as ExecutionDebugPayloadBuilder }
