import type { AgentRuntimeInputPort } from '../../contract/requires.js'
import type { AgentRuntimeInputInterruptScope } from '../../types/runner.js'

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
