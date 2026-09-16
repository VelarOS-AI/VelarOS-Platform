import { isEmpty } from '@velaros-ai/core'

import type { PromptBudgetOptions, PromptContribution } from '../../types/guidance.js'
import type { BuiltContext } from '../../types/runner.js'

export function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function wrapCdata(text: string): string {
  return `<![CDATA[\n${text.replaceAll(']]>', ']]]]><![CDATA[>')}\n]]>`
}

export function formatPromptSection(part: PromptContribution): string {
  const name = part.label?.trim() || part.id
  return [
    `  <section name="${escapeXmlAttribute(name)}">`,
    wrapCdata(part.text),
    '  </section>',
  ].join('\n')
}

export function formatPromptBlock(args: {
  name: 'instructions' | 'current_context'
  parts: PromptContribution[]
}): string {
  return [
    `<${args.name}>`,
    ...args.parts.map((part) => formatPromptSection(part)),
    `</${args.name}>`,
  ].join('\n')
}

export function buildStructuredSystemPrompt(args: {
  stableParts: PromptContribution[]
  dynamicParts: PromptContribution[]
}): { systemPrompt: string; stableCutoff: number } {
  // 提示词治理元数据属于 `BuiltContext.segments`，不交给模型；模型只收到描述性段落。
  // stable 与 current 两块各自是完整的 XML，供应商投递时把 current 块挪到历史之后也不会拆坏文档。
  const stablePrefix = formatPromptBlock({
    name: 'instructions',
    parts: args.stableParts,
  })

  if (isEmpty(args.dynamicParts)) return { systemPrompt: stablePrefix, stableCutoff: stablePrefix.length }

  return {
    systemPrompt: [
      stablePrefix,
      formatPromptBlock({
        name: 'current_context',
        parts: args.dynamicParts,
      }),
    ].join('\n'),
    stableCutoff: stablePrefix.length,
  }
}

export function canTrimPromptPart(part: PromptContribution): boolean {
  if (part.retention === 'protected') return false
  if (part.source === 'user') return false

  return part.priority >= 1_000
}

export function applyPromptBudget(args: {
  stableParts: PromptContribution[]
  dynamicParts: PromptContribution[]
  skipped: BuiltContext['skippedSegments']
  budget?: LooseOptional<PromptBudgetOptions>
}): {
  stableParts: PromptContribution[]
  dynamicParts: PromptContribution[]
  skipped: BuiltContext['skippedSegments']
  budgetTrace: BuiltContext['promptBudget']
} {
  if (!args.budget || args.budget.maxChars <= 0) return {
      stableParts: args.stableParts,
      dynamicParts: args.dynamicParts,
      skipped: args.skipped,
      budgetTrace: null,
    }

  const stableParts = [...args.stableParts]
  const dynamicParts = [...args.dynamicParts]
  const skipped = [...args.skipped]
  const initialPrompt = buildStructuredSystemPrompt({
    stableParts,
    dynamicParts,
  }).systemPrompt
  const charsBefore = initialPrompt.length
  let trimmedSegmentCount = 0

  while (
    buildStructuredSystemPrompt({
      stableParts,
      dynamicParts,
    }).systemPrompt.length >
    args.budget.maxChars
  ) {
    const candidates = [...stableParts, ...dynamicParts]
      .filter(canTrimPromptPart)
      .sort((left, right) => {
        if (left.priority !== right.priority) return right.priority - left.priority

        return right.text.length - left.text.length
      })
    const candidate = candidates[0]
    if (!candidate) {
      break
    }

    const stableIndex = stableParts.findIndex((part) => part.id === candidate.id)
    if (stableIndex >= 0) {
      stableParts.splice(stableIndex, 1)
    } else {
      const dynamicIndex = dynamicParts.findIndex((part) => part.id === candidate.id)
      if (dynamicIndex >= 0) {
        dynamicParts.splice(dynamicIndex, 1)
      }
    }

    trimmedSegmentCount += 1
    skipped.push({
      id: candidate.id,
      label: candidate.label,
      stability: candidate.stability,
      source: candidate.source,
      priority: candidate.priority,
      reason: `trimmed by run profile ${args.budget.profile} (max ${args.budget.maxChars} chars)`,
    })
  }

  const charsAfter = buildStructuredSystemPrompt({
    stableParts,
    dynamicParts,
  }).systemPrompt.length

  return {
    stableParts,
    dynamicParts,
    skipped,
    budgetTrace: {
      profile: args.budget.profile,
      maxChars: args.budget.maxChars,
      charsBefore,
      charsAfter,
      trimmedSegmentCount,
    },
  }
}
