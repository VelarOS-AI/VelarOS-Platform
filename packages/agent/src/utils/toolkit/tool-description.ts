import { isBlank, isNumber, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ToolCategoryId } from '../../types/agent.js'
import type { StructuredDescriptionGrammar,StructuredParameterDescriptionSpec, StructuredToolDescriptionParts, StructuredToolDescriptionSpec, ToolDescriptionBudgetWaiver, ToolDescriptionBudgetWaiverReason, ToolDescriptionLike } from '../../types/toolkit.js'


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

/** 只有「适合」必须有；其余分节按需写，没参数的工具不用硬凑用法和示例。 */
const RequiredListSections: ReadonlySet<string> = new Set(['适合'])

const OptionalToolListSections: ReadonlySet<string> = new Set(['禁止', '强制流程', '用法', '示例', '注意'])

const StructuredParameterDescriptionSections = ['描述', '取值', '用法', '注意'] as const

const StructuredParameterDescriptionSectionOrder: ReadonlyMap<string, number> = new Map(
  StructuredParameterDescriptionSections.map((section, index) => [section, index])
)

const OptionalParameterListSections: ReadonlySet<string> = new Set(['取值', '用法', '注意'])

const DescriptionSectionPrefix = '描述：'

/**
 * 单个工具描述的开发期硬上限（字符）。
 *
 * 这是**保底闸，不是预算**：模型面描述永不压缩——`适合：` / `禁止：` 是行为约束，
 * 压掉等于删规则，而全部工具描述加起来也只占长上下文很小一块（现网全量 ≈5.2 万字符）。
 * 因此唯一的防线是写的时候别写爆：单一职责工具正常够不到这个量级
 * （现网 p50≈330、p90≈750、最大 ≈4k），撞线基本等于「这个工具该拆」，
 * 或该把细节挪进 `tooling:read` 的按需正文。
 */
const ToolDescriptionMaxChars = 6_000

/**
 * 保底闸：单个工具描述超过 `ToolDescriptionMaxChars`（6000 字符）就抛 `VALIDATION` AppError，
 * 文案点名工具、实际字数与上限，并指出出路是拆工具或把细节挪出模型面描述。
 * 这道闸**不可豁免**（软预算那道才可以），因为撞到 6000 基本等于这个工具该拆。
 */
function assertToolDescriptionWithinLimit(name: string, description: string): void {
  if (description.length <= ToolDescriptionMaxChars) return

  throw new AppError(
    'VALIDATION',
    `工具 ${name} 的描述有 ${description.length} 字符，超过 ${ToolDescriptionMaxChars} 字符的硬上限；这基本等于这个工具该拆了，请拆分工具，或把细节移出模型面描述（挪进 tooling:read 的按需正文）。`
  )
}

/**
 * 模型面工具描述的软预算（字符）。
 *
 * 与 6000 硬上限的分工：硬上限是「写爆了」的保底闸；软预算是「工具是调用面、技能是用法面」
 * 这条判决的机械落点。复杂用法（多步协议、示例库、边角案例）模型会当作没看见或绕开，它属于
 * 行为层 Tier-2，家在技能文书，不在每轮都随工具清单进上下文的描述里。
 *
 * 超预算只有两条合法出路，**没有第三条**（尤其没有「压缩描述」——`适合`/`禁止` 是行为约束，
 * 逐节压缩等于删规则）：
 *  1. 拆 companion skill：工艺深度搬进技能，契约声明 `usageSkillId` 指路，描述瘦身到调用面；
 *  2. 显式豁免 `descriptionBudgetWaiver`，理由只认 `safety-protocol` / `meta-tool` 两种。
 */
const ToolDescriptionBudgetChars = 1_800

const ToolDescriptionBudgetWaiverReasons: ReadonlySet<string> = new Set<
  ToolDescriptionBudgetWaiverReason
>(['safety-protocol', 'meta-tool'])

