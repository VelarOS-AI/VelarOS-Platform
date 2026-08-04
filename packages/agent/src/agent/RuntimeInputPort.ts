import type { ModelMessage } from 'ai'

type AgentRuntimeInputResult =
  | { status: 'input'; message: ModelMessage }
  | { status: 'sealed' }

/**
 * Host-injected input lane for one Agent execution.
 *
 * `takeOrSeal` is the completion boundary: it either returns one already accepted FIFO input or
 * atomically closes the lane. Capability and product implementations remain outside Agent Runtime.
 */
interface AgentRuntimeInputPort {
  take(): Nullable<ModelMessage> | Promise<Nullable<ModelMessage>>
  takeOrSeal(): AgentRuntimeInputResult | Promise<AgentRuntimeInputResult>
  /**
   * Observe newly accepted input while a provider turn is in flight.
   *
   * The listener is also invoked synchronously when input is already pending, closing the race
   * between the turn-start drain and provider request creation. Callers must dispose the listener
   * as soon as that provider turn settles; tool execution is a separate transaction boundary.
   */
  onInputAccepted(listener: () => void): () => void
}

interface AgentRuntimeInputInterruptScope {
  signal: AbortSignal
  dispose(): void
}

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
export type {
  AgentRuntimeInputInterruptScope,
  AgentRuntimeInputPort,
  AgentRuntimeInputResult,
}
