import { isEmpty,isFiniteNumber } from '@velaros-ai/core'

import type { ContextWorkingSetBudgetLedgerEntry,ProviderRequestPressureKind } from '../../types/context.js'
import type { BuildPromptRunPlanInput,CapabilityEvidenceSnapshot, ContextRunPlan, PlanContextRunInput, PlanRecoveryRunInput, PromptRunPlan, RecoveryRunPlan, ToolPageFault } from '../../types/loop.js'
import { estimateBlockTokens } from '../context/context-ledger'
import { allocateContextWorkingSetBudget, resolveContextWorkingSetZoneCharBudget } from '../context/context-working-set-budget-governor'
import { RunProfileDefinitions } from '../runner/runtime-profiles'
import { AgentTuning } from '../tuning'

import {
  contextDegradeStaircaseLength,
  resolveContextDegradeAction,
} from './context-degrade-ladder'

/** 排一轮的上下文预算计划：定窗口、按分区分预算、算工具 schema 字符额度，并给出这轮的压力口径。 */
function planContextRun(input: PlanContextRunInput): ContextRunPlan {
  const contextWindow = input.contextWindow ?? AgentTuning.loop.unknownContextWindowTokens
  const zoneAllocation = allocateContextWorkingSetBudget({
    contextWindow,
    ledger: buildContextLedger(input),
  })
  const toolSchemaBudgetScale = resolveToolSchemaBudgetScale(input.toolSchemaBudgetScale)
  const baseToolSchemaCharBudget = resolveContextWorkingSetZoneCharBudget(
    zoneAllocation,
    'tool-schemas'
  )

  return {
    contextWindow,
    usableContextWindow: zoneAllocation.usableContextWindow,
    zoneAllocation,
    toolSchemaCharBudget: Math.floor(baseToolSchemaCharBudget * toolSchemaBudgetScale),
    toolSchemaBudgetScale,
    payloadPolicy: 'dedupe-and-reference',
    pressure: resolvePlanPressure(zoneAllocation),
  }
}

/** 把这轮的工具 schema 字符数折成一条分区账目；一个字符都没有就不记账。 */
function buildContextLedger(input: PlanContextRunInput): ContextWorkingSetBudgetLedgerEntry[] {
  const toolSchemaChars = sumPositive(Object.values(input.toolSchemaChars ?? {}))
  if (toolSchemaChars <= 0) return []

  return [
    {
      zone: 'tool-schemas',
      estimatedTokens: estimateBlockTokens(toolSchemaChars),
    },
  ]
}

/** 求和，负数按零计：单项字符数不该把总账拉低。 */
function sumPositive(values: Iterable<number>): number {
  let total = 0

  for (const value of values) {
    total += Math.max(0, value)
  }

  return total
}

/** 收敛外来的 schema 预算缩放系数：不是有限数当满额，其余钳在允许区间内。 */
function resolveToolSchemaBudgetScale(value: unknown): number {
  if (!isFiniteNumber(value)) return 1
  return Math.min(1, Math.max(0.25, value))
}

/** 按分区超支情况判这轮的压力来源：不超支是 none，只有工具 schema 超是 tool-schema，还有别处超是 mixed，其余是 tokens。 */
function resolvePlanPressure(
  allocation: ContextRunPlan['zoneAllocation']
): ProviderRequestPressureKind {
  if (allocation.totalOverBudgetTokens <= 0) return 'none'

  const toolSchemaOverBudget = allocation.zones['tool-schemas'].overBudgetTokens > 0
  if (
    toolSchemaOverBudget &&
    allocation.totalOverBudgetTokens > allocation.zones['tool-schemas'].overBudgetTokens
  ) return 'mixed'

  return toolSchemaOverBudget ? 'tool-schema' : 'tokens'
}

/** 排一轮的恢复计划：强制工具被无视怎么办、上下文溢出的降级梯子、缺能力与证据过期各走哪条路。 */
function planRecoveryRun(input: PlanRecoveryRunInput): RecoveryRunPlan {
  const forced = Boolean(input.forcedToolChoice)
  return {
    ignoredToolChoice: forced
      ? {
          enabled: true,
          maxRetries: 1,
          fallbackReminderId: 'tool-space-bootstrap-ignored-tool-choice',
        }
      : {
          enabled: false,
          maxRetries: 0,
        },
    contextOverflow: {
      ladder: Array.from({ length: contextDegradeStaircaseLength('solo') }, (_value, index) =>
        resolveContextDegradeAction('solo', index)
      ),
    },
    missingCapability: {
      action: resolveMissingCapabilityAction(input.pageFaults),
    },
    staleEvidence: {
      action: resolveStaleEvidenceAction(input),
    },
  }
}

/** 按第几次重试在降级梯子上取一档；越界就停在最后一档，梯子空了兜底成投降。 */
function resolveRecoveryContextOverflowAction(
  recovery: RecoveryRunPlan,
  attempt: number
): RecoveryRunPlan['contextOverflow']['ladder'][number] {
  const ladder = recovery.contextOverflow.ladder
  const index = Math.max(0, Math.floor(attempt))

  return ladder[index] ?? ladder[ladder.length - 1] ?? { kind: 'surrender', level: 1 }
}

