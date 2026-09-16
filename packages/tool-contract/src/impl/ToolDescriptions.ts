/**
 * 模型面说明的渲染、判定、解析、压缩与两道长度闸，外加各空间共用的约束句。
 * 接口 `ToolDescriptionsApi` 在本文件的类上方；整个进程一份 `toolDescriptions`。
 */

import { isBlank } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { GlobalToolConcepts } from '../contract/constants.js'
import type {
  StructuredParameterDescriptionSpec,
  StructuredToolDescriptionParts,
  StructuredToolDescriptionSpec,
  ToolCategoryId,
  ToolConceptRegistry,
  ToolDescriptionBudgetWaiver,
  ToolDescriptionBudgetWaiverReason,
  ToolDescriptionLike,
} from '../types/tool-contract.js'
import {
  compactStructuredDescription,
  DescriptionSectionPrefix,
  isStructuredDescription,
  normalizeDescriptionText,
  ParameterDescriptionGrammar,
  parseListSectionItems,
  renderListSection,
  ToolDescriptionGrammar,
} from '../utils/description-syntax.js'
import { ToolContractTuning } from '../utils/tuning.js'

/**
 * 工具与参数说明的唯一渲染与判定处，实例是 `toolDescriptions`。
 *
 * 渲染与判定共用一套分节语法（描述 / 适合 / 禁止 / 强制流程 / 用法 / 示例 / 注意，参数说明只有四节），
 * 顺序、必填节与「没给就不渲染」都是语法的一部分；两道长度闸只在说明被写下来的那一刻拦，
 * 因为模型面说明从不压缩——`适合`、`禁止` 是行为约束，压掉等于删规则。
 */
export interface ToolDescriptionsApi {
  /** 单个工具说明的开发期硬上限（字符）：保底闸，不是预算；撞线基本等于这个工具该拆。 */
  readonly maxChars: number
  /** 单个工具说明的软预算（字符）：复杂用法属于技能文书，不该每轮随工具清单进上下文。 */
  readonly budgetChars: number
  /** 按七节语法渲染一段工具说明：描述压成单行，没给的分节整节不出现。 */
  renderTool(spec: StructuredToolDescriptionSpec): string
  /** 按四节语法渲染单个参数的说明；参数的合法取值与边界写进「取值」，模型才看得见。 */
  renderParameter(spec: StructuredParameterDescriptionSpec): string
  /** 声明了 companion skill 时追加到说明末尾的那一行指路（进「注意」分节的最后一条）。 */
  renderUsageSkillNote(usageSkillId: string): string
  /** 这段工具说明是不是完全结构化的（七节语法，`适合` 必填）。 */
  isToolDescription(description: string): boolean
  /** 这段参数说明是不是完全结构化的（四节语法，没有必填分节）。 */
  isParameterDescription(description: string): boolean
  /** 把一段已渲染的工具说明解析回七个分节；不是合法结构化说明时返回 null。 */
  parseTool(description: string): Nullable<StructuredToolDescriptionParts>
  /** 工具说明的精简版：`强制流程：` 完整保留，其余分节各留首条；非结构化输入原样返回。 */
  compactTool(description: string): string
  /** 产出模型面的工具说明文本，幂等：已是合法结构化说明就 trim 后原样返回。 */
  forModel(input: StructuredToolDescriptionSpec & { categoryId: ToolCategoryId }): string
  /** 整类工具说明的结构化断言：有一个不是完全结构化就抛 VALIDATION；只校验不改写。 */
  forCategory<TTool extends ToolDescriptionLike, TMap extends Record<string, TTool>>(
    tools: TMap,
    categoryId: ToolCategoryId
  ): TMap
  /** 硬上限闸：超过 `maxChars` 就抛 VALIDATION，不可豁免。 */
  assertWithinLimit(name: string, description: string): void
  /** 软预算闸：超过 `budgetChars` 就抛 VALIDATION；带合法豁免时跳过长度判定。 */
  assertWithinBudget(name: string, description: string, waiver?: ToolDescriptionBudgetWaiver): void
  /** 取一句各空间共用的约束句；概念 id 写错是编译期错误，不是运行期 undefined。 */
  concept<TId extends keyof typeof GlobalToolConcepts>(id: TId): (typeof GlobalToolConcepts)[TId]
  /** 登记一张本空间自己的概念表；运行期原样返回，唯一作用是让 TS 推出字面量 key 类型。 */
  defineConcepts<TConcepts extends ToolConceptRegistry>(concepts: TConcepts): TConcepts
  /** 基于一张概念表造一个取值函数：id 必须是表里登记过的 key，写错在编译期就报错。 */
  conceptLookup<TConcepts extends ToolConceptRegistry>(
    concepts: TConcepts
  ): <TId extends keyof TConcepts & string>(id: TId) => TConcepts[TId]
}

