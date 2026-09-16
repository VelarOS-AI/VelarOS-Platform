import type { ModelMessage } from 'ai'

import { isArray, isObject, isString } from '@velaros-ai/core'

import type { AgentRuntimeCapabilityPorts } from '../../contract/requires.js'
import type { CapabilityIntentClassifierContext, CapabilityIntentSignal } from '../../types/capabilities.js'
import type { AgentIntentDomainSignal, AgentIntentSignals } from '../../types/loop.js'
import { resolveCapabilityIntentClassifiers } from '../capabilities'
import { stripTurnContextBlocks } from '../runner/turn-context-format'

const GreetingOnlyPattern =
  /^(你好|您好|嗨|哈喽|hello|hi|hey|早上好|晚上好|下午好)[!！。.\s]*$/i
const ContinuationOnlyPattern =
  /^(继续|继续吧|继续一下|接着|接着来|往下|往下做|go on|continue|keep going)[!！。.\s]*$/i
const CapabilityUncertaintyPattern =
  /(不确定.*(怎么|如何|工具|能力|处理|做)|不知道.*(怎么|如何|工具|能力|处理|做)|需要哪个工具|用什么工具|哪些工具|复杂(任务|问题|场景)|uncertain|not\s+sure|which\s+tool|what\s+tool|complex\s+(task|problem|issue))/i

/**
 * 把用户这句话里的连续空白（含换行、制表）压成单个空格再去掉首尾。
 * 本文件几条判据都是整串匹配的正则，不压平的话一个多余换行就能让「你好」逃过低信号判定。
 */
function normalizeIntentText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 从一条消息的内容里抽出纯文本：字符串内容直接去空白；数组内容只收 `type === 'text'` 的分片、
 * 逐行拼接，图片、文件、工具调用等非文本分片一律丢弃。整条都没有文本时返回空串。
 */
function extractTextFromMessageContent(content: ModelMessage['content']): string {
  if (isString(content)) return content.trim()
  if (!isArray(content)) return ''
  return content
    .map((part) => {
      if (!part || !isObject(part)) return ''
      const record = part as { type?: unknown; text?: unknown }
      return record.type === 'text' && isString(record.text) ? record.text.trim() : ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * 从后往前找最近一条「剥掉回合上下文块之后仍有正文」的 user 消息，返回那段真正由用户写下的话；
 * 一条都找不到（或都被剥空）返回 `null`。
 *
 * 剥 `stripTurnContextBlocks` 是关键：宿主每轮注入的环境快照也以 user role 传输，不剥的话
 * 会被当成「用户又说了一大段」，意图分类、低信号判定、工具分配器全被这段机器文本带偏。
 */
function extractLatestUserTextFromMessages(
  messages: readonly ModelMessage[]
): Nullable<string> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = stripTurnContextBlocks(extractTextFromMessageContent(message.content))
    if (text) return text
  }
  return null
}

/**
 * 判定这句话「不含可用于规划的新意图」：空串，或整句只是打招呼（你好 / hi …），
 * 或整句只是让继续（继续 / go on …）。注意是整句匹配，「继续把登录页改完」不算低信号。
 *
 * 为真的轮次不做工具空间侦察、也不跑工具分配器：这类话里没有可据以换工具面的信息，
 * 按它换只会白烧一轮；为假才进意图分类。
 */
function isLowSignalIntentText(text: string): boolean {
  const normalized = normalizeIntentText(text)
  return (
    !normalized ||
    GreetingOnlyPattern.test(normalized) ||
    ContinuationOnlyPattern.test(normalized)
  )
}

/**
 * 把各能力分类器吐出的意图信号按 domainId 归并成一域一条：categories 取并集去重，四个 `requires*`
 * 标志按或合并（任一分类器要求即要求）。分类器彼此独立、常常同时命中同一个域，不归并的话下游会
 * 按同一个域重复换入类别、重复判复杂度。输出顺序即各域首次出现的顺序。
 */
function mergeIntentSignals(signals: readonly CapabilityIntentSignal[]): AgentIntentDomainSignal[] {
  const byDomain = new Map<string, AgentIntentDomainSignal>()
  for (const signal of signals) {
    const current = byDomain.get(signal.domainId) ?? {
      id: signal.domainId,
      categories: [],
      requiresDiscovery: false,
      requiresEvidence: false,
      requiresMutation: false,
      requiresValidation: false,
    }
    current.categories = [...new Set([...current.categories, ...(signal.categoryIds ?? [])])]
    current.requiresDiscovery ||= !!signal.requiresDiscovery
    current.requiresEvidence ||= !!signal.requiresEvidence
    current.requiresMutation ||= !!signal.requiresMutation
    current.requiresValidation ||= !!signal.requiresValidation
    byDomain.set(signal.domainId, current)
  }
  return [...byDomain.values()]
}

/**
 * 跑遍能力端口注册的全部意图分类器，把结果归并成本轮的意图信号：域清单加三个 `requires*` 汇总标志。
 * 另外单独测一次「能力不确定」句式（不知道用哪个工具 / 复杂任务 …），命中而分类器又没给出 `unknown`
 * 域时，补一条 `requiresDiscovery` 的 `unknown` 域——这就是后面强制先调 `tooling:map` 的触发口。
 * 没有分类器或全不命中时域清单为空，调用方据此走「不干预」。
 */
function detectAgentIntentSignals(
  text: string,
  ports?: AgentRuntimeCapabilityPorts,
  context?: CapabilityIntentClassifierContext
): AgentIntentSignals {
  const classified = resolveCapabilityIntentClassifiers(ports)
    .flatMap((classifier) => [...classifier.classify(text, context)])
  const domains = mergeIntentSignals(classified)
  const hasCapabilityUncertainty = CapabilityUncertaintyPattern.test(text)
  if (hasCapabilityUncertainty && !domains.some((domain) => domain.id === 'unknown')) {
    domains.push({
      id: 'unknown',
      categories: [],
      requiresDiscovery: true,
      requiresEvidence: false,
      requiresMutation: false,
      requiresValidation: false,
    })
  }
  return {
    domains,
    requiresEvidence: domains.some((domain) => domain.requiresEvidence),
    requiresMutation: domains.some((domain) => domain.requiresMutation),
    requiresValidation: domains.some((domain) => domain.requiresValidation),
    hasCapabilityUncertainty,
  }
}

export {
  detectAgentIntentSignals,
  extractLatestUserTextFromMessages,
  extractTextFromMessageContent,
  isLowSignalIntentText,
  normalizeIntentText,
}
