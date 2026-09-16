import type { ToolExecutionPlanUpdate } from '../../types/agent'
import type { ExecutionTaskExecutionAdvice, ExecutionTaskPlanStep, ExecutionTaskRecord } from '../../types/agent.js'
import type { ExecutionRoutingCoordinator } from '../records/ExecRouting'
import type { ExecutionRecords } from '../records/ExecutionRecords'
/**
 * 一次执行里「任务 / 计划 / 下一步建议」这一面的聚合入口：任务状态与计划图都落在执行记录上，
 * 路由建议由路由协调器按当前任务算出来。由 `ExecutionService` 持有一份，自身不存状态。
 */
export interface ExecutionTaskFacadeApi {
  /** 标记某条任务开始执行。 */
  startTask(executionId: string, taskId: string): void
  /** 标记某条任务完成，可附一段结果摘要（写进记录，供调试面与后续轮次回看）。 */
  completeTask(executionId: string, taskId: string, result?: LooseOptional<string>): void
  /** 标记某条任务失败并记下原因。 */
  failTask(executionId: string, taskId: string, error: string): void
  /** 取执行当前指向的那条任务记录；执行记录恒有一条 root task，因此正常路径上不会取不到。 */
  getCurrentTask(executionId: string): ExecutionTaskRecord
  /** 取当前计划图（模型 plan 工具写、UI 与提示词预览读的同一份）。 */
  getCurrentPlan(executionId: string): ExecutionTaskPlanStep[]
  /** 按模型给的增量更新当前计划图，返回更新后的整份计划；UI 与提示词随即读到新的一份。 */
  updateCurrentPlan(executionId: string, input: ToolExecutionPlanUpdate): ExecutionTaskPlanStep[]
  /** 取当前任务上记着的推荐下一步动作，主要供工具与角色路由参考。 */
  getCurrentRecommendedAction(executionId: string): ExecutionTaskRecord['recommendedAction']
  /** 按当前任务算一条执行建议（模式 + 标题）；算不出来时返回 null，提示词里对应的那句就不出。 */
  getCurrentExecutionAdvice(executionId: string): Nullable<ExecutionTaskExecutionAdvice>
}

class ExecutionTaskFacade implements ExecutionTaskFacadeApi {
  constructor(
    private readonly records: ExecutionRecords,
    private readonly routingCoordinator: ExecutionRoutingCoordinator
  ) {}

  public startTask(executionId: string, taskId: string): void {
    this.records.startTask(executionId, taskId)
  }

  public completeTask(
    executionId: string,
    taskId: string,
    result?: LooseOptional<string>
  ): void {
    this.records.completeTask(executionId, taskId, result)
  }

  public failTask(executionId: string, taskId: string, error: string): void {
    this.records.failTask(executionId, taskId, error)
  }

  public getCurrentTask(executionId: string): ExecutionTaskRecord {
    const execution = this.records.getExecution(executionId)
    const currentTaskId = execution.currentTaskId
    return execution.tasks.find((task) => task.id === currentTaskId)!
  }

  public getCurrentPlan(executionId: string): ExecutionTaskPlanStep[] {
    return this.records.getCurrentPlan(executionId)
  }

  public updateCurrentPlan(
    executionId: string,
    input: ToolExecutionPlanUpdate
  ): ExecutionTaskPlanStep[] {
    return this.records.updateCurrentPlan(executionId, input)
  }

  public getCurrentRecommendedAction(
    executionId: string
  ): ExecutionTaskRecord['recommendedAction'] {
    return this.getCurrentTask(executionId).recommendedAction
  }

  public getCurrentExecutionAdvice(executionId: string): Nullable<ExecutionTaskExecutionAdvice> {
    return this.routingCoordinator.resolveExecutionAdvice(this.getCurrentTask(executionId))
  }
}

export { ExecutionTaskFacade }
