import type { ModelMessage } from 'ai'

import { isArray, isBlank, isPresent,isRecord, isString, Log, toOptional } from '@velaros-ai/core'

import { readVerbatimString } from './providerRequest/messageScan'
import {
  type ContextWorkingSetBlock,
  type ContextWorkingSetBlockLifecycle,
  type ContextWorkingSetBlockProvenance,
  type ContextWorkingSetBlockSafety,
  estimateBlockChars,
  estimateBlockTokens,
  hasFailureSignal,
} from './ContextLedger'
import {
  type ContextWorkingSetZoneId,
  DefaultContextWorkingSetZonePolicies,
} from './ContextWorkingSetZones'
import { isStatefulToolResultName } from './StatefulToolResults'

export interface ContextWorkingSetRetrievalHandleInput {
  id: string
  summary: string
  estimatedChars?: number
  payloadRef?: string
  stale?: boolean
}

export interface ContextActiveTaskInput {
  id?: LooseOptional<string>
  title?: LooseOptional<string>
  summary?: LooseOptional<string>
  state?: LooseOptional<string>
  latestFailure?: LooseOptional<string>
  updatedAt?: LooseOptional<number>
  metadata?: LooseOptional<Record<string, unknown>>
}

export interface ContextPinnedEvidenceInput {
  id: string
  kind?: LooseOptional<'evidence' | 'user-constraint'>
  content: string
  summary?: LooseOptional<string>
  source?: LooseOptional<string>
  payloadRef?: LooseOptional<string>
  filePath?: LooseOptional<string>
  contentHash?: LooseOptional<string>
  resourceRevision?: LooseOptional<string>
  recoverable?: LooseOptional<boolean>
  stale?: LooseOptional<boolean>
  verified?: LooseOptional<boolean>
}

export interface ContextResourceItemStateInput {
  path: string
  hash?: LooseOptional<string>
  revision?: LooseOptional<string>
  mtimeMs?: LooseOptional<number>
}

export interface ContextResourceStateInput {
  revision?: LooseOptional<string>
  files?: readonly ContextResourceItemStateInput[]
}

export interface ClassifyContextWorkingSetInput {
  systemPrompt: string
  messages: ModelMessage[]
  toolSchemaChars?: Record<string, number>
  retrievalHandles?: ContextWorkingSetRetrievalHandleInput[]
  activeTask?: LooseOptional<ContextActiveTaskInput>
  pinnedEvidence?: readonly ContextPinnedEvidenceInput[]
  resourceState?: LooseOptional<ContextResourceStateInput>
}

export interface ClassifiedContextWorkingSet {
  blocks: ContextWorkingSetBlock[]
}

function createBlock(
  id: string,
  zone: ContextWorkingSetZoneId,
  content: unknown,
  reclaim: ContextWorkingSetBlock['reclaim'],
  metadata: {
    contentText?: string
    provenance?: ContextWorkingSetBlockProvenance
    lifecycle?: Partial<ContextWorkingSetBlockLifecycle>
    safety?: Partial<ContextWorkingSetBlockSafety>
    payloadRef?: string
    stale?: boolean
  } = {}
): ContextWorkingSetBlock {
  const contentText = metadata.contentText ?? extractBlockText(content)
  const chars = estimateBlockChars(content)
  const lifecycle = buildLifecycle(metadata.lifecycle)
  return {
    id,
    zone,
    priority: DefaultContextWorkingSetZonePolicies[zone].priority,
    chars,
    estimatedTokens: estimateBlockTokens(chars),
    contentText,
    provenance: metadata.provenance,
    lifecycle,
    safety: buildSafety(metadata.safety),
    payloadRef: metadata.payloadRef,
    stale: metadata.stale ?? lifecycle.stale,
    reclaim,
    content,
  }
}

function resolveMessageZone(message: ModelMessage): ContextWorkingSetZoneId {
  return message.role === 'tool' ? 'tool-payloads' : 'recent-turns'
}

function resolveMessageReclaim(message: ModelMessage): ContextWorkingSetBlock['reclaim'] {
  return message.role === 'tool' ? 'reference' : 'summarize'
}

function buildLifecycle(input: Partial<ContextWorkingSetBlockLifecycle> = {}): ContextWorkingSetBlockLifecycle {
  return {
    pinned: !!input.pinned,
    activeTask: !!input.activeTask,
    consumed: !!input.consumed,
    verified: !!input.verified,
    stale: !!input.stale,
    expired: !!input.expired,
    recoverable: !!input.recoverable,
  }
}

