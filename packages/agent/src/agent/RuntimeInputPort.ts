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
}

export type { AgentRuntimeInputPort, AgentRuntimeInputResult }
