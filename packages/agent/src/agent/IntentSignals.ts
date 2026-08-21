import type { ModelMessage } from 'ai'

import { stripTurnContextBlocks } from '@velaros-ai/agent'
import type { ToolCategoryId } from '@velaros-ai/agent/protocol'
import { isArray, isObject, isString } from '@velaros-ai/core'

import {
  type AgentRuntimeCapabilityPorts,
  type CapabilityIntentClassifierContext,
  type CapabilityIntentSignal,
  resolveCapabilityIntentClassifiers,
} from '../capabilities'

const GreetingOnlyPattern =
  /^(你好|您好|嗨|哈喽|hello|hi|hey|早上好|晚上好|下午好)[!！。.\s]*$/i
const ContinuationOnlyPattern =
  /^(继续|继续吧|继续一下|接着|接着来|往下|往下做|go on|continue|keep going)[!！。.\s]*$/i
const CapabilityUncertaintyPattern =
  /(不确定.*(怎么|如何|工具|能力|处理|做)|不知道.*(怎么|如何|工具|能力|处理|做)|需要哪个工具|用什么工具|哪些工具|复杂(任务|问题|场景)|uncertain|not\s+sure|which\s+tool|what\s+tool|complex\s+(task|problem|issue))/i

export type AgentIntentSignalDomain = string

export interface AgentIntentDomainSignal {
  id: AgentIntentSignalDomain
  categories: ToolCategoryId[]
  requiresDiscovery: boolean
  requiresEvidence: boolean
  requiresMutation: boolean
  requiresValidation: boolean
}

export interface AgentIntentSignals {
  domains: AgentIntentDomainSignal[]
  requiresEvidence: boolean
  requiresMutation: boolean
  requiresValidation: boolean
  hasCapabilityUncertainty: boolean
}

function normalizeIntentText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

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

function isLowSignalIntentText(text: string): boolean {
  const normalized = normalizeIntentText(text)
  return (
    !normalized ||
    GreetingOnlyPattern.test(normalized) ||
    ContinuationOnlyPattern.test(normalized)
  )
}

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
