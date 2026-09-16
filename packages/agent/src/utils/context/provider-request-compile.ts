import type { ModelMessage } from 'ai'

import { isArray, isEmpty, isNotNull, isPlainObject, isString } from '@velaros-ai/core'

import type { CompileProviderRequestInput, ContextGovernanceRuler, EstimateContextUsageOptions, ProviderHistoryRewriteSignal } from '../../types/context.js'
import type { ContextGovernanceSessionApi } from '../../types/residency.js'
import type { ContextProjectionStats, GovernanceEpochReport, GovernanceWindowDerivation } from '../../types/residency.js'
import { markLatestUserMessagePromptCacheBreakpoint } from '../model/prompt-cache'
import { DefaultResidencyCharsPerToken } from '../residency/context-record'
import { buildContextDashboardMessage } from '../residency/dashboard'
import { estimateMessageBudgetChars } from '../residency/message-facts'
import { rewriteCanonicalToolReferences } from '../tools/tool-identity'

import { resolveToolSchemaReserve } from './budget-stage'
import { estimateContextUsage } from './context-usage'

export const MaxHistoryCharsPerToken = 8

export /** 密度的合法区间：极端 tokenizer / 异常样本也不得把治理器推到无穷敏感或完全失明。 */
const MinHistoryCharsPerToken = 0.25

/**
 * 发送面传输装饰：prompt-cache 断点。
 *
 * "只对最新那条 user 消息生效、下一轮就换位"的回合本地改写，所以必须在账本投影之后贴。
 * 位置与它过去在 `compileProviderSendRequest` 里的位置一致（活动尾拼接之前），provider
 * 收到的字节不变。
 */
export function applySendTransportDecorations(
  messages: ModelMessage[],
  input: CompileProviderRequestInput
): ModelMessage[] {
  if (!input.applySendTransportDecorations) return messages

  return markLatestUserMessagePromptCacheBreakpoint(messages)
}

/**
 * 本轮治理量纲：历史密度与硬保留上下文各自实测，再合入同一份固定开销。
 *
 * 密度：驻留账本以正文字符记账，而字符与 token 的比值随语言、结构化载荷、分词器大幅变化。
 * 固定按 4 折算会把中文与结构化数据密集的长会话低估数倍，治理 epoch 于是在模型已被旧轨迹
 * 淹没之后仍不触发。这里复用出核预算的同一把分词尺与校准系数把它量出来。
 *
 * 固定开销：送核门还计算系统提示词、工具清单、稳定前缀、活动尾和保留上下文；账本只管
 * 历史正文。治理窗口必须先扣除这些已知开销，才能先于发送门触发回收。
 */
export function measureGovernanceRuler(
  input: CompileProviderRequestInput,
  messages: readonly ModelMessage[],
  stablePrefix: readonly ModelMessage[],
  retainedMessages: readonly ModelMessage[]
): ContextGovernanceRuler {
  const estimateOptions = input.contextUsageOptions ?? {}
  const bodyChars = sumMessageChars(messages)
  const reserve = resolveToolSchemaReserve(input)
  const charsPerToken =
    bodyChars > 0
      ? resolveMeasuredCharsPerToken(input, messages, bodyChars, estimateOptions)
      : DefaultResidencyCharsPerToken

  const fixed = estimateContextUsage(
    input.model,
    rewriteCanonicalToolReferences(input.systemPrompt, input.toolNameAliases ?? {}),
    [...stablePrefix, ...(input.tailBlocks ?? []), ...retainedMessages],
    {
      extraContext: estimateOptions.extraContext,
      extraEstimatedChars: reserve.extraEstimatedChars,
      extraEstimatedTokens: reserve.extraEstimatedTokens,
      calibrationFactor: input.calibrationFactor ?? estimateOptions.calibrationFactor,
    }
  )
  return { charsPerToken, fixedOverheadTokens: fixed.estimatedTokens }

}

/**
 * 实测本轮历史的「字符 / token」密度：拿同一把分词尺与校准系数对这批消息估一次 token，再用正文字符数去除。
 * 估出 0 token（消息为空等）时回落到 DefaultResidencyCharsPerToken；结果夹在 MinHistoryCharsPerToken 与 MaxHistoryCharsPerToken 之间，
 * 免得极端 tokenizer 或异常样本把治理器推到无穷敏感或彻底失明。
 * 必须实测而不能固定按 4 折算——中文与结构化载荷会被固定口径低估数倍，治理 epoch 就会等到模型已被旧轨迹淹没才触发。
 */
export function resolveMeasuredCharsPerToken(
  input: CompileProviderRequestInput,
  messages: readonly ModelMessage[],
  bodyChars: number,
  estimateOptions: EstimateContextUsageOptions
): number {
  const estimate = estimateContextUsage(input.model, '', [...messages], {
    contextWindow: input.contextWindow ?? estimateOptions.contextWindow,
    calibrationFactor: input.calibrationFactor ?? estimateOptions.calibrationFactor,
  })
  if (estimate.estimatedTokens <= 0) return DefaultResidencyCharsPerToken

  return Math.min(
    MaxHistoryCharsPerToken,
    Math.max(MinHistoryCharsPerToken, bodyChars / estimate.estimatedTokens)
  )
}

