import type {
  ExecutionTaskExecutionAdvice,
  ExecutionTaskPlanStep,
  ExecutionTaskRecord,
  ToolExecutionPlanUpdate,
} from '@velaros-ai/core/types'

import type { ExecutionRecords, ExecutionRoutingCoordinator } from '../../execution'

/** 围绕 execution 聚合任务、计划更新与执行建议。 */
class ExecutionTaskFacade {
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
