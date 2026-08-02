import {
  type ConversationTranslator,
  conversationTranslatorRuntime,
} from '../i18n'

import { getPlanToolBlockExplanation, getPlanToolBlockSteps, type PlanToolStepPreview } from './plan/planToolBlock'
import { isCommandToolName } from './toolActivityPredicates'
import type { MergedToolCallGroup } from './toolCallRenderGrouping'
import { getToolDetailItems, normalizeInline } from './toolCallSummary'

import type { AppLocale, ToolCallBlock as ToolCallBlockType } from '#contracts'
import { isBlank, isEmpty,isNonBlankString, toNullable } from '#internal/runtime'
import { asRecord, readStringPreserveOuterWhitespace } from '#internal/unknownJsonRecord'

function getCurrentPlanDetailStep(steps: PlanToolStepPreview[]): Nullable<PlanToolStepPreview> {
  return (
    toNullable(steps.find((step) => ['delegated', 'running', 'in_progress'].includes(step.status)) ??
    steps.find((step) => step.status === 'pending') ??
    steps[steps.length - 1])
  )
}

function isProjectTargetDetail(detail: Nullable<string>): boolean {
  const normalized = detail ? normalizeInline(detail).toLowerCase() : ''

  if (!normalized) return false

  return (
    /^(写入|保存|输出|生成到).*(system|系统|session|会话).*(工区|工作区)$/.test(normalized) ||
    /^(write|save|output|export).*\b(system workspace|system work area)\b/.test(normalized)
  )
}

function getVisiblePlanObjective(step: PlanToolStepPreview): Nullable<string> {
  if (!step.objective || isProjectTargetDetail(step.objective)) return null

  return normalizeInline(step.objective) === normalizeInline(step.title) ? null : step.objective
}

function getPlanMergedDetail(block: ToolCallBlockType): Nullable<string> {
  const steps = getPlanToolBlockSteps(block)
  const currentStep = getCurrentPlanDetailStep(steps)
  const explanation = getPlanToolBlockExplanation(block)
  const visibleExplanation = isProjectTargetDetail(explanation) ? null : explanation

  if (!currentStep) return visibleExplanation

  const objective = getVisiblePlanObjective(currentStep)
  const detail = objective ?? visibleExplanation
  let mergedDetail = ''
  if (isNonBlankString(currentStep.title)) mergedDetail = currentStep.title
  if (isNonBlankString(detail)) {
    mergedDetail = mergedDetail ? `${mergedDetail} · ${detail}` : detail
  }

  return mergedDetail
}

export function getMergedToolDetails(
  blocks: ToolCallBlockType[],
  formatPathForDisplay?: (path: string) => string,
  locale?: AppLocale,
  translatorRuntime: ConversationTranslator = conversationTranslatorRuntime
): string[] {
  const seen = new Set<string>()
  const details: string[] = []

  for (const block of blocks) {
    if (block.toolName === 'plan:update') {
      const detail = getPlanMergedDetail(block)
      if (detail && !seen.has(detail)) {
        seen.add(detail)
        details.push(detail)
      }
      continue
    }

    const blockDetails = getToolDetailItems(
      block,
      formatPathForDisplay,
      locale,
      translatorRuntime
    )

    for (const detail of blockDetails) {
      if (!detail || seen.has(detail)) continue

      seen.add(detail)
      details.push(detail)
    }
  }

  return details
}

function getToolBlockCommand(block: ToolCallBlockType): Nullable<string> {
  const resultRecord = asRecord(block.result)
  const argsRecord = asRecord(block.args)
  return (
    readStringPreserveOuterWhitespace(resultRecord, 'command') ??
    readStringPreserveOuterWhitespace(argsRecord, 'command')
  )
}

export function getMergedCommandCopyValue(group: MergedToolCallGroup): Nullable<string> {
  if (!isCommandToolName(group.toolName)) return null

  const seen = new Set<string>()
  const commands: string[] = []

  for (const block of group.blocks) {
    const command = getToolBlockCommand(block)
    if (!command || isBlank(command.trim()) || seen.has(command)) continue

    seen.add(command)
    commands.push(command)
  }

  if (isEmpty(commands)) return null

  return commands.join('\n')
}

export function shouldRenderToolBlockCompact(toolName: string): boolean {
  return toolName !== 'apply_edits'
}