/**
 * 软预算闸：描述超过 `ToolDescriptionBudgetChars`（1800 字符）就抛 `VALIDATION`，
 * 出路只有两条——拆 companion skill（契约里声明 `usageSkillId` 指路），或声明豁免。
 * 传了 `waiver` 就**跳过长度判定**，但豁免本身要过两关：reason 必须是
 * `safety-protocol` / `meta-tool` 之一，且 `note` 不能空白（得写清凭什么算这一类）；
 * 任一不满足照样抛错。注意豁免是先判先返回的，所以一份合法豁免可以放行任意长度（仍受 6000 硬闸约束）。
 */
function assertToolDescriptionWithinBudget(
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

  if (description.length <= ToolDescriptionBudgetChars) return

  throw new AppError(
    'VALIDATION',
    `工具 ${name} 的描述有 ${description.length} 字符，超过 ${ToolDescriptionBudgetChars} 字符的软预算；出路只有两条：把工艺细节搬进配套技能（在契约里声明 usageSkillId 指路），或声明 descriptionBudgetWaiver 并给出 safety-protocol / meta-tool 之一的理由。不要靠压缩描述过关。`
  )
}

/** 声明了 companion skill 时追加到描述末尾的指路行（`注意` 分节的最后一条）。 */
function renderUsageSkillNote(usageSkillId: string): string {
  return `深度用法：当前技能目录可读取 skill:${usageSkillId} 时先读该技能。`
}

/**
 * 把一段描述正文压成单行：trim 后所有连续空白（含换行、制表）折成一个半角空格。
 * `描述：` 那段必须是单行——分节语法靠空行切块，正文里留换行会把自己劈成两个块而判非结构化。
 */
function normalizeDescriptionText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/** 取分节标题（`适合：` → `适合`）；首行不是分节标题时返回空串。 */
function readSectionTitle(block: string): string {
  const firstLine = block.split('\n')[0] ?? ''
  return firstLine.endsWith('：') ? firstLine.slice(0, -1) : ''
}

/** 归一分节条目：逐条 trim，丢掉 trim 后为空的条目（空条目会渲染成一个光秃秃的 `- `，判非结构化）。 */
function normalizeListItems(items: readonly string[]): string[] {
  return items.map((item) => item.trim()).filter((item) => item.length > 0)
}

/**
 * 渲染一个列表分节：首行 `<标题>：`，其后每条一行 `- <条目>`（条目先经 `normalizeListItems` 归一）。
 * 标题不带冒号传入，冒号由本函数补。条目全为空时只剩一个光标题行，那样的块会被 `isStructuredListSection`
 * 判非法——所以调用方要么给非空条目，要么整节不渲染。
 */
function renderListSection(title: string, items: readonly string[]): string {
  const normalizedItems = normalizeListItems(items)

  return `${title}：\n${normalizedItems.map((item) => `- ${item}`).join('\n')}`
}

/**
 * 把结构化描述规格渲染成模型看到的那段文本：固定顺序
 * `描述` → `适合` → `禁止` → `强制流程` → `用法` → `示例` → `注意`，分节之间空一行。
 * `描述`（压成单行）与 `适合` 恒在，其余分节规格里没给就整节不出现——顺序与「没给就不渲染」
 * 是语法的一部分，乱序或空节都会让 `isStructuredToolDescription` 判假。
 */
