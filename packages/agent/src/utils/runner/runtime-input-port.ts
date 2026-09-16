import type { AgentRuntimeInputPort } from '../../contract/requires.js'
import type { AgentRuntimeInputInterruptScope } from '../../types/runner.js'

/**
 * 造一个「用户又输入了」就自动中止的作用域：返回 AbortSignal 与配套的 dispose。
 *
 * 订阅运行期输入端口的 onInputAccepted，一旦收到新输入就以 `'runtime-input-accepted'` 为原因中止
 * （已中止则不重复触发），让当前这段等待立刻让位给用户的新指令。
 * 没有传 runtimeInput（无输入端口的场景）时 signal 永不触发，dispose 是空操作——调用方不必分支。
 * 用完必须调 dispose 退订，否则订阅会随作用域泄漏。
 */
function createAgentRuntimeInputInterruptScope(
  runtimeInput?: AgentRuntimeInputPort
): AgentRuntimeInputInterruptScope {
  const controller = new AbortController()
  const dispose = runtimeInput?.onInputAccepted(() => {
    if (!controller.signal.aborted) controller.abort('runtime-input-accepted')
  }) ?? (() => undefined)

  return { signal: controller.signal, dispose }
}

export { createAgentRuntimeInputInterruptScope }
