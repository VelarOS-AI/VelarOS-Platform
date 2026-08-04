/**
 * Ring 1 stage ⑥——budget 钳制。
 *
 * 估算上下文用量 → 用注意力账目 + 去重账目拼 zone 账本 → ContextWorkingSetBudgetGovernor 分配 zone
 * 预算并标注 → 解析压力类型与 okToSend 门。okToSend=false 时由 compileWithReclaim 驱动回收阶梯
 * （stage ④）再压。压缩水位数学（`ContextUsageCompactionPercent` 等）住在 core/contextUsage，
 * 本 stage 一克不动。
 */
import type { ModelMessage } from 'ai'

import {
  ContextUsageCompactionPercent,
  type ContextUsageEstimate,
  estimateContextUsage,
} from '@velaros-ai/agent'

import {
  type ContextLedgerEntry,
  type ContextWorkingSetBlock,
  estimateBlockTokens,
} from '../../ContextLedger'
import {
  type ContextWorkingSetBudgetAllocation,
  ContextWorkingSetBudgetGovernor,
} from '../../ContextWorkingSetBudgetGovernor'
import type {
  CompileProviderRequestInput,
  ProviderRequestCompileDecision,
  ProviderRequestPressureKind,
  ProviderRequestZoneDiagnostic,
} from '../../ProviderRequestCompiler'
import { compareStableStrings } from '../../residency/determinism'
import { sumPositive } from '../messageScan'

/** 区分令牌压力与工具 schema 压力，混合两者为 mixed。 */
export function resolvePressureKind(
  estimate: ContextUsageEstimate,
  toolSchemaChars: number,
): ProviderRequestPressureKind {
  const toolSchemaTokens = toolSchemaChars > 0 ? estimateBlockTokens(toolSchemaChars) : 0
  const usableContextWindow = Math.max(1, estimate.usableContextWindow)
  const toolSchemaTokenPercent = (toolSchemaTokens / usableContextWindow) * 100
  const residualTokenPercent =
    (Math.max(0, estimate.estimatedTokens - toolSchemaTokens) / usableContextWindow) * 100
  const toolSchemaPressure =
    toolSchemaChars > 0 && toolSchemaTokenPercent >= ContextUsageCompactionPercent
  const tokenPressure =
    residualTokenPercent >= ContextUsageCompactionPercent ||
    (!toolSchemaPressure && estimate.tokenPercent >= ContextUsageCompactionPercent)
  const pressureCount = [tokenPressure, toolSchemaPressure].filter(Boolean).length

  if (pressureCount === 0) return 'none'

  if (pressureCount > 1) return 'mixed'

  if (toolSchemaPressure) return 'tool-schema'

  return 'tokens'
}

/** 只报超预算 zone，按超额/优先级/名称稳定排序，供诊断与回收阶梯决策。 */
export function buildZoneDiagnostics(
  allocation: ContextWorkingSetBudgetAllocation
): ProviderRequestZoneDiagnostic[] {
  return Object.values(allocation.zones)
    .filter((zone) => zone.overBudgetTokens > 0)
    .sort(
      (left, right) =>
        right.overBudgetTokens - left.overBudgetTokens ||
        right.priority - left.priority ||
        compareStableStrings(left.zone, right.zone)
    )
    .map((zone) => ({
      zone: zone.zone,
      usedTokens: zone.usedTokens,
      effectiveLimitTokens: zone.effectiveLimitTokens,
      overBudgetTokens: zone.overBudgetTokens,
      reclaimOrder: [...zone.reclaimOrder],
    }))
}

/** 估算 + 拼账本 + 分配预算 + 解析压力与 okToSend 门，产出请求的估算 / 账本 / 决策。 */
export function runBudgetStage(params: {
  input: CompileProviderRequestInput
  providerMessages: ModelMessage[]
  classifiedBlocks: readonly ContextWorkingSetBlock[]
}): {
  estimate: ContextUsageEstimate
  ledger: ContextLedgerEntry[]
  decision: ProviderRequestCompileDecision
} {
  const toolSchemaChars = sumPositive(Object.values(params.input.toolSchemaChars ?? {}))
  const estimateOptions = params.input.contextUsageOptions ?? {}
  const extraEstimatedChars = Math.max(
    0,
    Math.ceil(estimateOptions.extraEstimatedChars ?? toolSchemaChars),
  )
  const estimate = estimateContextUsage(
    params.input.model,
    params.input.systemPrompt,
    params.providerMessages,
    {
      ...estimateOptions,
      contextWindow: params.input.contextWindow ?? estimateOptions.contextWindow,
      extraEstimatedChars,
      extraEstimatedTokens: estimateOptions.extraEstimatedTokens ?? Math.ceil(extraEstimatedChars / 4),
      reservedOutputTokens: params.input.reservedOutputTokens ?? estimateOptions.reservedOutputTokens,
      safetyMarginPercent: params.input.safetyMarginPercent ?? estimateOptions.safetyMarginPercent,
      calibrationFactor: params.input.calibrationFactor ?? estimateOptions.calibrationFactor,
    }
  )
  // B1 起账目一律 inline：块正文已是**账本投影后**的最终形态，降级发生在治理 epoch 里、
  // 由迁移事件记账，不再由本 stage 二次标注（v1 的注意力账目与去重账目已随本批下线）。
  const ledger: ContextLedgerEntry[] = params.classifiedBlocks.map((block) => ({
    id: block.id,
    zone: block.zone,
    chars: block.chars,
    estimatedTokens: block.estimatedTokens,
    action: 'inline' as const,
    reason: 'compiler preserves provider payload block',
    hash: block.hash,
    ref: block.payloadRef,
  }))
  const budgetAllocation = ContextWorkingSetBudgetGovernor.allocate({
    contextWindow: estimate.contextWindow,
    usableContextWindow: estimate.usableContextWindow,
    reservedOutputTokens: estimate.reservedOutputTokens,
    ledger,
  })
  const annotatedLedger = ContextWorkingSetBudgetGovernor.annotateLedger(ledger, budgetAllocation)
  const pressureKind = resolvePressureKind(estimate, toolSchemaChars)
  const okToSend = estimate.percent < ContextUsageCompactionPercent

  return {
    estimate,
    ledger: annotatedLedger,
    decision: {
      okToSend,
      pressureKind,
      reason: okToSend
        ? 'compiled request is below send gate'
        : 'compiled request exceeds send gate',
      zoneDiagnostics: buildZoneDiagnostics(budgetAllocation),
    },
  }
}
