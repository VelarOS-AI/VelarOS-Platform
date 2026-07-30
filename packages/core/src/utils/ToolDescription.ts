import { AppError } from '../error'
import { isNumber, isString } from '../typeGuards'
import type { ToolCategoryId } from '../types/tool'

import { isBlank } from './string'

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

const DescriptionSectionPrefix = '描述：'

function normalizeDescriptionText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/** 取分节标题（`适合：` → `适合`）；首行不是分节标题时返回空串。 */
function readSectionTitle(block: string): string {
  const firstLine = block.split('\n')[0] ?? ''
  return firstLine.endsWith('：') ? firstLine.slice(0, -1) : ''
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

/**
 * 结构化描述的语法（分节顺序 / 允许分节 / 必需分节）。
 *
 * 工具描述与参数描述用同一部语法、只换这三张表；此前两份校验各写一遍 28 行，
 * 语法改一处必漏另一处，故收成单一校验器 + 两张语法表。
 */
interface StructuredDescriptionGrammar {
  sectionOrder: ReadonlyMap<string, number>
  allowedSections: ReadonlyArray<ReadonlySet<string>>
  requiredSections: ReadonlySet<string>
}

const ToolDescriptionGrammar: StructuredDescriptionGrammar = {
  sectionOrder: StructuredToolDescriptionSectionOrder,
  allowedSections: [RequiredListSections, OptionalToolListSections],
  requiredSections: RequiredListSections,
}

const ParameterDescriptionGrammar: StructuredDescriptionGrammar = {
  sectionOrder: StructuredParameterDescriptionSectionOrder,
  allowedSections: [OptionalParameterListSections],
  requiredSections: new Set<string>(),
}

function isStructuredDescription(
  description: string,
  grammar: StructuredDescriptionGrammar
): boolean {
  const trimmed = description.trim()
  if (!trimmed.startsWith(DescriptionSectionPrefix)) return false

  const blocks = trimmed.split(/\n{2,}/)
  const descriptionText = blocks[0]?.slice(DescriptionSectionPrefix.length).trim() ?? ''
  if (descriptionText.length === 0) return false

  const seenSections = new Set<string>(['描述'])
  let previousOrder = grammar.sectionOrder.get('描述') ?? 0

  for (const block of blocks.slice(1)) {
    const section = readSectionTitle(block)
    const sectionOrder = grammar.sectionOrder.get(section)
    if (
      !isNumber(sectionOrder) ||
      !grammar.allowedSections.some((sections) => sections.has(section)) ||
      seenSections.has(section) ||
      sectionOrder < previousOrder ||
      !isStructuredListSection(block)
    ) return false

    seenSections.add(section)
    previousOrder = sectionOrder
  }

  for (const section of grammar.requiredSections) {
    if (!seenSections.has(section)) return false
  }

  return true
}

function isStructuredToolDescription(description: string): boolean {
  return isStructuredDescription(description, ToolDescriptionGrammar)
}

function isStructuredParameterDescription(description: string): boolean {
  return isStructuredDescription(description, ParameterDescriptionGrammar)
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
 * 渐进式披露的压缩内核：保留 `描述：` 段落与分节顺序，逐节只留首条要点。
 *
 * `keepInFullSection` 是**不许压缩的那一节**——它承载模型做对事所必需的硬信息
 * （工具的强制流程门禁、参数的合法取值枚举），压掉就等于删约束。
 * 结果仍是合法结构化描述（每个必需分节至少留一条），可继续过 `isStructured*` 校验。
 * 非结构化输入原样返回。
 */
function compactStructuredDescription(
  description: string,
  isStructured: (value: string) => boolean,
  keepInFullSection: string
): string {
  const trimmed = description.trim()
  if (!isStructured(trimmed)) return trimmed

  return trimmed
    .split(/\n{2,}/)
    .map((block, index) => {
      if (index === 0) return block

      const lines = block.split('\n')
      const title = lines[0] ?? ''
      if (title === keepInFullSection) return block

      const firstBullet = lines.slice(1).find((line) => line.startsWith('- '))
      return isString(firstBullet) ? `${title}\n${firstBullet}` : block
    })
    .join('\n\n')
}

/** 工具描述 tier-1 精简版：`强制流程：` 完整保留，其余分节各留首条。 */
function compactStructuredToolDescription(description: string): string {
  return compactStructuredDescription(description, isStructuredToolDescription, '强制流程：')
}

/** 参数描述 tier-1 精简版：`取值：` 完整保留，其余分节各留首条。 */
function compactStructuredParameterDescription(description: string): string {
  return compactStructuredDescription(description, isStructuredParameterDescription, '取值：')
}

function structureToolDescriptionsForCategory<
  TTool extends ToolDescriptionLike,
  TMap extends Record<string, TTool>,
>(tools: TMap, categoryId: ToolCategoryId): TMap {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const description = tool.description.trim()
      if (!isStructuredToolDescription(description)) {
        throw new AppError(
          'VALIDATION',
          `Tool ${categoryId}/${name} description is not fully structured`
        )
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
