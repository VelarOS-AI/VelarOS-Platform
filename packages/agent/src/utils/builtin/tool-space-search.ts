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

import {
  isArray,
  isBoolean,
  isEmpty,
  isNumber,
  isPlainObject,
  isPresent,
  isString,
} from '@velaros-ai/core'

import type { ToolActivationGuide, ToolDiscoveryCard, ToolMatchSignal, ToolSearchScoreContext } from '../../types/builtin.js'
import type { KernelToolContext as ToolContext } from '../../types/tool-context.js'
import { parseStructuredToolDescription } from '../toolkit/tool-description'

import { readToolInputSchema } from './tool-read-details'
import { matchedTermsForField, splitIdentifierSearchTerm } from './tool-search-terms'
import { buildToolActivationGuide } from './tool-space-activation'

export const ToolFindLowConfidenceScoreRatio = 0.3

/**
 * 单字段得分 = 该字段命中的候选词**条数** × 字段权重。一个词在字段里出现多次只算一条，
 * 所以长字段不会因为重复词刷分；字段值为空或一词不中时得 0。
 */
function scoreField(value: string, terms: readonly string[], weight: number): number {
  return matchedTermsForField(value, terms).length * weight
}

/** 禁止项描述的是能力边界，仍保留在工具页中，但不能作为可执行能力的推荐依据。 */
function positiveDescriptionText(description: string): string {
  const parts = parseStructuredToolDescription(description)
  return parts
    ? [
        parts.description,
        ...parts.suitable,
        ...parts.protocol,
        ...parts.usage,
        ...parts.examples,
        ...parts.notes,
      ].join(' ')
    : description
}

/**
 * 给一张工具页打相关性总分：十一个字段的加权命中之和，权重
 * name 32 > id 24 ≈ schema 18 ≈ 反向激活指引 18 > aliases 20 > categoryId 16 > searchHints 14 >
 * summary 10 > description 8 ≈ activation 8 > suitable 6。
 * 候选词为空时直接返回 0（不打分、不排序）。description 只取**正向**部分参与打分——
 * `禁止` 分节描述的是能力边界，拿它当推荐依据会把「不能做 X 的工具」推给想做 X 的模型。
 * schema/激活/反向激活三路文本来自预算好的 `context`，不在这里现算。
 */
export function scoreCard(
  card: ToolDiscoveryCard,
  terms: readonly string[],
  context: ToolSearchScoreContext
): number {
  if (isEmpty(terms)) return 0

  const aliasText = card.aliases.join(' ')
  const searchHintText = card.searchHints.join(' ')
  const suitableText = card.suitable.join(' ')
  return (
    scoreField(card.id, terms, 24) +
    scoreField(card.name, terms, 32) +
    scoreField(card.categoryId, terms, 16) +
    scoreField(aliasText, terms, 20) +
    scoreField(searchHintText, terms, 14) +
    scoreField(card.summary, terms, 10) +
    scoreField(positiveDescriptionText(card.description ?? ''), terms, 8) +
    scoreField(suitableText, terms, 6) +
    scoreField(context.schemaTextById.get(card.id) ?? '', terms, 18) +
    scoreField(context.activationTextById.get(card.id) ?? '', terms, 8) +
    scoreField(context.reverseActivationTextByName.get(card.name) ?? '', terms, 18)
  )
}

/**
 * 造一条「某字段命中了哪些词」的信号：命中词去重后**最多留 8 个**（够解释为什么排这么前，
 * 再多只是刷屏）。一个都没中返回 null，由调用方滤掉——不产出空信号，免得模型以为该字段匹配了。
 */
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

/**
 * 把这张页的命中情况翻成给模型看的解释：与 `scoreCard` **逐字段一一对应**的十一路信号，
 * 一个字段一条，没命中的字段整条不出现。两者共用 `matchedTermsForField` 是硬不变量——
 * 给模型的解释若和实际排序用的信号不同源，排序就成了不可解释的黑箱。
 */
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
    buildMatchSignal('description', positiveDescriptionText(card.description ?? ''), terms),
    buildMatchSignal('suitable', card.suitable.join(' '), terms),
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

/**
 * 深度遍历参数 schema，把可检索的文本片段推进 `output`（就地累加，不返回值）：字符串与对象键
 * 各自额外拆一遍标识符（`maxBytes` → max + bytes），数字与布尔转成字符串。
 * 两道防爆闸：**depth > 6 或已收满 240 片就停**——深层嵌套 schema 全展开会让单张页的索引文本
 * 盖过所有其他页的信号，被截掉的深层字段就不参与召回了。
 */
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

/**
 * 把一份已解析的工具参数 schema 摊成一行可检索文本：profileId + 描述的**正向部分** +
 * schema 本体遍历出的片段，空格连接。解析不出 schema（工具没声明或当前 surface 取不到）时返回空串，
 * 该字段就不参与打分。
 */
function schemaSearchText(
  resolvedSchema: Nullable<{ profileId: string; description: string; schema: unknown }>
): string {
  if (!resolvedSchema) return ''
  const pieces = [resolvedSchema.profileId, positiveDescriptionText(resolvedSchema.description)]
  collectSchemaSearchText(resolvedSchema.schema, pieces)
  return pieces.join(' ')
}

/**
 * 把一份激活指引摊成一行可检索文本：method、summary、capabilityId、nextTool、pageIn、notes、
 * activationFlow，以及每个依赖项的 id/kind/state/summary/pageId/nextTool/activationHint/pageIn/reasonKeys。
 * 非字符串项（可选字段缺席）一律滤掉后空格连接，所以缺字段不会留下 `undefined` 字样。
 */
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

/**
 * 每次 find 先跑一遍，把三类**页外文本**预算成索引，避免逐张页现算：
 * `schemaTextById`（参数 schema 文本）、`activationTextById`（页自身的激活指引文本），
 * 以及 `reverseActivationTextByName` —— **反向**索引：谁的激活指引点名了工具 X（从依赖的
 * `nextTool` 与 `tool:` 前缀的 pageIn 里取工具名），就把那份指引文本挂到 X 名下（去重后合并）。
 * 有了它，「怎么启用 X」这类查询能命中 X 本身，而不只命中提到 X 的那张页。
 * 反向索引按**工具名**索引、另两张按**页 id** 索引，取用时别弄反。
 */
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
