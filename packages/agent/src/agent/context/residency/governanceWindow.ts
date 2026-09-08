/** 治理预算以当前模型的可用输入容量为准，与最终发送门共享输出预留和安全余量。 */
import { isFiniteNumber } from '@velaros-ai/core'

import { resolveContextUsageWindow } from '../contextUsage'

import type { ContextGovernanceConfig } from './governanceConfig'

/** 兼容旧导出；可用窗口已经扣除安全余量，不再额外乘提前治理折扣。 */
export const GovernanceHeadroomRatio = 1

/** G 的地板：固定开销已经撑破送核门时的退化取值（治理器每轮必开）。 */
export const MinGovernanceWindowTokens = 1

export interface GovernanceWindowInput {
  /** 模型上下文窗口 W；缺席时按 `estimateContextUsage` 的同一默认值（128K）处理。 */
  modelWindowTokens?: LooseOptional<number>
  /** 输出预留；与送核门同参。 */
  reservedOutputTokens?: LooseOptional<number>
  /** 安全余量百分比；与送核门同参。 */
  safetyMarginPercent?: LooseOptional<number>
  /**
   * 固定开销（token）：系统提示词 + 工具清单/schema + 稳定前缀 + 活动尾。
   *
   * 缺席按 0 处理 —— 那等价于"只有账本正文要发出去"，是宿主没给开销信息时唯一诚实的假设，
   * 此时 G 仍然被门的红线约束住（headroom = sendGate），不会退回旧的 min(W, cap)。
   */
  fixedOverheadTokens?: LooseOptional<number>
}

export interface GovernanceWindowDerivation {
  /** 模型窗口 W（归一后）。 */
  contextWindow: number
  /** 送核门可用窗口：floor(W×(1−safety%)) − 输出预留。 */
  usableContextWindow: number
  /** 送核门红线（token）：估算达到此值即 `okToSend=false`。 */
  sendGateLimitTokens: number
  /** 账本正文之外、但门要算的固定开销（token）。 */
  fixedOverheadTokens: number
  /** 红线之下留给账本正文的额度（可能为负 = 开销本身已撑破门）。 */
  headroomTokens: number
  /** 治理窗口 G（token）——`epochTriggerPercent/epochTargetPercent` 的分母。 */
  windowTokens: number
  /** G 由谁定的：门余量 / cap 上限 / 地板（开销撑破门）。 */
  source: 'send-gate' | 'cap' | 'floor'
}

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