function renderToolDescription(spec: StructuredToolDescriptionSpec): string {
  const description = normalizeDescriptionText(spec.description)
  const sections = [
    `描述：${description}`,
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
 * 渲染**单个参数**的结构化描述，语法比工具描述窄：只有 `描述` → `取值` → `用法` → `注意` 四节，
 * 且只有 `描述` 必填、其余没给就不出现。参数描述是 zod `.describe()` 的内容，transform 之后
 * JSON Schema 里不再带 minimum/maximum，边界值只能写进 `取值` 让模型看见。
 */
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

/**
 * 判断一个分节块是否是合法列表节：至少两行（标题行 + 至少一条），且标题之后**每一行**都以 `- ` 开头、
 * 去掉 `- ` 后非空白。有一行不合规整块就判假——只有标题的空节、混进正文的散行都不算。
 */
function isStructuredListSection(block: string): boolean {
  const lines = block.split('\n')
  if (lines.length < 2) return false

  return lines.slice(1).every((line) => line.startsWith('- ') && !isBlank(line.slice(2).trim()))
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

/**
 * 按给定语法判定一段描述是否完全结构化。判据逐条为：必须以 `描述：` 开头且其正文非空；
 * 按空行切块后，其余每块的标题必须是该语法认得的分节、在允许集合里、**不重复出现**、
 * 出场顺序不得早于前一节（严格递增，可跳节但不可回头），且块本身是合法列表节；
 * 最后该语法的必填分节（工具语法是 `适合`，参数语法没有必填）必须都出现过。
 * 任一条不满足即为假——不做部分接受，因为下游的压缩、解析都假定这套语法成立。
 */
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

/**
 * 判定一段**工具**描述是否结构化：七节语法（描述/适合/禁止/强制流程/用法/示例/注意），
 * 其中 `适合` 必填。注册期断言与 `structureToolDescriptionForModel` 的「已结构化就原样返回」都看它。
 */
function isStructuredToolDescription(description: string): boolean {
  return isStructuredDescription(description, ToolDescriptionGrammar)
}

/**
 * 判定一段**参数**描述是否结构化：四节语法（描述/取值/用法/注意），没有必填分节，
 * 所以只有 `描述：xxx` 一段也算结构化。用来避免对已结构化的参数描述再包一层。
 */
function isStructuredParameterDescription(description: string): boolean {
  return isStructuredDescription(description, ParameterDescriptionGrammar)
}

/**
 * 从一个分节块里取回条目：跳过标题行，其余行剥掉 `- ` 前缀并 trim，不以 `- ` 开头的行与空条目一律丢弃。
 * 是 `renderListSection` 的逆操作，只在块已判为合法列表节后调用。
 */
function parseListSectionItems(block: string): string[] {
  return block
    .split('\n')
    .slice(1)
    .map((line) => (line.startsWith('- ') ? line.slice(2).trim() : ''))
    .filter((item) => item.length > 0)
}

/**
 * 把一段已渲染的工具描述解析回七个分节（渲染的逆操作），供工具空间搜索、精简展示等按节取用。
 * 不是合法结构化描述就返回 null（不做尽力而为的半解析）。解析成功时**每个分节都有值**——
 * 描述里没写的节返回空数组而不是缺席，调用方不必判 undefined；认不出标题的块直接忽略。
 */
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

/**
 * 产出模型面的工具描述文本，幂等：`description` 本身已是合法结构化描述就 trim 后原样返回
 * （不会把它再套一层 `描述：`），否则把它当作正文、连同各分节一起渲染成结构化描述。
 * `categoryId` 只出现在入参类型里、不参与渲染，由调用方在报错与登记时使用。
 */
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

/**
 * 整类工具描述的结构化断言：逐个 trim 描述，**有一个不是完全结构化就抛 `VALIDATION`**
 * （文案点名 `<categoryId>/<name>` 这个工具，并说明该按分节语法写），
 * 全过则返回同形状的新 map、每个工具的 description 换成 trim 过的版本。
 * 这里只校验不改写——自动补结构会把「作者没按语法写」掩盖成看似合规。
 */
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
          `工具 ${categoryId}/${name} 的描述不是完全结构化的：必须按「描述：」「适合：」「禁止：」这套分节语法写，分节之间用空行隔开。这里只校验不自动补结构。`
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
  assertToolDescriptionWithinBudget,
  assertToolDescriptionWithinLimit,
  compactStructuredToolDescription,
  isStructuredParameterDescription,
  isStructuredToolDescription,
  parseStructuredToolDescription,
  renderParameterDescription,
  renderToolDescription,
  renderUsageSkillNote,
  structureToolDescriptionForModel,
  structureToolDescriptionsForCategory,
  ToolDescriptionBudgetChars,
  ToolDescriptionMaxChars,
}
