/** 治理预算以当前模型的可用输入容量为准，与最终发送门共享输出预留和安全余量。 */
import { isFiniteNumber } from '@velaros-ai/core'

import type { ContextGovernanceConfig,GovernanceWindowDerivation, GovernanceWindowInput } from '../../types/residency.js'
import { resolveContextUsageWindow } from '../context/context-usage'
import { AgentTuning } from '../tuning'

/** 兼容旧导出；可用窗口已经扣除安全余量，不再额外乘提前治理折扣。值在 AgentTuning.residency.governanceHeadroomRatio。 */
export const GovernanceHeadroomRatio: number = AgentTuning.residency.governanceHeadroomRatio

/** G 的地板：固定开销已经撑破送核门时的退化取值（治理器每轮必开）。值在 AgentTuning.residency.minGovernanceWindowTokens。 */
export const MinGovernanceWindowTokens: number = AgentTuning.residency.minGovernanceWindowTokens

/** 完整输入容量扣除不可回收开销即为账本预算；旧 cap 不会让大窗口提前压缩。 */
export function resolveGovernanceWindow(
  _config: ContextGovernanceConfig,
  input: GovernanceWindowInput = {}
): GovernanceWindowDerivation {
  const window = resolveContextUsageWindow({
    contextWindow: input.modelWindowTokens,
    reservedOutputTokens: input.reservedOutputTokens,
    safetyMarginPercent: input.safetyMarginPercent,
  })
  const sendGateLimitTokens = window.usableContextWindow
  const fixedOverheadTokens =
    isFiniteNumber(input.fixedOverheadTokens) && input.fixedOverheadTokens > 0
      ? Math.floor(input.fixedOverheadTokens)
      : 0
  const headroomTokens = sendGateLimitTokens - fixedOverheadTokens
  const windowTokens = Math.max(MinGovernanceWindowTokens, Math.floor(headroomTokens))
  const source: GovernanceWindowDerivation['source'] = headroomTokens < 1 ? 'floor' : 'send-gate'

  return {
    contextWindow: window.contextWindow,
    usableContextWindow: window.usableContextWindow,
    sendGateLimitTokens,
    fixedOverheadTokens,
    headroomTokens,
    windowTokens,
    source,
  }
}

/** 治理窗口 G（token）——只要数字不要推导过程时的便捷式。 */
export function resolveGovernanceWindowTokens(
  config: ContextGovernanceConfig,
  input: GovernanceWindowInput = {}
): number {
  return resolveGovernanceWindow(config, input).windowTokens
}

/** 兼容旧诊断函数：低层配置是否要求提前触发；运行时不依赖该结果决定治理。 */
export function governanceWakesBeforeSendGate(
  config: ContextGovernanceConfig,
  derivation: GovernanceWindowDerivation
): boolean {
  const triggerTokens = (config.epochTriggerPercent / 100) * derivation.windowTokens
  return derivation.fixedOverheadTokens + triggerTokens < derivation.sendGateLimitTokens
}
