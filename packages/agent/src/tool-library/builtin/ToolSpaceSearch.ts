// 域：`op:"find"` 的**打分引擎**——把「一句任务短语」变成「哪几张工具页相关、为什么相关」。
// 只负责相关性，不负责取页、不负责分页、不负责决定返回什么：find 的编排在 ToolSpaceQueries。
//
// ## 从哪读起
// 三段，按调用序：
//  1. `buildToolSearchScoreContext` —— 每次 find 先跑一遍，把三类**页外文本**预算成索引：
//     参数 schema 文本、页自身的激活指引文本、以及「谁的激活指引点名了这个工具」的反向文本
//     （反向索引让「怎么启用 X」这类查询能命中 X 本身，而不只命中提到 X 的那张页）。
//  2. `scoreCard` —— 加权子串命中求和，权重表见函数体。
//  3. `buildMatchSignals` —— 同一套命中，换成给模型看的「哪个字段命中了哪些词」。
//
// ## 关键不变量
//  1. **打分与命中信号必须同源**。两者都走 `matchedTermsForField`：给模型的解释若与实际排序
//     用的信号不是同一份，排序就变成不可解释的黑箱。
//  2. 本文件不认识任何具体能力，只有形状与权重。语义中立门（`check:agent-arch` 防线⑤）连注释一起扫。
//
// ## 非显然的妥协
//  - **加权子串命中而非向量检索**：工具页总量是十到百量级，一次 find 要在同一回合内出结果，
//    引入检索模型的延迟与依赖都不划算。权重表（name 32 > id 24 > schema 18 …）是可调旋钮，
//    真正影响召回的是 `ToolSearchTerms` 的同义词/词干/中文 n-gram 扩展。
//  - `collectSchemaSearchText` 的 depth 6 / 240 条上限是防爆保护：深层嵌套 schema 全展开会让
//    单张页的索引文本盖过所有其他页的信号。

import type { ToolCategoryId, ToolOsState } from '@velaros-ai/agent/protocol'
import {
  isArray,
  isBoolean,
  isEmpty,
  isNumber,
  isPlainObject,
  isPresent,
  isString,
} from '@velaros-ai/core'

import type { KernelToolContext as ToolContext } from '../KernelToolContext'

import { readToolInputSchema } from './ToolReadDetails'
import { matchedTermsForField, splitIdentifierSearchTerm } from './ToolSearchTerms'
import {
  buildToolActivationGuide,
  type ToolActivationGuide,
  type ToolActivationRef,
  type ToolAvailability,
  type ToolDiscoveryCard,
  type ToolDiscoveryKind,
  type ToolDiscoveryRisk,
  type ToolNextAction,
  type ToolSchemaPolicy,
  type ToolSchemaState,
} from './ToolSpaceActivation'

export const ToolFindLowConfidenceScoreRatio = 0.3

export interface ToolSearchResultEntry {
  id: string
  kind: ToolDiscoveryKind
  name: string
  categoryId: ToolCategoryId
  summary: string
  usageSkillId: Nullable<string>
  score: number
  availability: ToolAvailability
  toolOsState: ToolOsState
  risk: ToolDiscoveryRisk
  schemaState: ToolSchemaState
  schemaPolicy: ToolSchemaPolicy
  nextAction: ToolNextAction
  resident: boolean
  activation: Pick<ToolActivationRef, 'method' | 'pageIn' | 'capabilityId' | 'nextTool'>
  matchedFields: Array<ToolMatchSignal['field']>
}

export interface ToolMatchSignal {
  field:
    | 'id'
    | 'name'
    | 'category'
    | 'aliases'
    | 'search_hints'
    | 'summary'
    | 'description'
    | 'suitable'
    | 'forbidden'
    | 'schema'
    | 'activation'
    | 'reverse_activation'
  terms: string[]
}

interface ToolSearchScoreContext {
  schemaTextById: ReadonlyMap<string, string>
  activationTextById: ReadonlyMap<string, string>
  reverseActivationTextByName: ReadonlyMap<string, string>
}

function scoreField(value: string, terms: readonly string[], weight: number): number {
  return matchedTermsForField(value, terms).length * weight
}

export function scoreCard(
  card: ToolDiscoveryCard,
  terms: readonly string[],
  context: ToolSearchScoreContext
): number {
  if (isEmpty(terms)) return 0

  const aliasText = card.aliases.join(' ')
  const searchHintText = card.searchHints.join(' ')
  const suitableText = card.suitable.join(' ')
  const forbiddenText = card.forbidden.join(' ')
  return (
    scoreField(card.id, terms, 24) +
    scoreField(card.name, terms, 32) +
    scoreField(card.categoryId, terms, 16) +
    scoreField(aliasText, terms, 20) +
    scoreField(searchHintText, terms, 14) +
    scoreField(card.summary, terms, 10) +
    scoreField(card.description ?? '', terms, 8) +
    scoreField(suitableText, terms, 6) +
    scoreField(forbiddenText, terms, 2) +
    scoreField(context.schemaTextById.get(card.id) ?? '', terms, 18) +
    scoreField(context.activationTextById.get(card.id) ?? '', terms, 8) +
    scoreField(context.reverseActivationTextByName.get(card.name) ?? '', terms, 18)
  )
}

