import type { ToolExecutionApi } from '../../contract/requires.js'
import type { ExecutionRecord } from '../../types/agent.js'
import type { ToolExecutionApiHost } from '../../types/tools.js'

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
