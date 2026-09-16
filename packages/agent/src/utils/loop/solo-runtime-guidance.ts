

import type { ConsumeSoloRuntimeGuidanceInput, SoloRuntimeGuidanceResult } from '../../types/loop.js'

/**
 * 在收尾路径的某个检查点取一次用户插话：取到就压进 history 并报 `consumed: true`，
 * 让主循环再跑一轮去回应它，而不是结束回复。
 *
 * 取法按 phase 分两种：`before-complete` 是最终边界，用 `takeOrSeal()` 原子地「要么拿到输入、要么就此封口」，
 * 堵住封口与投递之间漏掉一条消息的窗口；其余 phase 用普通 `take()`，只有在没有 runtimeInput 端口时
 * 才回落到 `consumeGuidance`。
 * 拿到的消息 role 不是 user 就记一条 warn 丢弃（不进 history），按未消费处理。
 */
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
