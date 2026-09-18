/**
 * 模型面说明的渲染、判定、解析与两道长度闸：工具说明七节、参数说明四节，渲染与判定共用 `description-syntax.ts` 的同一部语法，
 * 顺序、必填节与「没给就不渲染」都是语法的一部分。两道闸只在说明被写下来的那一刻拦（定义工具时），
 * 因为模型面说明从不压缩——`适合`、`禁止` 是行为约束，压掉等于删规则。
 */

import { isBlank } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  StructuredParameterDescriptionSpec,
  StructuredToolDescriptionParts,
  StructuredToolDescriptionSpec,
  ToolDescriptionBudgetWaiver,
  ToolDescriptionBudgetWaiverReason,
} from '../../types/toolkit.js'
import { AgentTuning } from '../tuning'

import {
  DescriptionSectionPrefix,
  isStructuredDescription,
  normalizeDescriptionText,
  ParameterDescriptionGrammar,
  parseListSectionItems,
  renderListSection,
  ToolDescriptionGrammar,
} from './description-syntax'

/** 软预算豁免只认这两种理由；加第三种之前先改判决。 */
const ToolDescriptionBudgetWaiverReasons: ReadonlySet<string> = new Set<ToolDescriptionBudgetWaiverReason>([
  'safety-protocol',
  'meta-tool',
])

/** 按七节语法渲染一段工具说明：描述压成单行，没给的分节整节不出现。 */
export function renderToolDescription(spec: StructuredToolDescriptionSpec): string {
  const description = normalizeDescriptionText(spec.description)
  const sections = [
    `${DescriptionSectionPrefix}${description}`,
    renderListSection('适合', spec.suitable),
    spec.forbidden ? renderListSection('禁止', spec.forbidden) : null,
    spec.protocol ? renderListSection('强制流程', spec.protocol) : null,
    spec.usage ? renderListSection('用法', spec.usage) : null,
    spec.examples ? renderListSection('示例', spec.examples) : null,
    spec.notes ? renderListSection('注意', spec.notes) : null,
  ].filter((section): section is string => Boolean(section))

  return sections.join('\n\n')
}

/**
 * 按四节语法渲染**单个参数**的说明：`描述` → `取值` → `用法` → `注意`，只有描述必填、没给的节不出现。
 * 参数的合法取值与边界必须写进「取值」——入参 schema 经 transform 之后 JSON Schema 里不再带
 * minimum/maximum，模型只能从这里看到边界。
 */
export function renderParameterDescription(spec: StructuredParameterDescriptionSpec): string {
  const description = normalizeDescriptionText(spec.description)
  const sections = [
    `${DescriptionSectionPrefix}${description}`,
    spec.values ? renderListSection('取值', spec.values) : null,
    spec.usage ? renderListSection('用法', spec.usage) : null,
    spec.notes ? renderListSection('注意', spec.notes) : null,
  ].filter((section): section is string => Boolean(section))

  return sections.join('\n\n')
}

/** 声明了 companion skill 时追加到说明末尾的那一行指路（进「注意」分节的最后一条）。 */
export function renderUsageSkillNote(usageSkillId: string): string {
  return `深度用法：当前技能目录可读取 skill:${usageSkillId} 时先读该技能。`
}

/** 这段工具说明是不是完全结构化的（七节语法，`适合` 必填）。 */
export function isStructuredToolDescription(description: string): boolean {
  return isStructuredDescription(description, ToolDescriptionGrammar)
}

/** 这段参数说明是不是完全结构化的（四节语法，没有必填分节）。 */
export function isStructuredParameterDescription(description: string): boolean {
  return isStructuredDescription(description, ParameterDescriptionGrammar)
}

/** 把一段已渲染的工具说明解析回七个分节；不是合法结构化说明时返回 null。 */
export function parseStructuredToolDescription(description: string): Nullable<StructuredToolDescriptionParts> {
  const trimmed = description.trim()
  if (!isStructuredToolDescription(trimmed)) return null

  const parts: StructuredToolDescriptionParts = {
    description: '',
    suitable: [],
    forbidden: [],
    protocol: [],
    usage: [],
    examples: [],
    notes: [],
  }

  const blocks = trimmed.split(/\n{2,}/)
  parts.description = blocks[0]?.slice(DescriptionSectionPrefix.length).trim() ?? ''

  for (const block of blocks.slice(1)) {
    const firstLine = block.split('\n')[0] ?? ''
    switch (firstLine) {
      case '适合：':
        parts.suitable = parseListSectionItems(block)
        break
      case '禁止：':
        parts.forbidden = parseListSectionItems(block)
        break
      case '强制流程：':
        parts.protocol = parseListSectionItems(block)
        break
      case '用法：':
        parts.usage = parseListSectionItems(block)
        break
      case '示例：':
        parts.examples = parseListSectionItems(block)
        break
      case '注意：':
        parts.notes = parseListSectionItems(block)
        break
      default:
        break
    }
  }

  return parts
}

/** 产出模型面的工具说明文本，幂等：已是合法结构化说明就 trim 后原样返回，否则按七节语法渲染。 */
export function structureToolDescriptionForModel(spec: StructuredToolDescriptionSpec): string {
  const trimmed = spec.description.trim()
  if (isStructuredToolDescription(trimmed)) return trimmed

  return renderToolDescription({ ...spec, description: trimmed })
}

/** 硬上限闸：说明超过 `AgentTuning.toolkit.descriptionMaxChars` 就抛 VALIDATION，不可豁免；撞线基本等于这个工具该拆。 */
export function assertToolDescriptionWithinLimit(name: string, description: string): void {
  const maxChars = AgentTuning.toolkit.descriptionMaxChars
  if (description.length <= maxChars) return

  throw new AppError(
    'VALIDATION',
    `工具 ${name} 的描述有 ${description.length} 字符，超过 ${maxChars} 字符的硬上限；这基本等于这个工具该拆了，请拆分工具，或把细节移出模型面描述（挪进 tooling:read 的按需正文）。`
  )
}

/** 软预算闸：说明超过 `AgentTuning.toolkit.descriptionBudgetChars` 就抛 VALIDATION；带合法豁免（理由认可且 note 非空白）时跳过长度判定。 */
export function assertToolDescriptionWithinBudget(
  name: string,
  description: string,
  waiver?: ToolDescriptionBudgetWaiver
): void {
  if (waiver) {
    if (!ToolDescriptionBudgetWaiverReasons.has(waiver.reason)) {
      throw new AppError(
        'VALIDATION',
        `工具 ${name} 的描述预算豁免理由 "${waiver.reason}" 不被认可；只接受 safety-protocol / meta-tool 两种。`
      )
    }

    if (isBlank(waiver.note)) {
      throw new AppError(
        'VALIDATION',
        `工具 ${name} 的描述预算豁免必须带上 note，写清它凭什么算 ${waiver.reason} 这一类；note 空白的豁免不予放行。`
      )
    }

    return
  }

  const budgetChars = AgentTuning.toolkit.descriptionBudgetChars
  if (description.length <= budgetChars) return

  throw new AppError(
    'VALIDATION',
    `工具 ${name} 的描述有 ${description.length} 字符，超过 ${budgetChars} 字符的软预算；出路只有两条：把工艺细节搬进配套技能（在契约里声明 usageSkillId 指路），或声明 descriptionBudgetWaiver 并给出 safety-protocol / meta-tool 之一的理由。不要靠压缩描述过关。`
  )
}
