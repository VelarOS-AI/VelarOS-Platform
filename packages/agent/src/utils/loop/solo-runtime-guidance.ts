

import type { ConsumeSoloRuntimeGuidanceInput, SoloRuntimeGuidanceResult } from '../../types/loop.js'

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
