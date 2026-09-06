import { isString, Log } from '@velaros-ai/core'

import type {
  ContextWorkingSetReclaimAction,
  ContextWorkingSetZoneId,
} from './ContextWorkingSetZones'

export type ContextWorkingSetBlockSource = string

export interface ContextWorkingSetBlockProvenance {
  source: ContextWorkingSetBlockSource
  messageIndex?: number
  toolCallId?: string
  toolName?: string
  payloadRef?: string
  filePath?: string
  resourceRevision?: string
  contentHash?: string
}

export interface ContextWorkingSetBlockLifecycle {
  pinned: boolean
  activeTask: boolean
  consumed: boolean
  verified: boolean
  stale: boolean
  expired: boolean
  recoverable: boolean
}

export interface ContextWorkingSetBlockSafety {
  containsUserInstruction: boolean
  containsPermissionDecision: boolean
  containsFailureCause: boolean
  containsUntrustedContent: boolean
  requiresExactQuote: boolean
  statefulToolResult: boolean
  containsSecret: boolean
}

export interface ContextWorkingSetBlock {
  id: string
  zone: ContextWorkingSetZoneId
  priority: number
  chars: number
  estimatedTokens: number
  contentText?: string
  provenance?: ContextWorkingSetBlockProvenance
  lifecycle?: ContextWorkingSetBlockLifecycle
  safety?: ContextWorkingSetBlockSafety
  payloadRef?: string
  embedding?: number[]
  hash?: string
  stale?: boolean
  reclaim: ContextWorkingSetReclaimAction
  content: unknown
}

export interface ContextLedgerEntry {
  id: string
  zone: ContextWorkingSetZoneId
  chars: number
  estimatedTokens: number
  action: 'inline' | 'reference' | 'dedupe-reference' | 'summary' | 'drop'
  reason: string
  toolCallId?: string
  toolName?: string
  hash?: string
  ref?: string
  zoneReservedTokens?: number
  zoneLimitTokens?: number
  zoneEffectiveLimitTokens?: number
  zoneUsedTokens?: number
  zoneOverBudgetTokens?: number
}

/**
 * 块文本失败信号判定：safety.containsFailureCause（ContextWorkingSetOS 分类）与
 * toolFailureReason 特征（ContextAttentionPolicyEngine 打分）共用的单源正则。
 */
export function hasFailureSignal(contentText: string): boolean {
  for (const line of contentText.split('\n')) {
    const start = line.trimStart().toLowerCase()
    if (start.startsWith('error:') || start.startsWith('fatal:')) return true
  }
  return /\b(failed|failure|exception|stderr|exit code|timeout|denied)\b/iu.test(contentText)
}

export function estimateBlockChars(value: unknown): number {
  if (isString(value)) return value.length

  try {
    return JSON.stringify(value)?.length ?? String(value).length
  } catch (error) {
    Log.tag('ContextLedger').warn('estimateBlockChars JSON.stringify failed, using string length fallback', { error })
    return String(value).length
  }
}

export function estimateBlockTokens(chars: number): number {
  return Math.max(1, Math.ceil(Math.max(0, chars) / 4))
}
