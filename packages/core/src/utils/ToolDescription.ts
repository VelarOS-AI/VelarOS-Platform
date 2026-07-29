import { isNumber, isString } from '../typeGuards'
import type { ToolCategoryId } from '../types/tool'

import { isBlank } from './string.js'

type NonEmptyDescriptionItems = readonly [string, ...string[]]

interface StructuredToolDescriptionSpec {
  description: string
  suitable: NonEmptyDescriptionItems
  forbidden: NonEmptyDescriptionItems
  protocol?: NonEmptyDescriptionItems
  usage: NonEmptyDescriptionItems
  examples: NonEmptyDescriptionItems
  notes: NonEmptyDescriptionItems
}

interface StructuredToolDescriptionParts {
  description: string
  suitable: string[]
  forbidden: string[]
  protocol: string[]
  usage: string[]
  examples: string[]
  notes: string[]
}

interface StructuredParameterDescriptionSpec {
  description: string
  values?: NonEmptyDescriptionItems
  usage?: NonEmptyDescriptionItems
  notes?: NonEmptyDescriptionItems
}

interface ToolDescriptionLike {
  description: string
}

const StructuredToolDescriptionSections = [
  '描述',
  '适合',
  '禁止',
  '强制流程',
  '用法',
  '示例',
  '注意',
] as const

const StructuredToolDescriptionSectionOrder: ReadonlyMap<string, number> = new Map(
  StructuredToolDescriptionSections.map((section, index) => [section, index])
)

const RequiredListSections: ReadonlySet<string> = new Set([
  '适合',
  '禁止',
  '用法',
  '示例',
  '注意',
])

const OptionalToolListSections: ReadonlySet<string> = new Set(['强制流程'])

const StructuredParameterDescriptionSections = ['描述', '取值', '用法', '注意'] as const

const StructuredParameterDescriptionSectionOrder: ReadonlyMap<string, number> = new Map(
  StructuredParameterDescriptionSections.map((section, index) => [section, index])
)

const OptionalParameterListSections: ReadonlySet<string> = new Set(['取值', '用法', '注意'])

function normalizeDescriptionText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function normalizeListItems(items: readonly string[]): string[] {
  return items.map((item) => item.trim()).filter((item) => item.length > 0)
}

function renderListSection(title: string, items: readonly string[]): string {
  const normalizedItems = normalizeListItems(items)

  return `${title}：\n${normalizedItems.map((item) => `- ${item}`).join('\n')}`
}

function renderToolDescription(spec: StructuredToolDescriptionSpec): string {
  const description = normalizeDescriptionText(spec.description)
  const sections = [
    `描述：${description}`,
    renderListSection('适合', spec.suitable),
    renderListSection('禁止', spec.forbidden),
    spec.protocol ? renderListSection('强制流程', spec.protocol) : null,
    renderListSection('用法', spec.usage),
    renderListSection('示例', spec.examples),
    renderListSection('注意', spec.notes),
  ].filter((section): section is string => Boolean(section))

  return sections.join('\n\n')
}

function renderParameterDescription(spec: StructuredParameterDescriptionSpec): string {
  const description = normalizeDescriptionText(spec.description)
  const sections = [
    `描述：${description}`,
    spec.values ? renderListSection('取值', spec.values) : null,
    spec.usage ? renderListSection('用法', spec.usage) : null,
    spec.notes ? renderListSection('注意', spec.notes) : null,
  ].filter((section): section is string => Boolean(section))

  return sections.join('\n\n')
}

function isStructuredListSection(block: string): boolean {
  const lines = block.split('\n')
  if (lines.length < 2) return false

  return lines.slice(1).every((line) => line.startsWith('- ') && !isBlank(line.slice(2).trim()))
}

function isStructuredToolDescription(description: string): boolean {
  const trimmed = description.trim()
  if (!trimmed.startsWith('描述：')) return false

  const blocks = trimmed.split(/\n{2,}/)
  const descriptionText = blocks[0]?.slice('描述：'.length).trim() ?? ''
  if (descriptionText.length === 0) return false

  const seenSections = new Set<string>(['描述'])
  let previousOrder = StructuredToolDescriptionSectionOrder.get('描述') ?? 0

  for (const block of blocks.slice(1)) {
    const firstLine = block.split('\n')[0] ?? ''
    const section = firstLine.endsWith('：') ? firstLine.slice(0, -1) : ''
    const sectionOrder = StructuredToolDescriptionSectionOrder.get(section)
    if (
      !isNumber(sectionOrder) ||
      (!RequiredListSections.has(section) && !OptionalToolListSections.has(section)) ||
      seenSections.has(section) ||
      sectionOrder < previousOrder ||
      !isStructuredListSection(block)
    ) return false

    seenSections.add(section)
    previousOrder = sectionOrder
  }

  for (const section of StructuredToolDescriptionSections) {
    if (!OptionalToolListSections.has(section) && !seenSections.has(section)) return false
  }

  return true
}