function buildSafety(input: Partial<ContextWorkingSetBlockSafety> = {}): ContextWorkingSetBlockSafety {
  return {
    containsUserInstruction: !!input.containsUserInstruction,
    containsPermissionDecision: !!input.containsPermissionDecision,
    containsFailureCause: !!input.containsFailureCause,
    containsUntrustedContent: !!input.containsUntrustedContent,
    requiresExactQuote: !!input.requiresExactQuote,
    statefulToolResult: !!input.statefulToolResult,
    containsSecret: !!input.containsSecret,
  }
}

function extractBlockText(value: unknown): string {
  if (isString(value)) return value
  if (isArray(value)) return value.map(extractBlockText).filter(Boolean).join('\n')
  if (!isRecord(value)) return ''

  const directText = [readVerbatimString(value.text), readVerbatimString(value.value)]
    .filter(Boolean)
    .join('\n')
  if (!isBlank(directText)) return directText

  try {
    return JSON.stringify(value) ?? ''
  } catch (error) {
    Log.tag('ContextWorkingSetOS').debug('序列化上下文块文本失败，回退到字符串表示', { error: String(error) })
    return String(value)
  }
}

function extractToolResultMetadata(message: ModelMessage): {
  toolCallId: Nullable<string>
  toolName: Nullable<string>
  containsFailureCause: boolean
  statefulToolResult: boolean
} {
  if (message.role !== 'tool' || !isArray(message.content)) return {
      toolCallId: null,
      toolName: null,
      containsFailureCause: false,
      statefulToolResult: false,
    }

  let toolCallId: Nullable<string> = null
  let toolName: Nullable<string> = null
  let containsFailureCause = false
  let statefulToolResult = false

  for (const part of message.content as unknown[]) {
    if (!isRecord(part) || part.type !== 'tool-result') continue
    const partToolName = readVerbatimString(part.toolName)
    toolCallId ??= readVerbatimString(part.toolCallId)
    toolName ??= partToolName
    const output = part.output
    if (isRecord(output) && output.type === 'error-text') containsFailureCause = true
    if (partToolName && isStatefulToolResultName(partToolName)) statefulToolResult = true
  }

  return {
    toolCallId,
    toolName,
    containsFailureCause,
    statefulToolResult,
  }
}

function buildMessageBlock(message: ModelMessage, index: number): ContextWorkingSetBlock {
  const contentText = extractBlockText(message.content)
  const toolMetadata = extractToolResultMetadata(message)
  const containsFailureCause =
    toolMetadata.containsFailureCause || hasFailureSignal(contentText)

  return createBlock(
    `message:${index}`,
    resolveMessageZone(message),
    message,
    resolveMessageReclaim(message),
    {
      contentText,
      provenance: {
        source: message.role === 'tool' ? 'tool-result' : 'message',
        messageIndex: index,
        toolCallId: toOptional(toolMetadata.toolCallId),
        toolName: toOptional(toolMetadata.toolName),
      },
      lifecycle: {
        recoverable: message.role === 'tool',
      },
      safety: {
        containsUserInstruction: message.role === 'user',
        containsFailureCause,
        requiresExactQuote: containsFailureCause,
        statefulToolResult: toolMetadata.statefulToolResult,
      },
    }
  )
}

function buildDiagnosticBlock(messageBlock: ContextWorkingSetBlock): Nullable<ContextWorkingSetBlock> {
  if (!messageBlock.safety?.containsFailureCause) return null
  if (messageBlock.provenance?.source !== 'tool-result') return null

  return createBlock(
    `diagnostic:${messageBlock.id}`,
    'diagnostics',
    {
      sourceBlockId: messageBlock.id,
      summary: messageBlock.contentText,
      provenance: messageBlock.provenance,
    },
    'evict',
    {
      contentText: messageBlock.contentText,
      provenance: {
        source: 'diagnostics',
        messageIndex: messageBlock.provenance?.messageIndex,
        toolCallId: messageBlock.provenance?.toolCallId,
        toolName: messageBlock.provenance?.toolName,
      },
      lifecycle: {
        recoverable: false,
      },
      safety: {
        containsFailureCause: true,
        requiresExactQuote: true,
        statefulToolResult: messageBlock.safety.statefulToolResult,
      },
    }
  )
}