function buildMatchSignal(
  field: ToolMatchSignal['field'],
  value: string,
  terms: readonly string[]
): Nullable<ToolMatchSignal> {
  const matchedTerms = [...new Set(matchedTermsForField(value, terms))].slice(0, 8)
  if (isEmpty(matchedTerms)) return null
  return {
    field,
    terms: matchedTerms,
  }
}

export function buildMatchSignals(
  card: ToolDiscoveryCard,
  terms: readonly string[],
  context: ToolSearchScoreContext
): ToolMatchSignal[] {
  const signals = [
    buildMatchSignal('id', card.id, terms),
    buildMatchSignal('name', card.name, terms),
    buildMatchSignal('category', card.categoryId, terms),
    buildMatchSignal('aliases', card.aliases.join(' '), terms),
    buildMatchSignal('search_hints', card.searchHints.join(' '), terms),
    buildMatchSignal('summary', card.summary, terms),
    buildMatchSignal('description', card.description ?? '', terms),
    buildMatchSignal('suitable', card.suitable.join(' '), terms),
    buildMatchSignal('forbidden', card.forbidden.join(' '), terms),
    buildMatchSignal('schema', context.schemaTextById.get(card.id) ?? '', terms),
    buildMatchSignal('activation', context.activationTextById.get(card.id) ?? '', terms),
    buildMatchSignal(
      'reverse_activation',
      context.reverseActivationTextByName.get(card.name) ?? '',
      terms
    ),
  ]

  return signals.filter(isPresent)
}

function collectSchemaSearchText(value: unknown, output: string[], depth = 0): void {
  if (depth > 6 || output.length > 240) return
  if (isString(value)) {
    output.push(value)
    output.push(...splitIdentifierSearchTerm(value))
    return
  }
  if (isNumber(value) || isBoolean(value)) {
    output.push(String(value))
    return
  }
  if (isArray(value)) {
    for (const item of value) {
      collectSchemaSearchText(item, output, depth + 1)
    }
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, item] of Object.entries(value)) {
    output.push(key)
    output.push(...splitIdentifierSearchTerm(key))
    collectSchemaSearchText(item, output, depth + 1)
  }
}

function schemaSearchText(
  resolvedSchema: Nullable<{ profileId: string; description: string; schema: unknown }>
): string {
  if (!resolvedSchema) return ''
  const pieces = [resolvedSchema.profileId, resolvedSchema.description]
  collectSchemaSearchText(resolvedSchema.schema, pieces)
  return pieces.join(' ')
}

function activationSearchText(activation: ToolActivationGuide): string {
  return [
    activation.method,
    activation.summary,
    activation.capabilityId,
    activation.nextTool,
    ...activation.pageIn,
    ...activation.notes,
    ...activation.activationFlow,
    ...activation.dependencies.flatMap((dependency) => [
      dependency.id,
      dependency.kind,
      dependency.state,
      dependency.summary,
      dependency.pageId,
      dependency.nextTool,
      dependency.activationHint,
      ...dependency.pageIn,
      ...dependency.reasonKeys,
    ]),
  ]
    .filter((value): value is string => isString(value))
    .join(' ')
}

export function buildToolSearchScoreContext(
  ctx: ToolContext,
  cards: readonly ToolDiscoveryCard[]
): ToolSearchScoreContext {
  const schemaTextById = new Map<string, string>()
  const activationTextById = new Map<string, string>()
  const reverseActivationTextByName = new Map<string, string[]>()

  for (const card of cards) {
    schemaTextById.set(card.id, schemaSearchText(readToolInputSchema(ctx, card)))

    const activation = buildToolActivationGuide(card)
    const activationText = activationSearchText(activation)
    activationTextById.set(card.id, activationText)

    for (const dependency of activation.dependencies) {
      const nextToolNames = [
        dependency.nextTool,
        ...dependency.pageIn
          .filter((pageId) => pageId.startsWith('tool:'))
          .map((pageId) => pageId.slice('tool:'.length)),
      ].filter((toolName): toolName is string => isString(toolName))

      for (const nextToolName of nextToolNames) {
        const existing = reverseActivationTextByName.get(nextToolName) ?? []
        existing.push(activationText)
        reverseActivationTextByName.set(nextToolName, existing)
      }
    }
  }

  return {
    schemaTextById,
    activationTextById,
    reverseActivationTextByName: new Map(
      [...reverseActivationTextByName.entries()].map(([toolName, texts]) => [
        toolName,
        [...new Set(texts)].join(' '),
      ])
    ),
  }
}