function isStructuredParameterDescription(description: string): boolean {
  const trimmed = description.trim()
  if (!trimmed.startsWith('描述：')) return false

  const blocks = trimmed.split(/\n{2,}/)
  const descriptionText = blocks[0]?.slice('描述：'.length).trim() ?? ''
  if (descriptionText.length === 0) return false

  const seenSections = new Set<string>(['描述'])
  let previousOrder = StructuredParameterDescriptionSectionOrder.get('描述') ?? 0

  for (const block of blocks.slice(1)) {
    const firstLine = block.split('\n')[0] ?? ''
    const section = firstLine.endsWith('：') ? firstLine.slice(0, -1) : ''
    const sectionOrder = StructuredParameterDescriptionSectionOrder.get(section)
    if (
      !isNumber(sectionOrder) ||
      !OptionalParameterListSections.has(section) ||
      seenSections.has(section) ||
      sectionOrder < previousOrder ||
      !isStructuredListSection(block)
    ) return false

    seenSections.add(section)
    previousOrder = sectionOrder
  }

  return true
}

function parseListSectionItems(block: string): string[] {
  return block
    .split('\n')
    .slice(1)
    .map((line) => (line.startsWith('- ') ? line.slice(2).trim() : ''))
    .filter((item) => item.length > 0)
}

function parseStructuredToolDescription(
  description: string
): Nullable<StructuredToolDescriptionParts> {
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
  parts.description = blocks[0]?.slice('描述：'.length).trim() ?? ''

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

function structureToolDescriptionForModel(
  input: StructuredToolDescriptionSpec & { categoryId: ToolCategoryId }
): string {
  const trimmed = input.description.trim()
  if (isStructuredToolDescription(trimmed)) return trimmed

  return renderToolDescription({
    description: trimmed,
    suitable: input.suitable,
    forbidden: input.forbidden,
    usage: input.usage,
    examples: input.examples,
    protocol: input.protocol,
    notes: input.notes,
  })
}

/**
 * 工具描述详细程度（渐进式披露 / progressive disclosure）。
 * - full：保留作者写下的全部条目。
 * - compact：保留结构与每个分节的首条要点，作为 tier-1 精简描述，降低 token 成本。
 */
type ToolDescriptionDetail = 'full' | 'compact'

/**
 * 把一段“完整结构化工具描述”压缩成 tier-1 精简版：
 * - 保留 `描述：` 段落与分节顺序；
 * - 保留 `强制流程：`（这是被刻意强制的执行门禁，必须完整保留）；
 * - 其余建议性分节（适合/禁止/用法/示例/注意）只保留第一条要点。
 *
 * 结果仍是合法的结构化描述（每个必需分节至少保留一条），因此可继续通过
 * `isStructuredToolDescription` 校验与各宿主的分类整理流程。非结构化输入原样返回。
 */
function compactStructuredToolDescription(description: string): string {
  const trimmed = description.trim()
  if (!isStructuredToolDescription(trimmed)) return trimmed

  const blocks = trimmed.split(/\n{2,}/)
  return blocks
    .map((block, index) => {
      if (index === 0) return block
      const lines = block.split('\n')
      const title = lines[0] ?? ''
      if (title === '强制流程：') return block
      const firstBullet = lines.slice(1).find((line) => line.startsWith('- '))
      return isString(firstBullet) ? `${title}\n${firstBullet}` : block
    })
    .join('\n\n')
}

/**
 * 把一段“完整结构化参数描述”压缩成 tier-1 精简版：
 * - 保留 `描述：` 段落与分节顺序；
 * - 保留 `取值：`（枚举/合法取值说明是模型选对入参的依据，必须完整保留）；
 * - 其余建议性分节（用法/注意）只保留第一条要点。
 *
 * 结果仍是合法的结构化参数描述，可继续通过 `isStructuredParameterDescription`。
 * 非结构化输入原样返回。
 */
function compactStructuredParameterDescription(description: string): string {
  const trimmed = description.trim()
  if (!isStructuredParameterDescription(trimmed)) return trimmed

  const blocks = trimmed.split(/\n{2,}/)
  return blocks
    .map((block, index) => {
      if (index === 0) return block
      const lines = block.split('\n')
      const title = lines[0] ?? ''
      if (title === '取值：') return block
      const firstBullet = lines.slice(1).find((line) => line.startsWith('- '))
      return isString(firstBullet) ? `${title}\n${firstBullet}` : block
    })
    .join('\n\n')
}

function structureToolDescriptionsForCategory<
  TTool extends ToolDescriptionLike,
  TMap extends Record<string, TTool>,
>(tools: TMap, categoryId: ToolCategoryId): TMap {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const description = tool.description.trim()
      if (!isStructuredToolDescription(description)) {
        throw new Error(`Tool ${categoryId}/${name} description is not fully structured`)
      }

      return [
        name,
        {
          ...tool,
          description,
        },
      ]
    })
  ) as TMap
}

export {
  compactStructuredParameterDescription,
  compactStructuredToolDescription,
  isStructuredParameterDescription,
  isStructuredToolDescription,
  parseStructuredToolDescription,
  renderParameterDescription,
  renderToolDescription,
  structureToolDescriptionForModel,
  structureToolDescriptionsForCategory,
}
export type {
  StructuredParameterDescriptionSpec,
  StructuredToolDescriptionParts,
  StructuredToolDescriptionSpec,
  ToolDescriptionDetail,
}
