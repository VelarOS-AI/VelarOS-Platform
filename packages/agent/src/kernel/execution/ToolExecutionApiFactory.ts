import type {
  ExecutionRecord,
  ExecutionTaskRecord,
  ToolExecutionApi,
  ToolExecutionPlanUpdate,
} from '@velaros-ai/agent/protocol'

interface ToolExecutionApiHost {
  awaitConfirmation: (
    executionId: string,
    ...args: Parameters<ToolExecutionApi['awaitConfirmation']>
  ) => ReturnType<ToolExecutionApi['awaitConfirmation']>
  awaitConfirmationDecision: (
    executionId: string,
    ...args: Parameters<ToolExecutionApi['awaitConfirmationDecision']>
  ) => ReturnType<ToolExecutionApi['awaitConfirmationDecision']>
  awaitUserInput: (
    executionId: string,
    ...args: Parameters<ToolExecutionApi['awaitUserInput']>
  ) => ReturnType<ToolExecutionApi['awaitUserInput']>
  startTask: (executionId: string, taskId: string) => void
  completeTask: (executionId: string, taskId: string, result?: LooseOptional<string>) => void
  failTask: (executionId: string, taskId: string, error: string) => void
  getExecution: (executionId: string) => ExecutionRecord
  getCurrentTask: (executionId: string) => ExecutionTaskRecord
  getCurrentPlan: (executionId: string) => ReturnType<ToolExecutionApi['getCurrentPlan']>
  updateCurrentPlan: (
    executionId: string,
    input: ToolExecutionPlanUpdate
  ) => ReturnType<ToolExecutionApi['updateCurrentPlan']>
  getCurrentRecommendedAction: (
    executionId: string
  ) => ExecutionTaskRecord['recommendedAction']
  getCurrentExecutionAdvice: (
    executionId: string
  ) => ReturnType<ToolExecutionApi['getCurrentExecutionAdvice']>
}

/** 将公开执行域方法绑定到当前执行，供工具调用。 */
function createToolExecutionApi(
  execution: ExecutionRecord,
  host: ToolExecutionApiHost
): ToolExecutionApi {
  return {
    executionId: execution.id,
    awaitConfirmation: (message, abortSignal, options) =>
      host.awaitConfirmation(execution.id, message, abortSignal, options),
    awaitConfirmationDecision: (message, abortSignal, options) =>
      host.awaitConfirmationDecision(execution.id, message, abortSignal, options),
    awaitUserInput: (question, abortSignal) =>
      host.awaitUserInput(execution.id, question, abortSignal),
    startTask: (taskId) => host.startTask(execution.id, taskId),
    completeTask: (taskId, result) => host.completeTask(execution.id, taskId, result),
    failTask: (taskId, error) => host.failTask(execution.id, taskId, error),
    getCurrentTaskId: () => host.getExecution(execution.id).currentTaskId,
    getCurrentTask: () => host.getCurrentTask(execution.id),
    getCurrentPlan: () => host.getCurrentPlan(execution.id),
    updateCurrentPlan: (input) => host.updateCurrentPlan(execution.id, input),
    getCurrentRecommendedAction: () => host.getCurrentRecommendedAction(execution.id),
    getCurrentExecutionAdvice: () => host.getCurrentExecutionAdvice(execution.id),
  }
}

export { createToolExecutionApi }
export type { ToolExecutionApiHost }