function normalizeBlockIdPart(value: string): string {
  const normalized = value.trim().replace(/[^\w.-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return normalized || 'unnamed'
}

function activeTaskText(input: ContextActiveTaskInput): string {
  return [
    input.title ? `title: ${input.title}` : null,
    input.state ? `state: ${input.state}` : null,
    input.summary ? `summary: ${input.summary}` : null,
    input.latestFailure ? `latestFailure: ${input.latestFailure}` : null,
  ].filter(isPresent).join('\n')
}

function buildActiveTaskBlock(activeTask: ContextActiveTaskInput): ContextWorkingSetBlock {
  const id = normalizeBlockIdPart(activeTask.id?.trim() || activeTask.title?.trim() || 'current')
  const contentText = activeTaskText(activeTask)

  return createBlock(
    `active-task:${id}`,
    'active-task',
    {
      ...activeTask,
      summary: activeTask.summary,
      latestFailure: activeTask.latestFailure,
    },
    'keep',
    {
      contentText,
      provenance: {
        source: 'active-task',
      },
      lifecycle: {
        activeTask: true,
        pinned: true,
        recoverable: false,
      },
      safety: {
        containsFailureCause: Boolean(activeTask.latestFailure),
        requiresExactQuote: Boolean(activeTask.latestFailure),
      },
    }
  )
}

function buildPinnedEvidenceBlock(
  evidence: ContextPinnedEvidenceInput,
  resourceState?: LooseOptional<ContextResourceStateInput>
): ContextWorkingSetBlock {
  const kind = evidence.kind ?? 'evidence'
  const id = normalizeBlockIdPart(evidence.id)
  const contentText = [evidence.summary, evidence.content].filter(isPresent).join('\n')
  const stale =
    !!evidence.stale ||
    Boolean(
      evidence.filePath &&
        evidence.contentHash &&
        resourceState?.files?.some(
          (file) => file.path === evidence.filePath && file.hash && file.hash !== evidence.contentHash
        )
    ) ||
    Boolean(
      evidence.resourceRevision &&
        resourceState?.revision &&
        resourceState.revision !== evidence.resourceRevision
    )

  return createBlock(
    `pinned-evidence:${id}`,
    'pinned-evidence',
    {
      ...evidence,
      stale,
    },
    evidence.payloadRef ? 'reference' : 'summarize',
    {
      contentText,
      payloadRef: toOptional(evidence.payloadRef),
      stale,
      provenance: {
        source: kind === 'user-constraint' ? 'user-constraint' : 'pinned-evidence',
        payloadRef: toOptional(evidence.payloadRef),
        filePath: toOptional(evidence.filePath),
        contentHash: toOptional(evidence.contentHash),
        resourceRevision: toOptional(evidence.resourceRevision),
      },
      lifecycle: {
        pinned: true,
        verified: !!evidence.verified,
        stale,
        expired: stale,
        recoverable: evidence.recoverable ?? Boolean(evidence.payloadRef),
      },
      safety: {
        containsUserInstruction: kind === 'user-constraint',
        requiresExactQuote: kind === 'user-constraint',
      },
    }
  )
}

export class ContextWorkingSetOS {
  public classify(input: ClassifyContextWorkingSetInput): ClassifiedContextWorkingSet {
    const blocks: ContextWorkingSetBlock[] = [
      createBlock('system', 'kernel', input.systemPrompt, 'keep', {
        provenance: { source: 'system' },
        lifecycle: { activeTask: true },
      }),
    ]

    if (input.activeTask) blocks.push(buildActiveTaskBlock(input.activeTask))

    for (const evidence of input.pinnedEvidence ?? []) {
      blocks.push(buildPinnedEvidenceBlock(evidence, input.resourceState))
    }

    input.messages.forEach((message, index) => {
      const messageBlock = buildMessageBlock(message, index)
      blocks.push(messageBlock)
      const diagnosticBlock = buildDiagnosticBlock(messageBlock)
      if (diagnosticBlock) blocks.push(diagnosticBlock)
    })

    Object.entries(input.toolSchemaChars ?? {}).forEach(([toolName, chars]) => {
      blocks.push({
        id: `tool-schema:${toolName}`,
        zone: 'tool-schemas',
        priority: DefaultContextWorkingSetZonePolicies['tool-schemas'].priority,
        chars: Math.max(0, chars),
        estimatedTokens: estimateBlockTokens(chars),
        contentText: `${toolName} ${chars}`,
        provenance: { source: 'tool-schema' },
        lifecycle: buildLifecycle(),
        safety: buildSafety(),
        reclaim: 'page-out',
        content: { toolName, chars },
      })
    })

    for (const handle of input.retrievalHandles ?? []) {
      const chars = handle.estimatedChars ?? estimateBlockChars(handle.summary)
      blocks.push({
        id: `retrieval:${handle.id}`,
        zone: 'retrieval-index',
        priority: DefaultContextWorkingSetZonePolicies['retrieval-index'].priority,
        chars: Math.max(0, chars),
        estimatedTokens: estimateBlockTokens(chars),
        contentText: handle.summary,
        provenance: {
          source: 'retrieval',
          payloadRef: handle.payloadRef,
        },
        lifecycle: buildLifecycle({
          stale: !!handle.stale,
          expired: !!handle.stale,
          recoverable: Boolean(handle.payloadRef),
        }),
        safety: buildSafety(),
        payloadRef: handle.payloadRef,
        stale: handle.stale,
        reclaim: 'evict',
        content: handle,
      })
    }

    return { blocks }
  }
}