/** 按这轮的缺页恢复提示定缺能力动作：有 stop 就停，要用户动作或授权就请用户，其余一律去重新发现。 */
function resolveMissingCapabilityAction(
  pageFaults: readonly ToolPageFault[] = []
): RecoveryRunPlan['missingCapability']['action'] {
  if (pageFaults.some((fault) => fault.recoveryHint === 'stop')) return 'stop'

  if (pageFaults.some((fault) => fault.recoveryHint === 'request-user-action')) return 'request-user-action'

  if (pageFaults.some((fault) => fault.recoveryHint === 'request-approval')) return 'request-user-action'

  if (pageFaults.some((fault) => fault.recoveryHint === 'page-out-other-tools')) return 'discover'

  return 'discover'
}

/** 判要不要刷新能力上下文：这轮不要求证据、或根本没有证据时不动作，只有已有证据过期才刷新。 */
function resolveStaleEvidenceAction(input: {
  requiresCapabilityEvidence?: boolean
  capabilityEvidenceSnapshot?: CapabilityEvidenceSnapshot
}): RecoveryRunPlan['staleEvidence']['action'] {
  if (!input.requiresCapabilityEvidence || !input.capabilityEvidenceSnapshot?.hasEvidence) return 'none'

  return input.capabilityEvidenceSnapshot.isStale ? 'refresh-capability-context' : 'none'
}

/** 排一轮的提示词计划：按运行档位定系统提示字符预算，并把这轮该插的内部提醒（引导、缺页、证据过期）排好。 */
function buildPromptRunPlan(input: BuildPromptRunPlanInput): PromptRunPlan {
  const runProfileDefinition = RunProfileDefinitions[input.runProfile]
  const maxSystemPromptChars = runProfileDefinition.budget.maxSystemPromptChars
  const internalReminders: PromptRunPlan['internalReminders'] = []
  if (input.bootstrapReminder) {
    internalReminders.push({
      id: 'tool-space-bootstrap-before-model',
      phase: 'before-model',
      reason: 'capability planner requires tool-space discovery',
      text: input.bootstrapReminder,
      dedupeKey: 'tool-space-bootstrap',
    })
  }

  const pageFaultReminder = buildCapabilityPageFaultReminder({
    pageFaults: input.pageFaults ?? [],
    recovery: input.recovery,
  })
  if (pageFaultReminder) {
    internalReminders.push({
      id: 'capability-page-fault-before-model',
      phase: 'before-model',
      reason: 'capability planner detected an unrecovered page fault',
      text: pageFaultReminder,
      dedupeKey: 'capability-page-fault',
    })
  }
  const staleEvidenceReminder = buildStaleEvidenceReminder(input.recovery)
  if (staleEvidenceReminder) {
    internalReminders.push({
      id: 'stale-capability-evidence-before-model',
      phase: 'before-model',
      reason: 'recovery planner detected stale capability evidence',
      text: staleEvidenceReminder,
      dedupeKey: 'stale-capability-evidence',
    })
  }

  const prompt: PromptRunPlan = {
    runProfile: input.runProfile,
    internalReminders,
  }

  if (isFiniteNumber(maxSystemPromptChars)) {
    prompt.promptBudget = {
      profile: input.runProfile,
      maxChars: maxSystemPromptChars,
    }
  }

  return prompt
}

/** 证据过期时给模型的一句提醒；恢复计划没要求刷新就不发。 */
function buildStaleEvidenceReminder(recovery?: RecoveryRunPlan): Nullable<string> {
  if (recovery?.staleEvidence.action !== 'refresh-capability-context') return null

  return '[system] Capability evidence is stale after later activity. Refresh the owning capability context before relying on earlier evidence.'
}

/** 把这轮的工具缺页连同恢复策略写成一句给模型的提醒；没有缺页或没有恢复计划就不发。 */
function buildCapabilityPageFaultReminder(input: {
  pageFaults: readonly ToolPageFault[]
  recovery?: RecoveryRunPlan
}): Nullable<string> {
  if (isEmpty(input.pageFaults) || !input.recovery) return null

  const faultText = input.pageFaults
    .map((fault) => {
      const categoryText = fault.categoryId ? `，category=${fault.categoryId}` : ''
      return `${fault.toolName}(${fault.reason}${categoryText}, recovery=${fault.recoveryHint})`
    })
    .join('；')
  const action = input.recovery.missingCapability.action
  const needsToolSpaceAdjustment = input.pageFaults.some(
    (fault) => fault.recoveryHint === 'page-out-other-tools'
  )
  const actionText =
    action === 'stop'
      ? '当前角色或工具边界无法恢复该缺页。不要用现有工具凑答案；直接说明无法继续，并指出需要调整角色允许工具或工具空间边界。'
      : action === 'request-user-action'
        ? '需要用户动作或授权后再继续。'
        : action === 'read-page'
          ? '先读取对应工具页确认依赖和 schema。'
          : needsToolSpaceAdjustment
            ? '先用 tooling:replace page-out 暂时不需要的工具腾出工具空间，再重新 page-in 或发现目标能力。'
            : '先重新发现或调整工具空间后再继续。'

  return `[系统] Capability page fault：${faultText}。恢复策略：${action}。${actionText}`
}

export {
  buildPromptRunPlan,
  planContextRun,
  planRecoveryRun,
  resolveRecoveryContextOverflowAction,
}
