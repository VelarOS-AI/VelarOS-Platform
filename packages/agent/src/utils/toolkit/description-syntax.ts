/**
 * 结构化说明的语法本身：分节名单与顺序、渲染一节、判定一块、按语法判定整段、解析回条目。
 * 工具说明与参数说明共用这一套，只换语法表；渲染整段、判定、解析与两道长度闸在同目录的 `tool-description.ts`。
 */

import { isBlank, isNumber } from '@velaros-ai/core'

import type { StructuredDescriptionGrammar } from '../../types/toolkit.js'

/** 工具说明的七个分节，顺序就是渲染顺序。 */
export const StructuredToolDescriptionSections = [
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

/** 只有「适合」必须有；其余分节按需写，没参数的工具不用硬凑用法和示例。 */
const RequiredListSections: ReadonlySet<string> = new Set(['适合'])

const OptionalToolListSections: ReadonlySet<string> = new Set(['禁止', '强制流程', '用法', '示例', '注意'])

/** 参数说明的四个分节，顺序就是渲染顺序。 */
export const StructuredParameterDescriptionSections = ['描述', '取值', '用法', '注意'] as const

const StructuredParameterDescriptionSectionOrder: ReadonlyMap<string, number> = new Map(
  StructuredParameterDescriptionSections.map((section, index) => [section, index])
)

const OptionalParameterListSections: ReadonlySet<string> = new Set(['取值', '用法', '注意'])

/** 每段结构化说明都以它开头；分节语法靠这个前缀认出第一块。 */
export const DescriptionSectionPrefix = '描述：'

/** 工具说明的语法：七节、`适合` 必填。 */
export const ToolDescriptionGrammar: StructuredDescriptionGrammar = {
  sectionOrder: StructuredToolDescriptionSectionOrder,
  allowedSections: [RequiredListSections, OptionalToolListSections],
  requiredSections: RequiredListSections,
}

/** 参数说明的语法：四节、没有必填分节。 */
export const ParameterDescriptionGrammar: StructuredDescriptionGrammar = {
  sectionOrder: StructuredParameterDescriptionSectionOrder,
  allowedSections: [OptionalParameterListSections],
  requiredSections: new Set<string>(),
}

/**
 * 把一段描述正文压成单行：trim 后所有连续空白（含换行、制表）折成一个半角空格。
 * `描述：` 那段必须是单行——分节语法靠空行切块，正文里留换行会把自己劈成两个块而判非结构化。
 */
export function normalizeDescriptionText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/** 取分节标题（`适合：` → `适合`）；首行不是分节标题时返回空串。 */
export function readSectionTitle(block: string): string {
  const firstLine = block.split('\n')[0] ?? ''
  return firstLine.endsWith('：') ? firstLine.slice(0, -1) : ''
}

/** 归一分节条目：逐条 trim，丢掉 trim 后为空的条目（空条目会渲染成一个光秃秃的 `- `，判非结构化）。 */
export function normalizeListItems(items: readonly string[]): string[] {
  return items.map((item) => item.trim()).filter((item) => item.length > 0)
}

/**
 * 渲染一个列表分节：首行 `<标题>：`，其后每条一行 `- <条目>`（条目先经 `normalizeListItems` 归一）。
 * 标题不带冒号传入，冒号由本函数补。条目全为空时只剩一个光标题行，那样的块会被 `isStructuredListSection`
 * 判非法——所以调用方要么给非空条目，要么整节不渲染。
 */
export function renderListSection(title: string, items: readonly string[]): string {
  const normalizedItems = normalizeListItems(items)

  return `${title}：\n${normalizedItems.map((item) => `- ${item}`).join('\n')}`
}

/**
 * 判断一个分节块是否是合法列表节：至少两行（标题行 + 至少一条），且标题之后**每一行**都以 `- ` 开头、
 * 去掉 `- ` 后非空白。有一行不合规整块就判假——只有标题的空节、混进正文的散行都不算。
 */
export function isStructuredListSection(block: string): boolean {
  const lines = block.split('\n')
  if (lines.length < 2) return false

  return lines.slice(1).every((line) => line.startsWith('- ') && !isBlank(line.slice(2).trim()))
}

/**
 * 按给定语法判定一段描述是否完全结构化。判据逐条为：必须以 `描述：` 开头且其正文非空；
 * 按空行切块后，其余每块的标题必须是该语法认得的分节、在允许集合里、**不重复出现**、
 * 出场顺序不得早于前一节（严格递增，可跳节但不可回头），且块本身是合法列表节；
 * 最后该语法的必填分节（工具语法是 `适合`，参数语法没有必填）必须都出现过。
 * 任一条不满足即为假——不做部分接受，因为下游的压缩、解析都假定这套语法成立。
 */
export function isStructuredDescription(
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

/**
 * 从一个分节块里取回条目：跳过标题行，其余行剥掉 `- ` 前缀并 trim，不以 `- ` 开头的行与空条目一律丢弃。
 * 是 `renderListSection` 的逆操作，只在块已判为合法列表节后调用。
 */
export function parseListSectionItems(block: string): string[] {
  return block
    .split('\n')
    .slice(1)
    .map((line) => (line.startsWith('- ') ? line.slice(2).trim() : ''))
    .filter((item) => item.length > 0)
}
