import type { ModelMessage } from 'ai'

import type { ScopedLog } from '@velaros-ai/core/logger'

import type { AgentRuntimeInputPort } from './RuntimeInputPort'

type SoloRuntimeGuidancePhase = 'turn-start' | 'before-goal-check' | 'before-complete'

interface ConsumeSoloRuntimeGuidanceInput {
  turn: number
  phase: SoloRuntimeGuidancePhase
  history: ModelMessage[]
  runtimeInput?: AgentRuntimeInputPort
  consumeGuidance?: () => Nullable<ModelMessage> | Promise<Nullable<ModelMessage>>
  log: Pick<ScopedLog, 'info' | 'warn'>
}

type SoloRuntimeGuidanceResult =
  | { consumed: true; reason: 'user-guidance' }
  | { consumed: false; reason: 'none' | 'non-user-message' }

async function consumeSoloRuntimeGuidance(
  input: ConsumeSoloRuntimeGuidanceInput
): Promise<SoloRuntimeGuidanceResult> {
  const finalDrain =
    input.phase === 'before-complete' && input.runtimeInput
      ? await input.runtimeInput.takeOrSeal()
      : null
  const message = finalDrain
    ? finalDrain.status === 'input'
      ? finalDrain.message
      : null
    : input.runtimeInput
      ? await input.runtimeInput.take()
      : await input.consumeGuidance?.()
  if (!message) return { consumed: false, reason: 'none' }

  if (message.role !== 'user') {
    input.log.warn('ignored non-user runtime guidance message', {
      turn: input.turn,
      phase: input.phase,
    })
    return { consumed: false, reason: 'non-user-message' }
  }

  input.history.push(message)
  input.log.info('runtime guidance consumed', { turn: input.turn, phase: input.phase })
  return { consumed: true, reason: 'user-guidance' }
}

export { consumeSoloRuntimeGuidance }
export type {
  ConsumeSoloRuntimeGuidanceInput,
  SoloRuntimeGuidancePhase,
  SoloRuntimeGuidanceResult,
}