/**
 * 把一批消息的预算字符数加总，逐条走 `estimateMessageBudgetChars`（账本口径，只算正文，不含系统提示词与工具清单那些固定开销）。
 * 这个和是密度实测的分母，也是治理窗口里「历史正文占了多少」的基准。
 */
export function sumMessageChars(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageBudgetChars(message), 0)
}

/**
 * 把历史消息里的 canonical 工具名改写成本次请求的 provider 传输别名：
 * tool-call / tool-result 片段换 `toolName`，text 片段与字符串型 content 按完整 token 改写其中的工具引用。
 * user 消息整条跳过——用户原话不是编译产物，改了会让持久历史与界面显示跟着变味。
 * 别名表为空时直接返回浅拷；没有任何改动的消息返回原对象引用，只有真改了才产生新对象（省掉无谓的结构变更与缓存失效）。
 * 这层只作用于发往 provider 的那一份，映射不回写注册表、权限策略或持久历史。
 */
export function rewriteProviderToolNames(
  messages: readonly ModelMessage[],
  aliases: Readonly<Record<string, string>>
): ModelMessage[] {
  if (isEmpty(Object.keys(aliases))) return [...messages]

  return messages.map((message) => {
    if (message.role === 'user') return message

    if (isString(message.content)) {
      const content = rewriteCanonicalToolReferences(message.content, aliases)
      return content === message.content ? message : ({ ...message, content } as ModelMessage)
    }
    if (!isArray(message.content)) return message

    let changed = false
    const content = message.content.map((part) => {
      if (!isPlainObject(part)) return part
      const record = part as { type?: unknown; toolName?: unknown; text?: unknown }
      let next: Record<string, unknown> = part
      if (
        (record.type === 'tool-call' || record.type === 'tool-result') &&
        isString(record.toolName)
      ) {
        const providerName = aliases[record.toolName]
        if (providerName && providerName !== record.toolName) {
          next = { ...next, toolName: providerName }
          changed = true
        }
      }
      if (record.type === 'text' && isString(record.text)) {
        const text = rewriteCanonicalToolReferences(record.text, aliases)
        if (text !== record.text) {
          next = { ...next, text }
          changed = true
        }
      }
      return next as typeof part
    })
    return changed ? ({ ...message, content } as ModelMessage) : message
  })
}

/**
 * 切出稳定前缀：开头**连续**的 system 消息。
 *
 * 只认开头那一段是有依据的——provider 侧本来也只接受开头连续的 system 段（被 user/assistant
 * 隔开的第二段 system 会被直接拒），所以"开头连续的 system 消息"与"稳定前缀"在结构上同义。
 */
export function partitionStablePrefix(messages: readonly ModelMessage[]): {
  stablePrefix: ModelMessage[]
  body: ModelMessage[]
} {
  let index = 0
  while (index < messages.length && messages[index].role === 'system') index += 1

  return { stablePrefix: messages.slice(0, index), body: messages.slice(index) }
}

/**
 * 治理改写签名。
 *
 * 只有 epoch 真正应用了迁移才算"历史被改写"——`ledgerFingerprint` 是账本段的内容指纹，进签名
 * 后前缀漂移一眼可判（缓存回归的探针）。未触发 epoch 的轮次不产签名，指纹保持为 undefined，
 * 与切换前"没有任何 stage 改写历史"的语义一致。
 */
export function buildGovernanceRewriteSignals(
  report: Nullable<GovernanceEpochReport>,
  ledgerFingerprint: string
): ProviderHistoryRewriteSignal[] {
  if (!report?.applied) return []

  return [
    {
      kind: 'governance-epoch',
      details: {
        epoch: report.epoch,
        trigger: report.trigger,
        migrationCount: report.migrationCount,
        byInstrument: report.byInstrument,
        savedTokens: report.savedTokens,
        ledgerFingerprint,
      },
    },
  ]
}

/**
 * 拼这次请求的活动尾：调用方自带的尾块打底，治理会话开了 dashboard 就再追加一条上下文仪表盘消息。
 *
 * 仪表盘里的「上一次治理尝试」只认**当前这一代账本**的报告——账本重建后的代际不同，
 * 拿旧代的报告去说明现状会把人和模型一起带偏。生成不出仪表盘（没数据）时只返回打底的那些尾块。
 */
export function buildProviderRequestTailBlocks(
  input: CompileProviderRequestInput,
  governance: {
    session: ContextGovernanceSessionApi
    window: GovernanceWindowDerivation
  },
  stats: ContextProjectionStats
): ModelMessage[] {
  const blocks = [...(input.tailBlocks ?? [])]
  if (!governance.session.config.dashboard) return blocks

  const ledger = governance.session.ledger
  const lastEpochAttempt = governance.session
    .epochReports()
    .findLast((report) =>
      isNotNull(report.trigger) && report.ledgerGeneration === governance.session.generation
    )
  const dashboard = buildContextDashboardMessage({
    epoch: governance.session.epoch,
    stats: ledger.stats(),
    records: ledger.list(),
    residency: ledger.residencyVector(),
    projectedTokens: stats.projectedTokens,
    budgetTokens: governance.window.windowTokens,
    lastEpochAttempt,
  })
  if (dashboard) blocks.push(dashboard)
  return blocks
}
