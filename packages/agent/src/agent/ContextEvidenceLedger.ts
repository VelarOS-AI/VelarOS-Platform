import type { ModelMessage } from 'ai'

import type {
  ChatCompactContextCapabilityTruth,
  ChatContextEvidenceRecord,
  StreamToolResultEffects,
} from '@velaros-ai/agent/protocol'
import { isEmpty, isString, toNullable } from '@velaros-ai/core'
import { readStringScalar } from '@velaros-ai/core/utils/unknownJsonRecord'

import {
  type AgentRuntimeCapabilityPorts,
  resolveCapabilityEvidenceExtractors,
} from '../capabilities'

import {
  CompactionSummaryMarker,
  PinnedEvidenceInstruction,
  PinnedEvidenceMarker,
} from './history/contextOSMessage'

const MaxCompactionEvidenceRecords = 24
const MaxSummaryChars = 220
const MaxCompactionEvidenceExcerptChars = 900
const MaxCompactionEvidenceInlineChars = 14_000

interface ExtractToolEvidenceInput {
  toolCallId: string
  toolName: string
  args?: Record<string, unknown>
  result: unknown
  error?: string
  effects?: StreamToolResultEffects
  capabilityPorts?: AgentRuntimeCapabilityPorts
}

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim()
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars).trimEnd()}...` : trimmed
}

function normalizeEvidencePath(value: LooseOptional<string>): LooseOptional<string> {
  const normalized = value?.replace(/\\/g, '/').trim()
  return normalized ? normalized : null
}

function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, '')
}

function createPathLookup(values: Iterable<string>): {
  exact: Set<string>
  withoutLeadingSlash: Set<string>
} {
  const exact = new Set<string>()
  const withoutLeadingSlash = new Set<string>()
  for (const value of values) {
    const normalized = normalizeEvidencePath(value)
    if (!normalized) {
      continue
    }

    exact.add(normalized)
    withoutLeadingSlash.add(stripLeadingSlash(normalized))
  }

  return { exact, withoutLeadingSlash }
}

function createRevisionLookup(
  revisionByPath: Readonly<Record<string, string>>
): Map<string, string> {
  const lookup = new Map<string, string>()
  for (const [rawPath, revision] of Object.entries(revisionByPath)) {
    const normalized = normalizeEvidencePath(rawPath)
    if (!normalized || !revision.trim()) {
      continue
    }

    lookup.set(normalized, revision)
    lookup.set(stripLeadingSlash(normalized), revision)
  }

  return lookup
}

/** 维护模型运行中的证据账本，负责抽取、筛选和注入关键上下文证据。 */
class ContextEvidenceLedger {
  /** 从工具调用结果中抽取可持久化的上下文证据记录。 */
  public extractToolEvidence(input: ExtractToolEvidenceInput): ChatContextEvidenceRecord[] {
    return resolveCapabilityEvidenceExtractors(input.capabilityPorts).flatMap((extractor) => [
      ...extractor.extract(input),
    ])
  }

  /** 为上下文压缩挑选仍需保留的高价值证据记录。 */
  public selectCompactionEvidence(
    records: ChatContextEvidenceRecord[]
  ): ChatContextEvidenceRecord[] {
    const selected: ChatContextEvidenceRecord[] = []
    const seen = new Set<string>()

    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]
      if (!record || !this.shouldRetainEvidence(record)) {
        continue
      }

      const key = [
        record.kind,
        record.path ?? record.toolCallId,
        record.revision ?? record.contentHash ?? record.id,
      ].join(':')
      if (seen.has(key)) {
        continue
      }

      seen.add(key)
      selected.push(this.normalizeCompactionEvidence(record))
      if (selected.length >= MaxCompactionEvidenceRecords) {
        break
      }
    }

    return selected.reverse()
  }

  /** 根据能力提供方的当前事实标记已经过期、需要重新读取的证据。 */
  public reconcileEvidenceFreshness(
    records: ChatContextEvidenceRecord[],
    capabilityTruth?: LooseOptional<ChatCompactContextCapabilityTruth>
  ): ChatContextEvidenceRecord[] {
    if (!capabilityTruth) return records

    const revisionLookup = createRevisionLookup(capabilityTruth.revisionsByResource)
    const externalTouches = createPathLookup(capabilityTruth.externallyTouchedResourceIds)
    if (!revisionLookup.size && !externalTouches.exact.size) return records

    return records.map((record) => {
      if (record.kind !== 'file-read') return record

      const path = normalizeEvidencePath(record.path)
      if (!path) return record

      const pathWithoutLeadingSlash = stripLeadingSlash(path)
      const externallyTouched =
        externalTouches.exact.has(path) ||
        externalTouches.withoutLeadingSlash.has(pathWithoutLeadingSlash)
      const currentRevision =
        revisionLookup.get(path) ?? revisionLookup.get(pathWithoutLeadingSlash)
      const obsoleteRevision = readStringScalar(record.revision)
      const revisionAdvanced =
        !!obsoleteRevision && !!currentRevision && obsoleteRevision !== currentRevision
      if (!externallyTouched && !revisionAdvanced) return record

      const reason = externallyTouched
        ? 'external-filesystem-change'
        : 'capability-resource-revision-advanced'
      const current = externallyTouched ? 'external-filesystem-change' : currentRevision
      return {
        ...record,
        lifecycle: 'reread-required',
        freshness: 'stale',
        excerpt: null,
        summary: truncate(
          `Reread required ${path}${obsoleteRevision ? ` @ ${obsoleteRevision}` : ''}${
            current ? ` -> ${current}` : ''
          }`,
          MaxSummaryChars
        ),
        metadata: {
          ...(record.metadata ?? {}),
          stale: true,
          staleReason: reason,
          previousLifecycle: record.lifecycle,
          obsoleteRevision,
          currentRevision: toNullable(current),
        },
      }
    })
  }

  /** 把固定证据注入模型消息历史，确保压缩后仍能保留关键运行事实。 */
  public injectPinnedEvidenceMessage(
    history: ModelMessage[],
    evidenceLedger: ChatContextEvidenceRecord[]
  ): ModelMessage[] {
    const evidenceText = this.buildPinnedEvidenceText(evidenceLedger)
    if (!evidenceText) return history

    const firstMessage = history[0]
    if (
      firstMessage?.role === 'assistant' &&
      isString(firstMessage.content) &&
      firstMessage.content.includes(CompactionSummaryMarker)
    ) return [
        {
          ...firstMessage,
          content: `${firstMessage.content}\n\n${evidenceText}`,
        },
        ...history.slice(1),
      ]

    return [
      {
        role: 'assistant',
        content: evidenceText,
      },
      ...history,
    ]
  }

  private shouldRetainEvidence(record: ChatContextEvidenceRecord): boolean {
    if (record.lifecycle === 'consumed' || record.lifecycle === 'demoted') return false

    if (record.importance === 'pinned' || record.importance === 'high') return true

    return record.lifecycle === 'pinned' || record.lifecycle === 'active'
  }

  private normalizeCompactionEvidence(
    record: ChatContextEvidenceRecord
  ): ChatContextEvidenceRecord {
    const stale = record.lifecycle === 'stale' || record.lifecycle === 'reread-required'
    return {
      ...record,
      lifecycle: stale ? 'reread-required' : record.lifecycle,
      freshness: stale ? 'stale' : (record.freshness ?? 'fresh'),
      excerpt: stale
        ? null
        : record.excerpt
          ? truncate(record.excerpt, MaxCompactionEvidenceExcerptChars)
          : null,
      metadata: {
        ...(record.metadata ?? {}),
        compactionRetained: true,
        stale,
      },
    }
  }

  private buildPinnedEvidenceText(
    evidenceLedger: ChatContextEvidenceRecord[]
  ): LooseOptional<string> {
    if (isEmpty(evidenceLedger)) return null

    const lines = [PinnedEvidenceMarker, PinnedEvidenceInstruction]
    let inlineChars = lines.join('\n').length

    for (const record of evidenceLedger) {
      const headerParts = [
        // id 必须渲染:context:recall(ref=evidence id) 要求模型引用它,不给看等于让模型猜句柄(铁律1)。
        `id=${record.id}`,
        record.kind,
        record.importance,
        record.lifecycle,
        record.path ? `path=${record.path}` : null,
        record.revision ? `rev=${record.revision}` : null,
      ].filter((item): item is string => Boolean(item))
      const summary = `- ${headerParts.join(' | ')}: ${record.summary}`
      const excerpt = record.excerpt
        ? `\n  excerpt:\n${this.indentEvidenceExcerpt(record.excerpt)}`
        : ''
      const entry = `${summary}${excerpt}`
      if (inlineChars + entry.length > MaxCompactionEvidenceInlineChars) {
        lines.push('- 证据内联预算已用尽；剩余证据仍保留在账本中，后续可按需检索。')
        break
      }

      lines.push(entry)
      inlineChars += entry.length
    }

    return lines.join('\n')
  }

  private indentEvidenceExcerpt(value: string): string {
    return truncate(value, MaxCompactionEvidenceExcerptChars)
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n')
  }
}

const contextEvidenceLedger = new ContextEvidenceLedger()

export { ContextEvidenceLedger, contextEvidenceLedger }
export type { ExtractToolEvidenceInput }
