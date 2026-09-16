import type { ToolExecutionApi } from '../../contract/requires.js'
import type { ExecutionRecord } from '../../types/agent.js'
import type { ToolExecutionApiHost } from '../../types/tools.js'

/**
 * 执行域绑定器：把宿主那套「带 executionId 的执行服务」包成「这一次执行的执行域」，工具拿到手就不用
 * 再自己传 executionId，也拿不到别的执行。
 *
 * 由执行服务在装配时建一份（构造时收下宿主），每次开始一次执行时 `bind` 出一个只认那次执行的门面。
 * 自身不存任何执行状态——任务、计划、当前建议都在宿主那边，每次调用现问现取。
 */
export interface ToolExecutionApiBindingApi {
  /**
   * 为这一次执行绑出一个执行域门面。返回的对象在整次执行期间可以一直用，
   * 每个方法都转给宿主并带上这次执行的 id；执行结束后再调，语义由宿主决定（通常是找不到执行而报错）。
   */
  bind(execution: ExecutionRecord): ToolExecutionApi
}

class ToolExecutionApiBinding implements ToolExecutionApiBindingApi {
  constructor(private readonly host: ToolExecutionApiHost) {}

  public bind(execution: ExecutionRecord): ToolExecutionApi {
    const host = this.host
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
}

/** 将公开执行域方法绑定到当前执行，供工具调用。 */
function createToolExecutionApi(
  execution: ExecutionRecord,
  host: ToolExecutionApiHost
): ToolExecutionApi {
  return new ToolExecutionApiBinding(host).bind(execution)
}

export { createToolExecutionApi }