class ToolDescriptions implements ToolDescriptionsApi {
  /** 软预算豁免只认这两种理由；加第三种之前先改判决。 */
  private static readonly BudgetWaiverReasons: ReadonlySet<string> = new Set<
    ToolDescriptionBudgetWaiverReason
  >(['safety-protocol', 'meta-tool'])

  /** 工具说明的精简版保留这一节：强制流程是防损坏的门禁，压掉等于删约束。 */
  private static readonly KeepInFullSection = '强制流程：'

  public readonly maxChars: number = ToolContractTuning.description.maxChars

  public readonly budgetChars: number = ToolContractTuning.description.budgetChars

  public renderTool(spec: StructuredToolDescriptionSpec): string {
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

  public renderParameter(spec: StructuredParameterDescriptionSpec): string {
    const description = normalizeDescriptionText(spec.description)
    const sections = [
      `${DescriptionSectionPrefix}${description}`,
      spec.values ? renderListSection('取值', spec.values) : null,
      spec.usage ? renderListSection('用法', spec.usage) : null,
      spec.notes ? renderListSection('注意', spec.notes) : null,
    ].filter((section): section is string => Boolean(section))

    return sections.join('\n\n')
  }

  public renderUsageSkillNote(usageSkillId: string): string {
    return `深度用法：当前技能目录可读取 skill:${usageSkillId} 时先读该技能。`
  }

  public isToolDescription(description: string): boolean {
    return isStructuredDescription(description, ToolDescriptionGrammar)
  }

  public isParameterDescription(description: string): boolean {
    return isStructuredDescription(description, ParameterDescriptionGrammar)
  }

  public parseTool(description: string): Nullable<StructuredToolDescriptionParts> {
    const trimmed = description.trim()
    if (!this.isToolDescription(trimmed)) return null

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

  public compactTool(description: string): string {
    return compactStructuredDescription(
      description,
      (value) => this.isToolDescription(value),
      ToolDescriptions.KeepInFullSection
    )
  }

  public forModel(input: StructuredToolDescriptionSpec & { categoryId: ToolCategoryId }): string {
    const trimmed = input.description.trim()
    if (this.isToolDescription(trimmed)) return trimmed

    return this.renderTool({
      description: trimmed,
      suitable: input.suitable,
      forbidden: input.forbidden,
      usage: input.usage,
      examples: input.examples,
      protocol: input.protocol,
      notes: input.notes,
    })
  }

  public forCategory<TTool extends ToolDescriptionLike, TMap extends Record<string, TTool>>(
    tools: TMap,
    categoryId: ToolCategoryId
  ): TMap {
    return Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => {
        const description = tool.description.trim()
        if (!this.isToolDescription(description)) {
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

  public assertWithinLimit(name: string, description: string): void {
    if (description.length <= this.maxChars) return

    throw new AppError(
      'VALIDATION',
      `工具 ${name} 的描述有 ${description.length} 字符，超过 ${this.maxChars} 字符的硬上限；这基本等于这个工具该拆了，请拆分工具，或把细节移出模型面描述（挪进 tooling:read 的按需正文）。`
    )
  }

  public assertWithinBudget(
    name: string,
    description: string,
    waiver?: ToolDescriptionBudgetWaiver
  ): void {
    if (waiver) {
      if (!ToolDescriptions.BudgetWaiverReasons.has(waiver.reason)) {
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

    if (description.length <= this.budgetChars) return

    throw new AppError(
      'VALIDATION',
      `工具 ${name} 的描述有 ${description.length} 字符，超过 ${this.budgetChars} 字符的软预算；出路只有两条：把工艺细节搬进配套技能（在契约里声明 usageSkillId 指路），或声明 descriptionBudgetWaiver 并给出 safety-protocol / meta-tool 之一的理由。不要靠压缩描述过关。`
    )
  }

  public concept<TId extends keyof typeof GlobalToolConcepts>(
    id: TId
  ): (typeof GlobalToolConcepts)[TId] {
    return GlobalToolConcepts[id]
  }

  public defineConcepts<TConcepts extends ToolConceptRegistry>(concepts: TConcepts): TConcepts {
    return concepts
  }

  public conceptLookup<TConcepts extends ToolConceptRegistry>(
    concepts: TConcepts
  ): <TId extends keyof TConcepts & string>(id: TId) => TConcepts[TId] {
    return <TId extends keyof TConcepts & string>(id: TId): TConcepts[TId] => concepts[id]
  }
}

/** 整个进程只有一份的工具说明渲染与判定处。 */
export const toolDescriptions: ToolDescriptionsApi = new ToolDescriptions()
